import { test, expect } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { version, parse, managed, release, abi, platform, type Release } from "./updates";
import { releaseVersion } from "./build_config";
const keys = () => generateKeyPairSync("ed25519");
const key = (k: ReturnType<typeof keys>) =>
  Buffer.from(k.publicKey.export({ type: "spki", format: "der" }))
    .subarray(-32)
    .toString("hex");
const rel = (public_key: string): Release => ({
  version: "1.2.3",
  commit: "abc",
  feed_url: "https://example.invalid",
  public_key,
  test_mode: false,
});
function signedManifest(signer: ReturnType<typeof keys>, schema: number, url: string) {
  const target = { url, sha256: "0".repeat(64), size: 1 },
    payload = JSON.stringify({
      schema_version: schema,
      version: "1.2.4",
      commit: "abc",
      update_abi: abi,
      targets: { "macos-aarch64": target, "linux-x86_64": target, "linux-aarch64": target },
    });
  return JSON.stringify({ payload, signature: sign(null, Buffer.from(payload), signer.privateKey).toString("hex") });
}
test("release versions cannot escape installation paths", () => {
  for (const value of ["../../bin", "1.0.0-beta"]) expect(() => version(value)).toThrow("InvalidReleaseVersion");
  expect(version("1.2.3")[1]).toBe(2);
});
test("timestamp releases sort by UTC date and time", () => {
  const first = version("20260925T003012Z-abcdef012345"),
    second = version("20260925T003013Z-123456abcdef");
  expect(first[0]).toBe(second[0]);
  expect(first[1]).toBeLessThan(second[1]);
  expect(() => version("20260925T003012Z-../../abcdef")).toThrow("InvalidReleaseVersion");
});
test("manifests verify against the release's key", () => {
  const signer = keys(),
    r = rel(key(signer)),
    bytes = signedManifest(signer, 1, "https://example.invalid/corgi");
  expect(parse(r, bytes).version).toBe("1.2.4");
  expect(() => parse(rel(key(keys())), bytes)).toThrow("SignatureVerificationFailed");
  expect(() => parse(rel(""), bytes)).toThrow("BadUpdateSignature");
  expect(() => parse(r, signedManifest(signer, 2, "https://example.invalid/corgi"))).toThrow("UnknownUpdateSchema");
});
test("signed manifests require every typed field, and this platform's target", () => {
  const signer = keys(),
    r = rel(key(signer));
  const original = JSON.parse(JSON.parse(signedManifest(signer, 1, "https://example.invalid/corgi")).payload);
  const encode = (value: any) => {
    const payload = JSON.stringify(value);
    return JSON.stringify({ payload, signature: sign(null, Buffer.from(payload), signer.privateKey).toString("hex") });
  };
  for (const field of ["commit", "update_abi", "version", "targets"]) {
    const value = structuredClone(original);
    delete value[field];
    expect(() => parse(r, encode(value))).toThrow("MissingField");
  }
  for (const field of ["commit", "update_abi"]) {
    const value = structuredClone(original);
    value[field] = 3;
    expect(() => parse(r, encode(value))).toThrow("UnexpectedToken");
  }
  for (const name of ["macos-aarch64", "linux-x86_64", "linux-aarch64"]) {
    const value = structuredClone(original);
    value.targets[name].url = null;
    expect(() => parse(r, encode(value))).toThrow("UnexpectedToken");
    delete value.targets[name];
    if (name === platform) expect(() => parse(r, encode(value))).toThrow("MissingField");
    else expect(parse(r, encode(value)).version).toBe("1.2.4");
  }
  expect(() => parse(r, encode({ ...original, targets: { ...original.targets, "plan9-mips": {} } }))).toThrow(
    "UnknownField",
  );
  expect(() => parse(r, encode({ ...original, extra: true }))).toThrow("UnknownField");
});
test("local http targets need test mode", () => {
  const signer = keys(),
    r = rel(key(signer)),
    local = signedManifest(signer, 1, "http://127.0.0.1:9/corgi");
  expect(() => parse(r, local)).toThrow("InsecureUpdateURL");
  r.test_mode = true;
  expect(parse(r, local).version).toBe("1.2.4");
  expect(() => parse(r, signedManifest(signer, 1, "http://example.invalid/corgi"))).toThrow("InsecureUpdateURL");
});
test("only an installed release with a feed is managed", () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-managed-")),
    exe = join(root, "releases/1.2.3/corgi"),
    r = rel("0".repeat(64));
  try {
    expect(managed(r, exe)).toBeNull();
    writeFileSync(join(root, "current"), "1.2.3");
    expect(managed(r, exe)).toBe(root);
    for (const change of [{ version: "1.2.4" }, { feed_url: "" }, { public_key: "" }])
      expect(managed({ ...r, ...change }, exe)).toBeNull();
    expect(managed(r, join(root, "1.2.3/corgi"))).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("only test builds take their release from the path and environment", () => {
  const original = process.env.CORGI_TEST_UPDATE_KEY;
  try {
    process.env.CORGI_TEST_UPDATE_KEY = "f".repeat(64);
    expect(release("/tmp/x/releases/9.9.9/corgi").version).toBe("9.9.9");
    expect(release("/tmp/x/releases/9.9.9/corgi").public_key).toBe("f".repeat(64));
    expect(release("/tmp/x/bin/corgi").version).toBe(releaseVersion);
  } finally {
    if (original === undefined) delete process.env.CORGI_TEST_UPDATE_KEY;
    else process.env.CORGI_TEST_UPDATE_KEY = original;
  }
});
