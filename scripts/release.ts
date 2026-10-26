#!/usr/bin/env bun
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rm, stat, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";

const repo = resolve(import.meta.dir, "..");
// Releases from before Linux arm64 read manifest.json and reject a target they don't
// know, so it and any later target get a manifest and channel of their own.
export const targets = [
  { name: "macos-aarch64", bun: "darwin-arm64", manifest: "manifest.json", channel: "channels/stable.json" },
  { name: "linux-x86_64", bun: "linux-x64", manifest: "manifest.json", channel: "channels/stable.json" },
  {
    name: "linux-aarch64",
    bun: "linux-arm64",
    manifest: "manifest-linux-aarch64.json",
    channel: "channels/stable-linux-aarch64.json",
  },
] as const;
// Each manifest and the channel that serves it, with the targets it names.
export const manifests = [...new Set(targets.map(t => t.manifest))].map(name => {
  const named = targets.filter(t => t.manifest === name);
  return { name, channel: named[0].channel, targets: named.map(t => t.name) };
});
type Target = (typeof targets)[number];
// The native layer, in the paths build.ts embeds it from.
const nativeFiles = (target: Target) => {
  const suffix = target.name.startsWith("macos") ? "dylib" : "so";
  return [`lib/libcorgi_term.${suffix}`, `lib/libcorgi_system.${suffix}`, "bin/pty-exec", "bin/corgi-hook"];
};
export const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
export function releaseVersion(value: string) {
  if (/^\d{8}T\d{6}Z-[a-f0-9]{7,40}$/.test(value)) return value;
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))
    throw new Error("Version must be UTC datetime + Git hash, or MAJOR.MINOR.PATCH.");
  if (value.split(".").some(n => !Number.isSafeInteger(Number(n))))
    throw new Error("Version components are too large.");
  return value;
}
export function timestampVersion(commit: string, date = new Date()) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Expected a full Git commit hash.");
  return (
    date
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}Z$/, "Z") +
    "-" +
    commit.slice(0, 12)
  );
}
export function publishedVersion(value: string, commit: string) {
  if (!/^\d{8}T\d{6}Z-[a-f0-9]{12}$/.test(value) || value.slice(17) !== commit.slice(0, 12))
    throw new Error("Release version must be UTC datetime + the first 12 characters of HEAD.");
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}.000Z`;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime()) || timestampVersion(commit, date) !== value)
    throw new Error("Invalid release datetime.");
  return value;
}
export function versionParts(value: string) {
  releaseVersion(value);
  return value.includes("T")
    ? [Number(value.slice(0, 8)), Number(value.slice(9, 15)), 0]
    : value.split(".").map(Number);
}
function git(cwd: string, ...args: string[]) {
  const p = Bun.spawnSync(["git", "--no-optional-locks", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode) throw new Error(`Git ${args[0]} failed: ${p.stderr.toString().trim()}`);
  return p.stdout.toString().trim();
}
export function cleanCommit(cwd = repo) {
  if (git(cwd, "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"))
    throw new Error("Release checkout is dirty.");
  return git(cwd, "rev-parse", "HEAD");
}
export function releaseOptions(argv: string[]) {
  let version: string | undefined,
    mode = "",
    skipTests = false;
  for (const arg of argv) {
    if (["--dry-run", "--build-only", "--publish-only"].includes(arg) && !mode) mode = arg;
    else if (arg === "--skip-tests" && !skipTests) skipTests = true;
    else if (!arg.startsWith("--") && !version) version = releaseVersion(arg);
    else throw new Error("Unknown or conflicting option; run --help.");
  }
  if (mode === "--publish-only" && !version) throw new Error("Provide the prepared VERSION with --publish-only.");
  return { version, mode, skipTests };
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
  if (!/^[a-f0-9]{40}$/.test(prepared.commit) || prepared.version !== options.version)
    throw new Error("Invalid prepared release source/version.");
  return prepared.commit as string;
}
export async function withReleaseCheckout<T>(
  cwd: string,
  commit: string,
  run: (source: string) => Promise<T>,
): Promise<T> {
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
const os = process.platform === "darwin" ? "macos" : process.platform,
  arch = process.arch === "arm64" ? "aarch64" : "x86_64";
// The release target this machine runs.
const host = () => `${os}-${arch}`;
export function releaseEnvironment(cwd: string, source: string, env = process.env) {
  // Reuse the compiler (not the development build outputs) when it lives in .tools.
  let compiler = env.ZIG;
  if (compiler?.includes("/")) compiler = resolve(cwd, compiler);
  if (!compiler) {
    const zig = Bun.which("zig", { PATH: env.PATH });
    const installed = zig && Bun.spawnSync([zig, "version"], { env, stdout: "pipe", stderr: "pipe" });
    compiler =
      installed && installed.exitCode === 0 && installed.stdout.toString().trim() === "0.16.0"
        ? "zig"
        : join(cwd, `.tools/zig-${arch}-${os}-0.16.0/zig`);
  }
  return { ...env, ZIG: compiler, ZIG_LOCAL_CACHE_DIR: join(source, "native/.zig-cache") };
}
// The macOS SDK the native layer compiles against: Xcode's on a Mac, or a copy.
export function macosSdk(cwd: string, config: { macosSdk?: string }, platform = process.platform) {
  if (config.macosSdk) return resolve(cwd, config.macosSdk);
  if (platform === "darwin") {
    const p = Bun.spawnSync(["xcrun", "--sdk", "macosx", "--show-sdk-path"], { stdout: "pipe", stderr: "inherit" });
    if (p.exitCode) throw new Error("xcrun found no macOS SDK; install the Xcode command line tools.");
    return p.stdout.toString().trim();
  }
  const copy = join(cwd, ".tools/macos-sdk");
  if (!existsSync(join(copy, "SDKSettings.json")))
    throw new Error(`No macOS SDK at ${copy}; copy one there or set macosSdk in the release config.`);
  return copy;
}
export function validateBinary(name: string, bytes: Uint8Array) {
  const b = Buffer.from(bytes);
  if (name === "macos-aarch64") {
    if (b.length < 32 || b.readUInt32LE(0) !== 0xfeedfacf || b.readUInt32LE(4) !== 0x0100000c)
      throw new Error("Expected an arm64 Mach-O binary.");
  } else {
    const [machine, arch] = name === "linux-aarch64" ? [183, "arm64"] : [62, "amd64"];
    if (
      b.length < 64 ||
      b.subarray(0, 4).toString("hex") !== "7f454c46" ||
      b[4] !== 2 ||
      b[5] !== 1 ||
      b.readUInt16LE(18) !== machine
    )
      throw new Error(`Expected an ${arch} ELF binary.`);
    const offset = Number(b.readBigUInt64LE(32)),
      size = b.readUInt16LE(54),
      count = b.readUInt16LE(56);
    if (size < 56 || offset + size * count > b.length) throw new Error("Malformed ELF program headers.");
  }
}
type Config = {
  publicBaseUrl: string;
  endpoint: string;
  region: string;
  bucket: string;
  signingKey: string;
  codesignIdentity?: string;
  // A Developer ID certificate and key exported from the keychain, which
  // rcodesign signs with on any platform.
  codesignP12?: string;
  codesignP12PasswordFile?: string;
  notaryProfile?: string;
  // An App Store Connect API key from `rcodesign encode-app-store-connect-api-key`.
  notaryApiKey?: string;
  macosSdk?: string;
  credentialsFile?: string;
  sentry?: SentryConfig;
};
// Release builds send crash reports to this Sentry project, which gets their debug files.
type SentryConfig = { dsn: string; org: string; project: string };
export async function privateFile(path: string, what: string) {
  const info = await stat(path);
  if (!info.isFile() || info.mode & 0o077) throw new Error(`${what} must be private; run chmod 600 on it.`);
}
export async function loadCredentials(config: Pick<Config, "credentialsFile">, env = process.env) {
  let accessKeyId = env.AWS_ACCESS_KEY_ID;
  let secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId && !secretAccessKey && config.credentialsFile) {
    await privateFile(config.credentialsFile, "Credentials file");
    let stored;
    try {
      stored = JSON.parse(await readFile(config.credentialsFile, "utf8"));
    } catch {
      throw new Error("Credentials file must contain valid JSON with accessKeyId and secretAccessKey.");
    }
    accessKeyId = stored?.accessKeyId;
    secretAccessKey = stored?.secretAccessKey;
  }
  if (
    typeof accessKeyId !== "string" ||
    !accessKeyId.trim() ||
    typeof secretAccessKey !== "string" ||
    !secretAccessKey.trim()
  ) {
    throw new Error(
      "Set both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or configure a private credentialsFile for R2/S3.",
    );
  }
  return { accessKeyId, secretAccessKey };
}
type Asset = { key: string; bytes: Uint8Array; type: string };
export interface Store {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array, type: string, cache: string): Promise<void>;
  publicGet(key: string): Promise<Uint8Array>;
}
export async function publish(store: Store, assets: Asset[], channels: Asset[], installer: Uint8Array) {
  // Publisher invocations must be serialized (the CLI takes a local lock).
  // Existing immutable objects can be reused only when their bytes match.
  for (const asset of assets) {
    const previous = await store.get(asset.key);
    if (previous && sha256(previous) !== sha256(asset.bytes))
      throw new Error(`Refusing to overwrite ${asset.key}; choose a new version.`);
    if (!previous) await store.put(asset.key, asset.bytes, asset.type, "public, max-age=31536000, immutable");
    if (sha256(await store.publicGet(asset.key)) !== sha256(asset.bytes))
      throw new Error(`Public verification failed: ${asset.key}`);
  }
  await store.put("install.sh", installer, "text/x-shellscript", "no-cache, max-age=0");
  if (sha256(await store.publicGet("install.sh")) !== sha256(installer))
    throw new Error("Public installer verification failed");
  // Single-object signed envelopes: there is no signature/manifest pairing race.
  for (const channel of channels) {
    await store.put(channel.key, channel.bytes, channel.type, "no-cache, max-age=0");
    if (sha256(await store.publicGet(channel.key)) !== sha256(channel.bytes))
      throw new Error(
        `${channel.key} was published, but public verification failed; check CDN caching before retrying.`,
      );
  }
}
function shellQuote(value: string) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
const installTemplate = readFileSync(join(import.meta.dir, "install.sh.in"), "utf8");
export function installer(
  base: string,
  version: string,
  binaries: Record<string, { sha256: string; size: number }>,
  template = installTemplate,
) {
  const values: Record<string, string> = {
    BASE: shellQuote(base),
    VERSION: shellQuote(releaseVersion(version)),
    MAC_SHA256: shellQuote(binaries["macos-aarch64"].sha256),
    LINUX_SHA256: shellQuote(binaries["linux-x86_64"].sha256),
    LINUX_ARM_SHA256: shellQuote(binaries["linux-aarch64"].sha256),
    MAC_SIZE: String(binaries["macos-aarch64"].size),
    LINUX_SIZE: String(binaries["linux-x86_64"].size),
    LINUX_ARM_SIZE: String(binaries["linux-aarch64"].size),
  };
  for (const size of [values.MAC_SIZE, values.LINUX_SIZE, values.LINUX_ARM_SIZE])
    if (!/^[1-9]\d*$/.test(size)) throw new Error("Invalid binary size.");
  return template.replace(
    /@(BASE|VERSION|MAC_SHA256|LINUX_SHA256|LINUX_ARM_SHA256|MAC_SIZE|LINUX_SIZE|LINUX_ARM_SIZE)@/g,
    (_, key) => values[key],
  );
}
// Finds the one Developer ID Application (or else Apple Development) identity in the keychain.
async function signingIdentity(run: (argv: string[], capture?: boolean) => Promise<string>) {
  const identities = await run(["/usr/bin/security", "find-identity", "-v", "-p", "codesigning"], true);
  for (const kind of ["Developer ID Application:", "Apple Development:"]) {
    const matches = identities
      .split("\n")
      .filter(line => line.includes(`"${kind}`))
      .map(line => line.trim().split(/\s+/)[1]);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1)
      throw new Error(`Multiple ${kind} identities; set codesignIdentity to a certificate SHA-1.`);
  }
  throw new Error("No signing identity found. Install a Developer ID Application certificate with its private key.");
}
// A keychain identity on a Mac, or a certificate file rcodesign signs with anywhere.
export type Signer =
  { tool: "codesign"; identity: string } | { tool: "rcodesign"; p12: string; passwordFile: string; notarize: boolean };
