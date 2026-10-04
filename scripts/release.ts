#!/usr/bin/env bun
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rm, stat, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";

const repo = resolve(import.meta.dir, "..");
export const targets = [
  { name: "macos-aarch64", zig: "aarch64-macos.13.0" },
  { name: "linux-x86_64", zig: "x86_64-linux-musl" },
] as const;
export const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
export function releaseVersion(value: string) {
  if (/^\d{8}T\d{6}Z-[a-f0-9]{7,40}$/.test(value)) return value;
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw new Error("Version must be UTC datetime + Git hash, or MAJOR.MINOR.PATCH.");
  if (value.split(".").some(n => !Number.isSafeInteger(Number(n)))) throw new Error("Version components are too large.");
  return value;
}
export function timestampVersion(commit: string, date = new Date()) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Expected a full Git commit hash.");
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z") + "-" + commit.slice(0, 12);
}
export function publishedVersion(value: string, commit: string) {
  if (!/^\d{8}T\d{6}Z-[a-f0-9]{12}$/.test(value) || value.slice(17) !== commit.slice(0, 12)) throw new Error("Release version must be UTC datetime + the first 12 characters of HEAD.");
  const iso = `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}T${value.slice(9,11)}:${value.slice(11,13)}:${value.slice(13,15)}.000Z`;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime()) || timestampVersion(commit, date) !== value) throw new Error("Invalid release datetime.");
  return value;
}
export function versionParts(value: string) {
  releaseVersion(value);
  return value.includes("T") ? [Number(value.slice(0, 8)), Number(value.slice(9, 15)), 0] : value.split(".").map(Number);
}
function git(cwd: string, ...args: string[]) {
  const p = Bun.spawnSync(["git", "--no-optional-locks", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode) throw new Error(`Git ${args[0]} failed: ${p.stderr.toString().trim()}`);
  return p.stdout.toString().trim();
}
export function cleanCommit(cwd = repo) {
  if (git(cwd, "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none")) throw new Error("Release checkout is dirty.");
  return git(cwd, "rev-parse", "HEAD");
}
export function releaseOptions(argv: string[]) {
  let version: string | undefined, mode = "";
  for (const arg of argv) {
    if (["--dry-run", "--build-only", "--publish-only"].includes(arg) && !mode) mode = arg;
    else if (!arg.startsWith("--") && !version) version = releaseVersion(arg);
    else throw new Error("Unknown or conflicting option; run --help.");
  }
  if (mode === "--publish-only" && !version) throw new Error("Provide the prepared VERSION with --publish-only.");
  return { version, mode };
}
export function releasePaths(cwd: string) {
  const common = realpathSync(resolve(cwd, git(cwd, "rev-parse", "--git-common-dir")));
  return {
    releases: join(common, "corgi-releases"),
    lock: join(common, "corgi-publish.lock"),
  };
}
export async function releaseCommit(cwd: string, options: ReturnType<typeof releaseOptions>, releases: string) {
  if (options.mode !== "--publish-only") return git(cwd, "rev-parse", "HEAD");
  const prepared = JSON.parse(await readFile(join(releases, options.version!, "prepared.json"), "utf8"));
  if (!/^[a-f0-9]{40}$/.test(prepared.commit) || prepared.version !== options.version) throw new Error("Invalid prepared release source/version.");
  return prepared.commit as string;
}
export async function withReleaseCheckout<T>(cwd: string, commit: string, run: (source: string) => Promise<T>): Promise<T> {
  const base = await realpath(await mkdtemp(join(tmpdir(), "corgi-release-")));
  const source = join(base, "source");
  let added = false;
  try {
    git(cwd, "worktree", "add", "--detach", source, commit);
    added = true;
    return await run(source);
  } finally {
    // Only this disposable checkout is removed, including its build caches.
    if (added) git(cwd, "worktree", "remove", "--force", source);
    await rm(base, { recursive: true, force: true });
  }
}
export function releaseEnvironment(cwd: string, source: string, env = process.env) {
  // Reuse the compiler (not the development build outputs) when it lives in .tools.
  let compiler = env.ZIG;
  if (compiler?.includes("/")) compiler = resolve(cwd, compiler);
  if (!compiler) {
    const zig = Bun.which("zig", { PATH: env.PATH });
    const installed = zig && Bun.spawnSync([zig, "version"], { env, stdout: "pipe", stderr: "pipe" });
    compiler = installed && installed.exitCode === 0 && installed.stdout.toString().trim() === "0.16.0"
      ? "zig" : join(cwd, ".tools/zig-aarch64-macos-0.16.0/zig");
  }
  return { ...env, ZIG: compiler, ZIG_LOCAL_CACHE_DIR: join(source, ".zig-cache") };
}
export function validateBinary(name: string, bytes: Uint8Array) {
  const b = Buffer.from(bytes);
  if (name === "macos-aarch64") {
    if (b.length < 32 || b.readUInt32LE(0) !== 0xfeedfacf || b.readUInt32LE(4) !== 0x0100000c) throw new Error("Expected an arm64 Mach-O binary.");
  } else {
    if (b.length < 64 || b.subarray(0, 4).toString("hex") !== "7f454c46" || b[4] !== 2 || b[5] !== 1 || b.readUInt16LE(18) !== 62) throw new Error("Expected an amd64 ELF binary.");
    const offset = Number(b.readBigUInt64LE(32)), size = b.readUInt16LE(54), count = b.readUInt16LE(56);
    if (size < 56 || offset + size * count > b.length) throw new Error("Malformed ELF program headers.");
    for (let i = 0; i < count; i++) if (b.readUInt32LE(offset + i * size) === 3) throw new Error("Linux release must be static (no dynamic interpreter).");
  }
}
type Config = { publicBaseUrl: string; endpoint: string; region: string; bucket: string; signingKey: string; codesignIdentity: string; credentialsFile?: string; sentry?: SentryConfig };
// Release builds send crash reports to this Sentry project, which gets their debug files.
type SentryConfig = { dsn: string; org: string; project: string };
export async function loadCredentials(config: Pick<Config, "credentialsFile">, env = process.env) {
  let accessKeyId = env.AWS_ACCESS_KEY_ID;
  let secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId && !secretAccessKey && config.credentialsFile) {
    const info = await stat(config.credentialsFile);
    if (!info.isFile() || (info.mode & 0o077)) throw new Error("Credentials file must be private; run chmod 600 on it.");
    let stored;
    try { stored = JSON.parse(await readFile(config.credentialsFile, "utf8")); }
    catch { throw new Error("Credentials file must contain valid JSON with accessKeyId and secretAccessKey."); }
    accessKeyId = stored?.accessKeyId;
    secretAccessKey = stored?.secretAccessKey;
  }
  if (typeof accessKeyId !== "string" || !accessKeyId.trim() || typeof secretAccessKey !== "string" || !secretAccessKey.trim()) {
    throw new Error("Set both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or configure a private credentialsFile for R2/S3.");
  }
  return { accessKeyId, secretAccessKey };
}
type Asset = { key: string; bytes: Uint8Array; type: string };
export interface Store {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array, type: string, cache: string): Promise<void>;
  publicGet(key: string): Promise<Uint8Array>;
}
export async function publish(store: Store, assets: Asset[], envelope: Uint8Array, installer: Uint8Array) {
  // Publisher invocations must be serialized (the CLI takes a local lock).
  // Existing immutable objects can be reused only when their bytes match.
  for (const asset of assets) {
    const previous = await store.get(asset.key);
    if (previous && sha256(previous) !== sha256(asset.bytes)) throw new Error(`Refusing to overwrite ${asset.key}; choose a new version.`);
    if (!previous) await store.put(asset.key, asset.bytes, asset.type, "public, max-age=31536000, immutable");
    if (sha256(await store.publicGet(asset.key)) !== sha256(asset.bytes)) throw new Error(`Public verification failed: ${asset.key}`);
  }
  await store.put("install.sh", installer, "text/x-shellscript", "no-cache, max-age=0");
  if (sha256(await store.publicGet("install.sh")) !== sha256(installer)) throw new Error("Public installer verification failed");
  // Single-object signed envelope: there is no signature/manifest pairing race.
  await store.put("channels/stable.json", envelope, "application/json", "no-cache, max-age=0");
  if (sha256(await store.publicGet("channels/stable.json")) !== sha256(envelope)) throw new Error("Channel was published, but public verification failed; check CDN caching before retrying.");
}
function shellQuote(value: string) { return "'" + value.replaceAll("'", "'\\''") + "'"; }
const installTemplate = readFileSync(join(import.meta.dir, "install.sh.in"), "utf8");
export function installer(base: string, version: string, binaries: Record<string, { sha256: string }>, template = installTemplate) {
  const values: Record<string, string> = {
    BASE: shellQuote(base), VERSION: shellQuote(releaseVersion(version)),
    MAC_SHA256: shellQuote(binaries["macos-aarch64"].sha256),
    LINUX_SHA256: shellQuote(binaries["linux-x86_64"].sha256),
  };
  return template.replace(/@(BASE|VERSION|MAC_SHA256|LINUX_SHA256)@/g, (_, key) => values[key]);
}

