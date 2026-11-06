#!/bin/bash
# Run on the Mac that publishes. Sends its release config, the release and R2
# keys, and the signing certificate to a Linux host that signs with rcodesign.
set -euo pipefail
usage='Usage: send-release-keys.sh [--notary-key AuthKey_KEYID.p8 --issuer ISSUER_ID] [--force]'
[[ $(uname -s) == Darwin ]] || { echo 'Run this on your Mac.' >&2; exit 1; }
host=${CORGI_RELEASE_HOST:-nocap}
config=${CORGI_RELEASE_CONFIG:-$HOME/.config/corgi/release.json}
notary_key='' issuer='' force=0
while [[ $# -gt 0 ]]; do
    case $1 in
        --notary-key) notary_key=${2:?$usage}; shift 2 ;;
        --issuer) issuer=${2:?$usage}; shift 2 ;;
        --force) force=1; shift ;;
        *) echo "$usage" >&2; exit 1 ;;
    esac
done
[[ -z $notary_key && -z $issuer ]] || [[ -n $notary_key && -n $issuer ]] ||
    { echo '--notary-key and --issuer go together.' >&2; exit 1; }
[[ -z $notary_key || -f $notary_key ]] || { echo "No notary key at $notary_key." >&2; exit 1; }
[[ -f $config ]] || { echo "No release config at $config." >&2; exit 1; }
command -v uv > /dev/null || { echo 'Install uv first.' >&2; exit 1; }

remote_home=$(ssh "$host" 'echo $HOME')
[[ $remote_home =~ ^/[a-zA-Z0-9_./-]+$ ]] || { echo "Unexpected home on $host: $remote_home" >&2; exit 1; }
if [[ $force == 0 ]] && ssh "$host" 'test -e .config/corgi/release.json'; then
    echo "$host already has ~/.config/corgi/release.json; pass --force to replace it." >&2
    exit 1
fi

stage=$(mktemp -d /tmp/corgi-keys.XXXXXX)
chmod 700 "$stage"
trap 'rm -rf "$stage"' EXIT
mkdir -m 700 "$stage/out"

# The configured identity (a name or SHA-1), else the one Developer ID Application identity.
wanted=$(/usr/bin/plutil -extract codesignIdentity raw -o - "$config" 2> /dev/null || true)
identities=$(/usr/bin/security find-identity -v -p codesigning | grep -E '^ *[0-9]+\) [0-9A-F]{40} "' || true)
if [[ $wanted =~ ^[0-9A-Fa-f]{40}$ ]]; then
    identities=$(grep -i " $wanted " <<< "$identities" || true)
elif [[ -n $wanted && $wanted != - ]]; then
    identities=$(grep -F "\"$wanted\"" <<< "$identities" || true)
else
    identities=$(grep '"Developer ID Application:' <<< "$identities" || true)
    wanted='Developer ID Application'
fi
[[ $(grep -c . <<< "$identities") == 1 ]] ||
    { echo "Expected one $wanted identity, found:" >&2; echo "${identities:-none}" >&2; exit 1; }
[[ -z $notary_key || $identities == *'"Developer ID Application:'* ]] ||
    { echo 'Notarizing needs a Developer ID Application identity.' >&2; exit 1; }
sha1=$(awk '{print $2}' <<< "$identities")
# Export only the keychain holding it; other keychains would ask for their own passwords.
keychain=$(/usr/bin/security list-keychains -d user | sed -E 's/^ *"(.*)"$/\1/' | while read -r path; do
    /usr/bin/security find-identity -v -p codesigning "$path" | grep -q " $sha1 " && { echo "$path"; break; }
done)
[[ -n $keychain ]] || { echo "No keychain in the search list holds $sha1." >&2; exit 1; }
echo "Exporting $(sed -E 's/.*"(.*)".*/\1/' <<< "$identities") from $keychain"
echo 'The keychain asks to allow exporting its private key.'

# `security export` takes every identity in the keychain, and fails on any
# key that can't leave it, so this exports the one identity.
cat > "$stage/export.swift" << 'EOF'
import CryptoKit
import Foundation
import Security

let (sha1, path, out) = (CommandLine.arguments[1].lowercased(), CommandLine.arguments[2], CommandLine.arguments[3])
let password = ProcessInfo.processInfo.environment["CORGI_EXPORT_PASSWORD"]! as CFString
func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(1)
}
var keychain: SecKeychain?
guard SecKeychainOpen(path, &keychain) == errSecSuccess, let keychain else { fail("Cannot open \(path).") }
let query: [CFString: Any] = [
    kSecClass: kSecClassIdentity, kSecMatchSearchList: [keychain], kSecMatchLimit: kSecMatchLimitAll,
    kSecReturnRef: true,
]
var found: CFTypeRef?
guard SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess, let identities = found as? [SecIdentity]
else { fail("No identities in \(path).") }
let identity = identities.first { identity in
    var certificate: SecCertificate?
    guard SecIdentityCopyCertificate(identity, &certificate) == errSecSuccess, let certificate else { return false }
    let digest = Insecure.SHA1.hash(data: SecCertificateCopyData(certificate) as Data)
    return digest.map { String(format: "%02x", $0) }.joined() == sha1
}
guard let identity else { fail("No identity \(sha1) in \(path).") }
var parameters = SecItemImportExportKeyParameters()
parameters.version = UInt32(SEC_KEY_IMPORT_EXPORT_PARAMS_VERSION)
parameters.passphrase = Unmanaged.passUnretained(password)
var data: CFData?
let status = SecItemExport(identity, .formatPKCS12, [], &parameters, &data)
guard status == errSecSuccess, let data else {
    fail("Export failed: \(SecCopyErrorMessageString(status, nil) as String? ?? String(status))")
}
FileManager.default.createFile(atPath: out, contents: data as Data, attributes: [.posixPermissions: 0o600])
EOF
export CORGI_EXPORT_PASSWORD=$(uuidgen)
xcrun swift -suppress-warnings "$stage/export.swift" "$sha1" "$keychain" "$stage/all.p12"
/usr/bin/openssl pkcs12 -in "$stage/all.p12" -nodes -passin env:CORGI_EXPORT_PASSWORD -out "$stage/all.pem" 2> /dev/null