// Bun's JIT needs these under the hardened runtime. Native libraries are
// signed by the same identity before Bun embeds them.
const entitlements = join(import.meta.dir, "entitlements.plist");
type SignOptions = { identifier?: string; entitlements?: boolean };
export function signCommands(signer: Signer, path: string, options: SignOptions = {}) {
  if (signer.tool === "rcodesign") {
    // rcodesign timestamps by default. --for-notarization also sets the
    // hardened runtime, but refuses certificates other than Developer ID.
    const args = ["rcodesign", "sign", "--p12-file", signer.p12, "--p12-password-file", signer.passwordFile];
    args.push(...(signer.notarize ? ["--for-notarization"] : ["--code-signature-flags", "runtime"]));
    if (options.identifier) args.push("--binary-identifier", options.identifier);
    if (options.entitlements) args.push("--entitlements-xml-file", entitlements);
    return [
      [...args, path],
      ["rcodesign", "verify", path],
    ];
  }
  const args = ["/usr/bin/codesign", "--force", "--sign", signer.identity, "--options", "runtime", "--timestamp"];
  if (options.identifier) args.push("--identifier", options.identifier);
  if (options.entitlements) args.push("--entitlements", entitlements);
  return [
    [...args, path],
    ["/usr/bin/codesign", "--verify", "--strict", path],
  ];
}
async function codesign(
  run: (argv: string[], capture?: boolean) => Promise<string>,
  signer: Signer,
  path: string,
  options: SignOptions = {},
) {
  for (const argv of signCommands(signer, path, options)) await run(argv);
}
// LLVM's dsymutil and dwarfdump: Xcode's on a Mac, or an installed (perhaps
// versioned, like dsymutil-18) copy elsewhere.
export function debugTools(platform = process.platform, path = process.env.PATH ?? "") {
  if (platform === "darwin") return { dsymutil: ["xcrun", "dsymutil"], dwarfdump: ["xcrun", "dwarfdump"] };
  const find = (name: string) => {
    const found = Bun.which(name, { PATH: path });
    if (found) return found;
    const versioned = new RegExp(`^${name}-(\\d+)$`);
    let best: { path: string; version: number } | undefined;
    for (const dir of path.split(":").filter(Boolean)) {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const version = Number(versioned.exec(entry)?.[1]);
        if (version && (!best || version > best.version)) best = { path: join(dir, entry), version };
      }
    }
    return best?.path;
  };
  const dsymutil = find("dsymutil"),
    dwarfdump = find("llvm-dwarfdump");
  return dsymutil && dwarfdump ? { dsymutil: [dsymutil], dwarfdump: [dwarfdump] } : null;
}
// The native libraries' debug maps point into the build cache, which goes
// away with the release checkout, so their debug info is kept as dSYMs.
async function writeDsyms(
  run: (argv: string[], capture?: boolean) => Promise<string>,
  tools: NonNullable<ReturnType<typeof debugTools>>,
  native: string,
  files: string[],
  out: string,
) {
  await mkdir(out, { recursive: true });
  for (const file of files) {
    const binary = join(native, file),
      dsym = join(out, file.split("/").pop()! + ".dSYM");
    await run([...tools.dsymutil, binary, "-o", dsym]);
    const uuid = async (path: string) => (await run([...tools.dwarfdump, "--uuid", path], true)).split(" ")[1];
    if ((await uuid(binary)) !== (await uuid(dsym))) throw new Error(`The dSYM does not match ${file}.`);
  }
}
// Runs a shell in a pane on a private runtime: Bun, the embedded native
// libraries and the PTY helper all load and work.
async function smokeTest(binary: string) {
  const home = await mkdtemp("/tmp/corgi-smoke-");
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    XDG_STATE_HOME: join(home, "state"),
    CODEX_HOME: join(home, ".codex"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CORGI_SOCKET: join(home, "s.sock"),
    SHELL: "/bin/sh",
    TMPDIR: home,
  };
  const cli = async (...args: string[]) => {
    const p = Bun.spawn([binary, ...args], { env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    if (code) throw new Error(`Smoke test failed: corgi ${args[0]}: ${err.trim() || code}`);
    return out;
  };
  let protocol = 0;
  const request = async (message: { op: string }) => {
    const reply = JSON.parse(await cli("rpc", JSON.stringify(message)));
    if (reply.err) throw new Error(`Smoke test failed: ${message.op}: ${reply.err}`);
    return reply;
  };
  const rpc = (command?: unknown) =>
    request(command ? { op: "session.command", protocol, command } : { op: "session.snapshot", protocol });
  try {
    await cli("start");
    // The management protocol is stable; hello names the runtime protocol this build speaks.
    protocol = (await request({ op: "hello", protocol: 1 })).protocol;
    const session = await rpc();
    await rpc({ "pane.create": { workspace: session.workspaces[0].id, cwd: home, command: "exec /bin/sh" } });
    const pane = (await rpc()).panes[0].id;
    await rpc({ "pane.input": { target: pane, data: "printf 'SMOKE_%s\\n' OK\r" } });
    for (let i = 0; ; i++) {
      if ((await rpc({ "pane.read": { target: pane, view: "screen" } })).result.text.includes("SMOKE_OK")) break;
      if (i === 100) throw new Error("Smoke test failed: the pane never ran its shell.");
      await Bun.sleep(100);
    }
  } finally {
    await cli("shutdown").catch(() => {});
    await rm(home, { recursive: true, force: true });
  }
}
const step = (message: string) => console.log(`==> ${message}`);
const megabytes = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;
// The bucket and CDN drop connections now and then; each transfer is retried whole.
async function retrying<T>(what: string, attempt: () => Promise<T>) {
  for (let i = 1; ; i++) {
    step(what);
    try {
      return await attempt();
    } catch (error) {
      if (i === 6) throw error;
      console.error(`${what} failed: ${(error as Error).message}. Retrying in ${i * 5}s (${i}/5).`);
      await Bun.sleep(i * 5000);
    }
  }
}
type Progress = { total: number; moved(bytes: number): void; signal: AbortSignal };
// Prints a transfer's progress every 2s, and aborts it after a minute without any.
async function watched<T>(what: string, total: number, run: (progress: Progress) => Promise<T>) {
  const controller = new AbortController(),
    started = Date.now();
  let done = 0,
    last = started;
  const progress: Progress = {
    total,
    moved(bytes) {
      done += bytes;
      last = Date.now();
    },
    signal: controller.signal,
  };
  const timer = setInterval(() => {
    const of = progress.total ? `/${megabytes(progress.total)} (${Math.floor((done / progress.total) * 100)}%)` : "";
    console.log(`    ${what}: ${megabytes(done)}${of}, ${megabytes(done / ((Date.now() - started) / 1000))}/s`);
    if (Date.now() - last > 60_000) controller.abort(new Error("No progress for a minute"));
  }, 2000);
  try {
    return await run(progress);
  } finally {
    clearInterval(timer);
  }
}
// fetch has no upload progress, so the body is a stream that counts what the
// connection takes. Bun keeps the Content-Length the bucket requires.
function upload(url: string, what: string, bytes: Uint8Array, headers: Record<string, string>) {
  return watched(what, bytes.length, async progress => {
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(stream) {
        if (sent === bytes.length) return stream.close();
        const chunk = bytes.slice(sent, sent + 256 * 1024);
        sent += chunk.length;
        progress.moved(chunk.length);
        stream.enqueue(chunk);
      },
    });
    const response = await fetch(url, {
      method: "PUT",
      body,
      headers: { ...headers, "Content-Length": String(bytes.length) },
      signal: progress.signal,
    });
    if (!response.ok)
      throw new Error(`Upload failed for ${what}: HTTP ${response.status} ${(await response.text()).slice(0, 500)}`);
  });
}
function download(url: string, what: string) {
  return watched(what, 0, async progress => {
    const response = await fetch(url, { cache: "no-store", signal: progress.signal });
    if (!response.ok) throw new Error(`Download failed for ${what}: HTTP ${response.status}`);
    progress.total = Number(response.headers.get("content-length")) || 0;
    const chunks: Uint8Array[] = [];
    for await (const chunk of response.body!) {
      chunks.push(chunk);
      progress.moved(chunk.length);
    }
    return new Uint8Array(Buffer.concat(chunks));
  });
}
async function command(cwd: string, env: typeof process.env, argv: string[], capture = false) {
  const child = Bun.spawn(argv, { cwd, env, stdout: capture ? "pipe" : "inherit", stderr: "inherit", stdin: "ignore" });
  const output = capture ? await new Response(child.stdout).text() : "";
  if ((await child.exited) !== 0) throw new Error(`Command failed: ${argv[0]} ${argv.slice(1, 3).join(" ")}`);
  return output.trim();
}
async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "--help") {
    console.log(
      "Usage: ./scripts/release [VERSION] [--dry-run | --build-only | --publish-only] [--skip-tests]\n       ./scripts/release --init-key PATH\n\nBuilds macOS arm64 + Linux amd64 and arm64, signs the macOS binary (keychain on a Mac, or rcodesign with\ncodesignP12 anywhere), then publishes to an S3-compatible bucket. Config: ~/.config/corgi/release.json or CORGI_RELEASE_CONFIG.\nCredentials: private credentialsFile in config, or AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (R2/S3).\nBuilds committed HEAD in an isolated checkout, leaving pending edits and development build outputs alone.\nOmit VERSION for UTC datetime + Git hash. --build-only does not upload, and runs on Linux too.\n--publish-only requires VERSION and resumes the saved commit without rebuilding/signing, even if HEAD has moved.\n--skip-tests builds without running the typecheck and test suites.",
    );
    return;
  }
  if (argv[0] === "--init-key") {
    if (argv.length !== 2) throw new Error("Provide a private key path outside the repository.");
    const path = resolve(argv[1]);
    if (path === repo || path.startsWith(repo + "/")) throw new Error("Keep the signing key outside the repository.");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, privateKey.export({ type: "pkcs8", format: "pem" }), { flag: "wx", mode: 0o600 });
    console.log(
      `Created ${path}\nPublic key: ${Buffer.from(publicKey.export({ type: "spki", format: "der" }))
        .subarray(-32)
        .toString("hex")}`,
    );
    return;
  }
  const options = releaseOptions(argv);
  const { mode } = options;
  const paths = releasePaths(repo);
  const releases = paths.releases;
  const commit = await releaseCommit(repo, options, releases);
  const version = publishedVersion(options.version || timestampVersion(commit), commit);
  const out = join(releases, version);
  if (mode === "--dry-run") {
    console.log(
      `Release ${version}: ${options.skipTests ? "" : "test → "}build Linux amd64 and arm64 and macOS arm64 → sign macOS → smoke-test → sign manifests → upload debug files to Sentry → upload/verify assets → publish channels last.\nSource: ${commit} (isolated committed tree; pending edits excluded)\nArtifacts: ${out}\nConfig: ${process.env.CORGI_RELEASE_CONFIG || join(homedir(), ".config/corgi/release.json")}\nNo builds, tags, uploads, or remote changes performed.`,
    );
    return;
  }
  const config: Config = JSON.parse(
    await readFile(process.env.CORGI_RELEASE_CONFIG || join(homedir(), ".config/corgi/release.json"), "utf8"),
  );
  config.publicBaseUrl = config.publicBaseUrl.replace(/\/+$/, "");
  for (const url of [config.publicBaseUrl, config.endpoint]) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash)
      throw new Error("Use credential-free HTTPS URLs without query strings or fragments.");
  }
  // The keychain signs on a Mac; elsewhere rcodesign signs with an exported
  // certificate, or a build-only run leaves the binary ad-hoc signed.
  const mac = process.platform === "darwin" && process.arch === "arm64";
  const building = mode !== "--publish-only";
  if (config.codesignIdentity === "-") {
    if (mode !== "--build-only")
      throw new Error(
        "Ad-hoc signing is only allowed with --build-only. Configure a persistent macOS signing identity for publishing.",
      );
  } else if (building && config.codesignP12) {
    if (!config.codesignP12PasswordFile) throw new Error("codesignP12 needs codesignP12PasswordFile.");
    await privateFile(config.codesignP12, "codesignP12");
    await privateFile(config.codesignP12PasswordFile, "codesignP12PasswordFile");
    if (!Bun.which("rcodesign"))
      throw new Error("Install rcodesign to sign with codesignP12: cargo install apple-codesign");
  } else if (building && !mac)
    throw new Error(
      'Run releases on an Apple Silicon Mac, set codesignP12 to sign with rcodesign, or build-only with codesignIdentity "-".',
    );
  if (building && config.codesignIdentity !== "-") {
    if (config.notaryApiKey) {
      await privateFile(config.notaryApiKey, "notaryApiKey");
      if (!config.codesignP12) throw new Error("notaryApiKey notarizes with rcodesign; set codesignP12 too.");
      if (!Bun.which("zip")) throw new Error("Install zip to notarize with notaryApiKey.");
    } else if (config.notaryProfile && !mac)
      throw new Error("notaryProfile is a Mac keychain profile; set notaryApiKey to notarize elsewhere.");
  }
  // Crash reports from published Macs are symbolicated with these dSYMs.
  const dsymTools = debugTools();
  if (mode === "" && !dsymTools)
    throw new Error("Install LLVM's dsymutil and llvm-dwarfdump to keep the macOS debug symbols.");
  if (config.sentry) {
    const { dsn, org, project } = config.sentry;
    if (![dsn, org, project].every(v => typeof v === "string" && v))
      throw new Error("sentry needs dsn, org and project.");
    if (new URL(dsn).protocol !== "https:") throw new Error("Use an HTTPS Sentry DSN.");
    if (mode !== "--build-only" && !Bun.which("sentry-cli"))
      throw new Error("Install sentry-cli to upload debug files: brew install getsentry/tools/sentry-cli");
  }
  const credentials = mode === "--build-only" ? undefined : await loadCredentials(config);
  const key = createPrivateKey(await readFile(config.signingKey));
  if (key.asymmetricKeyType !== "ed25519") throw new Error("The release signing key must be Ed25519.");
  const publicKey = Buffer.from(createPublicKey(key).export({ type: "spki", format: "der" }))
    .subarray(-32)
    .toString("hex");
  await mkdir(dirname(out), { recursive: true });
  const lock = paths.lock;
  await mkdir(lock).catch(() => {
    throw new Error(
      `Another publisher is running (or left ${lock}); remove it only after confirming no publisher is running.`,
    );
  });
  const run = async (source: string) => {
    const env = releaseEnvironment(repo, source);
    const runCommand = (argv: string[], capture = false) => command(source, env, argv, capture);
    const checkSource = () => {
      if (cleanCommit(source) !== commit)
        throw new Error("Release checkout changed. Choose a new release after finishing edits.");
    };
    checkSource();
    console.log(`Release ${version} from ${commit} (isolated committed tree).\nArtifacts: ${out}`);
    if (mode !== "--publish-only") {
      // Rebuilding a prepared version could change timestamped macOS signatures.
      if (await Bun.file(join(out, "prepared.json")).exists())
        throw new Error("Release already prepared. Use --publish-only to resume, or choose another version.");
      if (!options.skipTests) {
        // build.ts installs the locked dependencies the checks below need.
        step("Building the test binary");
        await runCommand([process.execPath, "build.ts", "--test"]);
        step("Typechecking");
        await runCommand([process.execPath, "typecheck.ts"]);
        step("Running unit tests");
        await runCommand([process.execPath, "test", "./src"]);
        // The updater suite runs copies of the test build as two releases.
        step("Running release and updater tests");
        await runCommand([process.execPath, "test", "./tests/release.test.ts", "./tests/updates.test.ts"]);
      }
      await mkdir(out, { recursive: true });
      const signer: Signer | null =
        config.codesignIdentity === "-"
          ? null
          : config.codesignP12
            ? {
                tool: "rcodesign",
                p12: config.codesignP12,
                passwordFile: config.codesignP12PasswordFile!,
                notarize: !!config.notaryApiKey,
              }
            : { tool: "codesign", identity: config.codesignIdentity || (await signingIdentity(runCommand)) };
      const binaries: Record<string, { url: string; sha256: string; size: number }> = {};
      for (const target of targets) {
        const native = join(out, "native", target.name),
          build = join(out, "build", target.name, "corgi");
        const files = nativeFiles(target);
        const macos = target.name === "macos-aarch64";
        const nativeArgs = [
          process.execPath,
          "build.ts",
          "--target",
          target.bun,
          "--native-root",
          native,
          "--native-only",
        ];
        if (macos) nativeArgs.push("--sysroot", macosSdk(repo, config));
        step(`Building the native layer for ${target.name}`);
        await runCommand(nativeArgs);
        if (macos && dsymTools) {
          step("Writing dSYMs");
          await writeDsyms(runCommand, dsymTools, native, files, join(out, "dsym"));
        }
        if (macos && signer) {
          step("Signing the native layer");
          for (const file of files) await codesign(runCommand, signer, join(native, file));
        }
        const args = [
          process.execPath,
          "build.ts",
          "--target",
          target.bun,
          "--native-root",
          native,
          "--no-native",
          "--outfile",
          build,
          "--release-version",
          version,
          "--release-commit",
          commit,
          "--update-url",
          config.publicBaseUrl,
          "--update-public-key",
          publicKey,
        ];
        if (config.sentry) args.push("--sentry-dsn", config.sentry.dsn);
        step(`Building corgi for ${target.name}`);
        await runCommand(args);
        if (macos && signer) {
          step("Signing corgi");
          await codesign(runCommand, signer, build, { identifier: "dev.corgi.cli", entitlements: true });
          if (config.notaryApiKey) {
            const zip = join(out, "build", target.name, "corgi.zip");
            step("Notarizing with rcodesign (waits for Apple)");
            await runCommand(["zip", "-j", "-X", "-q", zip, build]);
            await runCommand(["rcodesign", "notary-submit", "--api-key-file", config.notaryApiKey, "--wait", zip]);
          } else if (config.notaryProfile) {
            // Notarization doesn't change the binary; Gatekeeper looks the ticket up online.
            const zip = join(out, "build", target.name, "corgi.zip");
            step("Notarizing (waits for Apple)");
            await runCommand(["/usr/bin/ditto", "-c", "-k", "--keepParent", build, zip]);
            await runCommand([
              "xcrun",
              "notarytool",
              "submit",
              zip,
              "--keychain-profile",
              config.notaryProfile,
              "--wait",
            ]);
          }
        }
        const bytes = await readFile(build);
        validateBinary(target.name, bytes);
        await writeFile(join(out, `corgi-${target.name}`), bytes, { mode: 0o755 });
        binaries[target.name] = {
          url: `${config.publicBaseUrl}/releases/${version}/corgi-${target.name}`,
          sha256: sha256(bytes),
          size: bytes.length,
        };
      }
      const local = join(out, `corgi-${host()}`);
      if (!binaries[host()]) throw new Error(`No release target runs on ${host()}, so nothing can check the build.`);
      const info = JSON.parse(await runCommand([local, "__update-info"], true));
      if (info.version !== version || info.commit !== commit || info.test_mode)
        throw new Error("Release metadata mismatch or unsafe test build.");
      step(`Smoke-testing corgi-${host()}`);
      await smokeTest(local);
      const envelopes: Record<string, string> = {};
      for (const manifest of manifests) {
        const payload = JSON.stringify({
          schema_version: 1,
          version,
          commit,
          update_abi: info.update_abi,
          targets: Object.fromEntries(manifest.targets.map(name => [name, binaries[name]])),
        });
        envelopes[manifest.name] = JSON.stringify({
          payload,
          signature: sign(null, Buffer.from(payload), key).toString("hex"),
        });
        await writeFile(join(out, manifest.name), envelopes[manifest.name]);
      }
      const template = await readFile(join(source, "scripts/install.sh.in"), "utf8");
      const install = installer(config.publicBaseUrl, version, binaries, template);
      await writeFile(join(out, "install.sh"), install);
      checkSource();
      await writeFile(
        join(out, "prepared.json"),
        JSON.stringify(
          {
            version,
            commit,
            publicBaseUrl: config.publicBaseUrl,
            publicKey,
            publishable: mode !== "--build-only" && signer !== null,
            sentry: config.sentry?.dsn,
            hashes: {
              ...Object.fromEntries(targets.map(t => [`corgi-${t.name}`, binaries[t.name].sha256])),
              ...Object.fromEntries(manifests.map(m => [m.name, sha256(envelopes[m.name])])),
              "install.sh": sha256(install),
            },
          },
          null,
          2,
        ),
      );
    }
    if (mode === "--build-only") {
      console.log(`Every platform built and verified in ${out}. Nothing published.`);
      return;
    }
    const prepared = JSON.parse(await readFile(join(out, "prepared.json"), "utf8"));
    if (
      !prepared.publishable ||
      prepared.version !== version ||
      prepared.commit !== commit ||
      prepared.publicKey !== publicKey ||
      prepared.publicBaseUrl !== config.publicBaseUrl
    )
      throw new Error("Prepared release does not match this release source/configuration.");
    if (prepared.sentry && prepared.sentry !== config.sentry?.dsn)
      throw new Error("Prepared release reports crashes to a Sentry project this configuration does not name.");
    for (const [name, digest] of Object.entries(prepared.hashes))
      if (sha256(await readFile(join(out, name))) !== digest) throw new Error(`Prepared artifact changed: ${name}`);
    const s3 = new Bun.S3Client({
      endpoint: config.endpoint,
      region: config.region,
      bucket: config.bucket,
      ...credentials,
    });
    const store: Store = {
      get: path =>
        retrying(`Checking the bucket for ${path}`, async () => {
          const file = s3.file(path);
          return (await file.exists()) ? download(file.presign({ method: "GET", expiresIn: 3600 }), path) : null;
        }),
      put: (path, bytes, type, cache) =>
        retrying(`Uploading ${path} (${megabytes(bytes.length)})`, () => {
          checkSource();
          const url = s3.file(path).presign({ method: "PUT", expiresIn: 3600 });
          return upload(url, path, bytes, { "Content-Type": type, "Cache-Control": cache });
        }),
      publicGet: path =>
        retrying(`Verifying ${config.publicBaseUrl}/${path}`, () => download(`${config.publicBaseUrl}/${path}`, path)),
    };
    const previousChannel = await store.get("channels/stable.json");
    if (previousChannel) {
      const current = JSON.parse(JSON.parse(Buffer.from(previousChannel).toString()).payload).version;
      const old = versionParts(current),
        next = versionParts(version);
      const first = next.findIndex((n, i) => n !== old[i]);
      if (first >= 0 && next[first] < old[first])
        throw new Error(`Refusing to move stable backwards from ${current} to ${version}.`);
    }
    // Crashes can arrive as soon as the channel moves; Sentry symbolicates
    // them with these files.
    if (prepared.sentry) {
      step("Uploading debug files to Sentry");
      await runCommand([
        "sentry-cli",
        "debug-files",
        "upload",
        "--org",
        config.sentry!.org,
        "--project",
        config.sentry!.project,
        "--wait",
        join(out, "dsym"),
        ...targets.filter(t => t.name.startsWith("linux")).map(t => join(out, "native", t.name)),
      ]);
    }
    const assets = await Promise.all(
      [...targets.map(t => `corgi-${t.name}`), ...manifests.map(m => m.name), "install.sh"].map(async name => ({
        key: `releases/${version}/${name}`,
        bytes: await readFile(join(out, name)),
        type: name.endsWith(".json")
          ? "application/json"
          : name.endsWith(".sh")
            ? "text/x-shellscript"
            : "application/octet-stream",
      })),
    );
    const channels = await Promise.all(
      manifests.map(async m => ({
        key: m.channel,
        bytes: await readFile(join(out, m.name)),
        type: "application/json",
      })),
    );
    await publish(store, assets, channels, await readFile(join(out, "install.sh")));
    console.log(
      `Published Corgi ${version} for macOS arm64 and Linux amd64 and arm64.\nInstall: curl -fsSL ${config.publicBaseUrl}/install.sh | bash\nSource: ${commit}\nNo Git tags or remotes were changed.`,
    );
  };
  try {
    await withReleaseCheckout(repo, commit, run);
  } finally {
    await rm(lock, { recursive: true });
  }
}
if (import.meta.main)
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