// The macOS binary's debug map points into the build cache, which goes away
// with the release checkout, so its debug info is kept as a dSYM.
async function writeDsym(run: (argv: string[], capture?: boolean) => Promise<string>, binary: string, dsym: string) {
  await run(["xcrun", "dsymutil", binary, "-o", dsym]);
  const uuid = async (path: string) => (await run(["xcrun", "dwarfdump", "--uuid", path], true)).split(" ")[1];
  if (await uuid(binary) !== await uuid(dsym)) throw new Error("The dSYM does not match the macOS binary.");
  // dsymutil only warns about missing build products; corgi's own code must resolve.
  const symbol = (await run(["nm", binary], true)).split("\n").find(line => line.endsWith(" _main.run"))?.split(" ")[0];
  const resolved = symbol ? await run(["xcrun", "atos", "-o", dsym, "-arch", "arm64", `0x${symbol}`], true) : "";
  if (!resolved.includes("(main.zig:")) throw new Error("The dSYM has no debug info for corgi's code.");
}
async function command(cwd: string, env: typeof process.env, argv: string[], capture = false) {
  const child = Bun.spawn(argv, { cwd, env, stdout: capture ? "pipe" : "inherit", stderr: "inherit", stdin: "ignore" });
  const output = capture ? await new Response(child.stdout).text() : "";
  if (await child.exited !== 0) throw new Error(`Command failed: ${argv[0]} ${argv.slice(1, 3).join(" ")}`);
  return output.trim();
}
async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "--help") {
    console.log("Usage: ./scripts/release [VERSION] [--dry-run | --build-only | --publish-only]\n       ./scripts/release --init-key PATH\n\nBuilds macOS arm64 + static Linux amd64 on an Apple Silicon Mac, then publishes\nto an S3-compatible bucket. Config: ~/.config/corgi/release.json or CORGI_RELEASE_CONFIG.\nCredentials: private credentialsFile in config, or AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (R2/S3).\nBuilds committed HEAD in an isolated checkout, leaving pending edits and development build outputs alone.\nOmit VERSION for UTC datetime + Git hash. --build-only does not upload.\n--publish-only requires VERSION and resumes the saved commit without rebuilding/signing, even if HEAD has moved.");
    return;
  }
  if (argv[0] === "--init-key") {
    if (argv.length !== 2) throw new Error("Provide a private key path outside the repository.");
    const path = resolve(argv[1]);
    if (path === repo || path.startsWith(repo + "/")) throw new Error("Keep the signing key outside the repository.");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, privateKey.export({ type: "pkcs8", format: "pem" }), { flag: "wx", mode: 0o600 });
    console.log(`Created ${path}\nPublic key: ${Buffer.from(publicKey.export({ type: "spki", format: "der" })).subarray(-32).toString("hex")}`);
    return;
  }
  const options = releaseOptions(argv);
  const { mode } = options;
  const paths = releasePaths(repo);
  // Releases prepared before isolation was introduced can still be resumed.
  let releases = paths.releases;
  if (mode === "--publish-only" && !await Bun.file(join(releases, options.version!, "prepared.json")).exists()
    && await Bun.file(join(repo, "zig-out/releases", options.version!, "prepared.json")).exists()) releases = join(repo, "zig-out/releases");
  const commit = await releaseCommit(repo, options, releases);
  const version = publishedVersion(options.version || timestampVersion(commit), commit);
  const out = join(releases, version);
  if (mode === "--dry-run") {
    console.log(`Release ${version}: test → build/sign macOS arm64 → cross-compile static Linux amd64 → verify both → sign manifest → upload debug files to Sentry → upload/verify assets → publish channel last.\nSource: ${commit} (isolated committed tree; pending edits excluded)\nArtifacts: ${out}\nConfig: ${process.env.CORGI_RELEASE_CONFIG || join(homedir(), ".config/corgi/release.json")}\nNo builds, tags, uploads, or remote changes performed.`);
    return;
  }
  const config: Config = JSON.parse(await readFile(process.env.CORGI_RELEASE_CONFIG || join(homedir(), ".config/corgi/release.json"), "utf8"));
  config.publicBaseUrl = config.publicBaseUrl.replace(/\/+$/, "");
  for (const url of [config.publicBaseUrl, config.endpoint]) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("Use credential-free HTTPS URLs without query strings or fragments.");
  }
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Run releases on an Apple Silicon Mac (macOS signing requires it).");
  if (config.sentry) {
    const { dsn, org, project } = config.sentry;
    if (![dsn, org, project].every(v => typeof v === "string" && v)) throw new Error("sentry needs dsn, org and project.");
    if (new URL(dsn).protocol !== "https:") throw new Error("Use an HTTPS Sentry DSN.");
    if (mode !== "--build-only" && !Bun.which("sentry-cli")) throw new Error("Install sentry-cli to upload debug files: brew install getsentry/tools/sentry-cli");
  }
  const credentials = mode === "--build-only" ? undefined : await loadCredentials(config);
  const key = createPrivateKey(await readFile(config.signingKey));
  if (key.asymmetricKeyType !== "ed25519") throw new Error("The release signing key must be Ed25519.");
  const publicKey = Buffer.from(createPublicKey(key).export({ type: "spki", format: "der" })).subarray(-32).toString("hex");
  await mkdir(dirname(out), { recursive: true });
  const lock = paths.lock;
  await mkdir(lock).catch(() => { throw new Error(`Another publisher is running (or left ${lock}); remove it only after confirming no publisher is running.`); });
  const run = async (source: string) => {
    const env = releaseEnvironment(repo, source);
    const runCommand = (argv: string[], capture = false) => command(source, env, argv, capture);
    const checkSource = () => {
      if (cleanCommit(source) !== commit) throw new Error("Release checkout changed. Choose a new release after finishing edits.");
    };
    checkSource();
    console.log(`Release ${version} from ${commit} (isolated committed tree).\nArtifacts: ${out}`);
    if (mode !== "--publish-only") {
      // Rebuilding a prepared version could change timestamped macOS signatures.
      if (await Bun.file(join(out, "prepared.json")).exists()) throw new Error("Release already prepared. Use --publish-only to resume, or choose another version.");
      await runCommand(["./scripts/zig", "build", "test"]);
      // The updater suite runs copies of a test build as two releases.
      const testPrefix = join(source, "zig-out/test");
      await runCommand(["./scripts/zig", "build", "-Dcodesign=false", "-Doptimize=ReleaseSafe", "-Dviewer-test-driver=true", "--prefix", testPrefix]);
      await command(source, { ...env, CORGI_TEST_BIN: join(testPrefix, "bin/corgi") }, ["bun", "test", "tests/release.test.ts", "tests/updates.test.ts"]);
      await mkdir(out, { recursive: true });
      const binaries: Record<string, { url: string; sha256: string; size: number }> = {};
      for (const target of targets) {
        const prefix = join(out, target.name);
        const args = ["./scripts/zig", "build", "-Doptimize=ReleaseSafe", `-Dtarget=${target.zig}`, `-Drelease-version=${version}`, `-Drelease-commit=${commit}`, `-Dupdate-url=${config.publicBaseUrl}`, `-Dupdate-public-key=${publicKey}`, "--prefix", prefix];
        if (target.name === "macos-aarch64") {
          args.push("--sysroot", await runCommand(["xcrun", "--sdk", "macosx", "--show-sdk-path"], true));
          if (config.codesignIdentity === "-") {
            if (mode !== "--build-only") throw new Error("Ad-hoc signing is only allowed with --build-only. Configure a persistent macOS signing identity for publishing.");
            args.push("-Dcodesign=false");
          } else if (config.codesignIdentity) args.push(`-Dsigning-identity=${config.codesignIdentity}`);
        } else args.push("-Dcodesign=false");
        if (config.sentry) args.push(`-Dsentry-dsn=${config.sentry.dsn}`);
        await runCommand(args);
        if (target.name === "macos-aarch64") await writeDsym(runCommand, join(prefix, "bin/corgi"), join(out, "corgi-macos-aarch64.dSYM"));
        const bytes = await readFile(join(prefix, "bin/corgi"));
        validateBinary(target.name, bytes);
        await writeFile(join(out, `corgi-${target.name}`), bytes, { mode: 0o755 });
        binaries[target.name] = { url: `${config.publicBaseUrl}/releases/${version}/corgi-${target.name}`, sha256: sha256(bytes), size: bytes.length };
      }
      const info = JSON.parse(await runCommand([join(out, "corgi-macos-aarch64"), "__update-info"], true));
      if (info.version !== version || info.commit !== commit || info.test_mode) throw new Error("Release metadata mismatch or unsafe test build.");
      const payload = JSON.stringify({ schema_version: 1, version, commit, update_abi: info.update_abi, targets: binaries });
      const envelope = JSON.stringify({ payload, signature: sign(null, Buffer.from(payload), key).toString("hex") });
      await writeFile(join(out, "manifest.json"), envelope);
      const template = await readFile(join(source, "scripts/install.sh.in"), "utf8");
      const install = installer(config.publicBaseUrl, version, binaries, template);
      await writeFile(join(out, "install.sh"), install);
      checkSource();
      await writeFile(join(out, "prepared.json"), JSON.stringify({ version, commit, publicBaseUrl: config.publicBaseUrl, publicKey, publishable: mode !== "--build-only", sentry: config.sentry?.dsn, hashes: { ...Object.fromEntries(targets.map(t => [`corgi-${t.name}`, binaries[t.name].sha256])), "manifest.json": sha256(envelope), "install.sh": sha256(install) } }, null, 2));
    }
    if (mode === "--build-only") { console.log(`Both platforms built and verified in ${out}. Nothing published.`); return; }
    const prepared = JSON.parse(await readFile(join(out, "prepared.json"), "utf8"));
    if (!prepared.publishable || prepared.version !== version || prepared.commit !== commit || prepared.publicKey !== publicKey || prepared.publicBaseUrl !== config.publicBaseUrl) throw new Error("Prepared release does not match this release source/configuration.");
    if (prepared.sentry && prepared.sentry !== config.sentry?.dsn) throw new Error("Prepared release reports crashes to a Sentry project this configuration does not name.");
    for (const [name, digest] of Object.entries(prepared.hashes)) if (sha256(await readFile(join(out, name))) !== digest) throw new Error(`Prepared artifact changed: ${name}`);
    const s3 = new Bun.S3Client({ endpoint: config.endpoint, region: config.region, bucket: config.bucket, ...credentials });
    const store: Store = {
      async get(path) { const file = s3.file(path); return await file.exists() ? new Uint8Array(await file.arrayBuffer()) : null; },
      async put(path, bytes, type, cache) {
        checkSource();
        const url = s3.file(path).presign({ method: "PUT", expiresIn: 3600 });
        const response = await fetch(url, { method: "PUT", body: new Uint8Array(bytes), headers: { "Content-Type": type, "Cache-Control": cache }, signal: AbortSignal.timeout(300_000) });
        if (!response.ok) throw new Error(`Upload failed for ${path}: HTTP ${response.status}`);
      },
      async publicGet(path) {
        const response = await fetch(`${config.publicBaseUrl}/${path}`, { cache: "no-store", signal: AbortSignal.timeout(300_000) });
        if (!response.ok) throw new Error(`Public download failed for ${path}: HTTP ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
      },
    };
    const previousChannel = await store.get("channels/stable.json");
    if (previousChannel) {
      const current = JSON.parse(JSON.parse(Buffer.from(previousChannel).toString()).payload).version;
      const compare = versionParts;
      const old = compare(current), next = compare(version);
      const first = next.findIndex((n, i) => n !== old[i]);
      if (first >= 0 && next[first] < old[first]) throw new Error(`Refusing to move stable backwards from ${current} to ${version}.`);
    }
    // Crashes can arrive as soon as the channel moves; Sentry symbolicates
    // them with these files.
    if (prepared.sentry) {
      await runCommand(["sentry-cli", "debug-files", "upload", "--org", config.sentry!.org, "--project", config.sentry!.project, "--wait",
        join(out, "corgi-macos-aarch64.dSYM"), join(out, "corgi-linux-x86_64")]);
    }
    const assets = await Promise.all([...targets.map(t => `corgi-${t.name}`), "manifest.json", "install.sh"].map(async name => ({ key: `releases/${version}/${name}`, bytes: await readFile(join(out, name)), type: name.endsWith(".json") ? "application/json" : name.endsWith(".sh") ? "text/x-shellscript" : "application/octet-stream" })));
    await publish(store, assets, await readFile(join(out, "manifest.json")), await readFile(join(out, "install.sh")));
    console.log(`Published Corgi ${version} for macOS arm64 and Linux amd64.\nInstall: curl -fsSL ${config.publicBaseUrl}/install.sh | bash\nSource: ${commit}\nNo Git tags or remotes were changed.`);
  };
  try {
    await withReleaseCheckout(repo, commit, run);
  } finally { await rm(lock, { recursive: true }); }
}
if (import.meta.main) main().catch(error => { console.error(error.message); process.exitCode = 1; });