cat > "$stage/prepare.py" << 'EOF'
import json, os, re, secrets, sys
from pathlib import Path
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.serialization import pkcs12

pem, sha1, config_path, out, remote, notary_key, issuer = sys.argv[1:]
out, remote = Path(out), Path(remote)
pems = re.findall(r"(-----BEGIN ([A-Z ]+)-----.*?-----END \2-----)", Path(pem).read_text(), re.S)
certs = [x509.load_pem_x509_certificate(p.encode()) for p, kind in pems if kind == "CERTIFICATE"]
keys = [serialization.load_pem_private_key(p.encode(), None) for p, kind in pems if kind.endswith("PRIVATE KEY")]
cert = next(c for c in certs if c.fingerprint(hashes.SHA1()).hex().upper() == sha1.upper())
public = cert.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
key = next(
    k
    for k in keys
    if k.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    == public
)

def write(name, data):
    path = out / name
    path.write_bytes(data if isinstance(data, bytes) else data.encode())
    os.chmod(path, 0o600)
    return str(remote / name)

# rcodesign reads the legacy PKCS#12 encryption the keychain also writes.
password = secrets.token_urlsafe(32)
encryption = (
    serialization.PrivateFormat.PKCS12.encryption_builder()
    .kdf_rounds(50000)
    .key_cert_algorithm(pkcs12.PBES.PBESv1SHA1And3KeyTripleDESCBC)
    .hmac_hash(hashes.SHA1())
    .build(password.encode())
)
config = json.loads(Path(config_path).read_text())
for field in ("codesignIdentity", "notaryProfile", "macosSdk", "notaryApiKey"):
    config.pop(field, None)
config["codesignP12"] = write(
    "codesign.p12", pkcs12.serialize_key_and_certificates(b"corgi", key, cert, None, encryption)
)
config["codesignP12PasswordFile"] = write("codesign.pass", password)
config["signingKey"] = write("release-key.pem", Path(config["signingKey"]).expanduser().read_bytes())
if os.environ.get("AWS_ACCESS_KEY_ID") and os.environ.get("AWS_SECRET_ACCESS_KEY"):
    credentials = {"accessKeyId": os.environ["AWS_ACCESS_KEY_ID"], "secretAccessKey": os.environ["AWS_SECRET_ACCESS_KEY"]}
    config["credentialsFile"] = write("r2-credentials.json", json.dumps(credentials, indent=2) + "\n")
elif config.get("credentialsFile"):
    config["credentialsFile"] = write("r2-credentials.json", Path(config["credentialsFile"]).expanduser().read_bytes())
else:
    sys.exit("No R2 credentials: set credentialsFile in the config, or AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.")
if notary_key:
    # The JSON rcodesign encode-app-store-connect-api-key writes.
    name = Path(notary_key).stem
    if not name.startswith("AuthKey_"):
        sys.exit("Expected the notary key as Apple names it, AuthKey_KEYID.p8.")
    body = "".join(l for l in Path(notary_key).read_text().splitlines() if not l.startswith("-----"))
    api = {"issuer_id": issuer, "key_id": name.removeprefix("AuthKey_"), "private_key": body}
    config["notaryApiKey"] = write("notary-key.json", json.dumps(api, indent=2) + "\n")
write("release.json", json.dumps(config, indent=2) + "\n")
if config.get("sentry"):
    print("The config uploads to Sentry: run `sentry-cli login` on the Linux host too.")
EOF
uv run -q --no-project --with cryptography python -I "$stage/prepare.py" \
    "$stage/all.pem" "$sha1" "$config" "$stage/out" "$remote_home/.config/corgi" "$notary_key" "$issuer"
rm -f "$stage/all.p12" "$stage/all.pem"

echo "Sending to $host:~/.config/corgi/"
ssh "$host" 'mkdir -p .config && mkdir -p -m 700 .config/corgi'
rsync -a --chmod=D700,F600 "$stage/out/" "$host:.config/corgi/"
analysis=$(ssh "$host" '~/.local/bin/rcodesign analyze-certificate --p12-file ~/.config/corgi/codesign.p12 --p12-password-file ~/.config/corgi/codesign.pass' || true)
grep -q 'Signed by Apple?: *true' <<< "$analysis" ||
    { echo "rcodesign on $host could not read an Apple-issued certificate." >&2; exit 1; }
echo "rcodesign on $host reads the signing certificate."
[[ -n $notary_key ]] || echo 'No --notary-key: releases from Linux will be signed but not notarized.'
echo "On $host: bun run publish --dry-run, then bun run publish"
