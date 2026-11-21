import * as ffi from "bun:ffi";
import * as path from "node:path";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as translations from "./scripts/translations";
import * as inputs from "./scripts/build_inputs";
const root = import.meta.dir;
function option(name: string, fallback = ""): string {
  const args = process.argv.slice(2),
    prefix = `--${name}=`,
    inline = args.find(arg => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(`--${name}`);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw Error(`Missing --${name} value`);
  return args[index + 1];
}
/** Development builds identify their checkout, marking uncommitted changes. */
function gitCommit(): string {
  const git = (...args: string[]) => Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "ignore" });
  const head = git("rev-parse", "HEAD");
  if (head.exitCode !== 0) return "development";
  const commit = head.stdout.toString().trim(),
    status = git("status", "--porcelain");
  return status.exitCode === 0 && status.stdout.toString().trim().length > 0 ? `${commit}-dirty` : commit;
}
const buildTarget = option("target", `${process.platform}-${process.arch}`),
  [platform, arch] = buildTarget.split("-");
if (!["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64"].includes(buildTarget))
  throw Error(`Unsupported target: ${buildTarget}`);
const incremental = process.argv.includes("--incremental");
const explicitTarget = process.argv.slice(2).some(arg => arg === "--target" || arg.startsWith("--target="));
const nativeRoot = option(
  "native-root",
  buildTarget === `${process.platform}-${process.arch}`
    ? `${root}/native/zig-out`
    : `${root}/dist/native-${buildTarget}`,
);
if (!fs.existsSync(`${root}/node_modules/@earendil-works/pi-tui`)) {
  const install = Bun.spawn([process.execPath, "install", "--frozen-lockfile"], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (await install.exited) throw Error("TUI dependency install failed");
  // This process can't resolve packages installed after it started: build again in a new one.
  const again = Bun.spawn([process.execPath, ...process.argv.slice(1)], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  process.exit(await again.exited);
}
// After the install above, so a fresh checkout reports once, and before the native build, which a
// failure skips. Locally it may regenerate src/i18n.generated.ts; its report prints on any exit.
const outfile = option(
  "outfile",
  `${root}/dist/${buildTarget === `${process.platform}-${process.arch}` ? "corgi" : `corgi-${buildTarget}`}${process.argv.includes("--test") ? "-test" : ""}`,
);
// Serialize writers of the same native files or executable. Unrelated targets can build together.
const locks = `${root}/dist/.build-locks`;
fs.mkdirSync(locks, { recursive: true });
const lockSymbols = { flock: { args: ["i32", "i32"], returns: "i32" } } as const;
function buildLock() {
  if (process.platform === "darwin") return ffi.dlopen("/usr/lib/libSystem.B.dylib", lockSymbols);
  try {
    return ffi.dlopen("libc.so.6", lockSymbols);
  } catch {
    return ffi.dlopen("libc.so", lockSymbols); // musl
  }
}
const { flock } = buildLock().symbols;
for (const resource of [...new Set([path.resolve(nativeRoot), path.resolve(outfile)])].sort()) {
  const name = crypto.createHash("sha256").update(resource).digest("hex");
  const fd = fs.openSync(`${locks}/${name}`, "a", 0o600);
  // LOCK_EX | LOCK_NB first, so the launcher can show why this build is waiting.
  if (flock(fd, 6) === 0) continue;
  process.stderr.write(`Waiting for another build of ${resource}…\n`);
  process.send?.("queued");
  if (flock(fd, 2) !== 0) throw Error("Could not lock build output: " + resource);
}
process.once("SIGTERM", () => process.exit(143));
process.once("SIGINT", () => process.exit(130));
const translated = await translations.verify();
process.on("exit", () => process.stderr.write(translated.text));
if (translated.code) process.exit(translated.code);
const sourceSHA256 = inputs.source(root);
const expectedSource = option("expected-source");
if (expectedSource && sourceSHA256 !== expectedSource)
  throw Error("Checkout changed. Restart ./go.ts to build this revision.");
if (!process.argv.includes("--no-native")) {
  const args = [`${root}/scripts/zig`, "build", "--build-file", `${root}/native/build.zig`, "-Doptimize=ReleaseFast"];
  // An explicit --target builds for the oldest systems a release supports, not this machine.
  if (explicitTarget)
    args.push(
      `-Dtarget=${arch === "arm64" ? "aarch64" : "x86_64"}-${platform === "darwin" ? "macos.13.0" : "linux-gnu.2.28"}`,
    );
  args.push("--prefix", nativeRoot);
  const sysroot =
    option("sysroot", process.env.CORGI_PROBE_SYSROOT ?? "") ||
    (platform === "darwin" && explicitTarget ? inputs.macosSdk(root) : "");
  if (sysroot) args.push("--sysroot", sysroot, `-Dsysroot=${sysroot}`);
  const nativeKey = inputs.native(root, buildTarget, explicitTarget, sysroot);
  const nativeCache = await Bun.file(`${nativeRoot}/.corgi-build.json`)
    .json()
    .catch(() => null);
  let nativeValid = false;
  try {
    nativeValid = nativeCache?.input === nativeKey && nativeCache?.output === inputs.nativeOutput(nativeRoot, platform);
  } catch {}
  if (!(incremental && nativeValid)) {
    process.send?.("Compiling native code with Zig");
    process.stderr.write(`Building native code for ${buildTarget}…\n`);
    const native = Bun.spawn(args, { stdout: "inherit", stderr: "inherit" });
    // Zig has already said why.
    const status = await native.exited;
    if (status) process.exit(status);
    await Bun.write(
      `${nativeRoot}/.corgi-build.json`,
      JSON.stringify({ input: nativeKey, output: inputs.nativeOutput(nativeRoot, platform) }),
    );
  } else {
    process.stderr.write(`Using cached native code for ${buildTarget}.\n`);
  }
}
if (process.argv.includes("--native-only")) process.exit(0);
fs.mkdirSync(`${root}/dist`, { recursive: true });
const files = inputs.files(platform);
const hash = crypto.createHash("sha256");
for (const file of files) hash.update(new Uint8Array(await Bun.file(`${nativeRoot}/${file}`).arrayBuffer()));
const imports = files
  .map((file, i) => `import asset${i} from ${JSON.stringify(`${nativeRoot}/${file}`)} with {type:"file"};`)
  .join("\n");
const nativeHash = hash.digest("hex");
const assets = `${imports}\nexport const nativeFiles={${files.map((file, i) => `${JSON.stringify(file)}:asset${i}`).join(",")}};export const nativeHash=${JSON.stringify(nativeHash)};export const testBuild=${process.argv.includes("--test")};`;
const releaseVersion = option("release-version"),
  releaseCommit = option("release-commit");
const config = {
  releaseVersion: releaseVersion || "0.1.0-dev",
  releaseCommit: releaseCommit || gitCommit(),
  updateURL: option("update-url"),
  updatePublicKey: option("update-public-key"),
  sentryDSN: option("sentry-dsn"),
};
// The same inputs keep their first build's time, so the binary and the daemon's build id stay put.
// The Git label on an ordinary dev build describes when it was compiled.
const cacheConfig = releaseVersion || releaseCommit ? config : { ...config, releaseCommit: "" };
const inputsSHA256 = crypto
  .createHash("sha256")
  .update(
    JSON.stringify([buildTarget, Bun.version, process.argv.includes("--test"), sourceSHA256, nativeHash, cacheConfig]),
  )
  .digest("hex");
const previous = await Bun.file(`${outfile}.build.json`)
  .json()
  .catch(() => null);
if (
  incremental &&
  previous?.inputsSHA256 === inputsSHA256 &&
  fs.existsSync(outfile) &&
  previous.sha256 ===
    crypto
      .createHash("sha256")
      .update(new Uint8Array(await Bun.file(outfile).arrayBuffer()))
      .digest("hex")
) {
  process.stderr.write(`Using cached Corgi for ${buildTarget}.\n`);
  process.exit(0);
}
const builtAt =
  previous?.inputsSHA256 === inputsSHA256 && typeof previous.builtAt === "string"
    ? previous.builtAt
    : new Date().toISOString();
const configSource = Object.entries({ ...config, builtAt, sourceHash: sourceSHA256 })
  .map(([key, value]) => `export const ${key}=${JSON.stringify(value)};`)
  .join("\n");
// Readers keep the old inode until the complete replacement is published.
fs.mkdirSync(path.dirname(outfile), { recursive: true });
const staging = fs.mkdtempSync(`${outfile}.build-`);
process.on("exit", () => fs.rmSync(staging, { recursive: true, force: true }));
const candidate = `${staging}/${path.basename(outfile)}`;
process.send?.("Compiling the Corgi executable with Bun");
process.stderr.write(`Building Corgi for ${buildTarget}…\n`);
const result = await Bun.build({
  entrypoints: [
    `${root}/src/entry.ts`,
    `${root}/src/main.ts`,
    `${root}/src/providers/codex/files_worker.ts`,
    `${root}/src/trackers/resources_worker.ts`,
  ],
  target: "bun",
  compile: { target: `bun-${platform}-${arch}` as any, outfile: candidate },
  plugins: [
    {
      name: "native-assets",
      setup(build) {
        build.onLoad({ filter: /\/build_assets\.ts$/ }, () => ({ contents: assets, loader: "ts" }));
        build.onLoad({ filter: /\/build_config\.ts$/ }, () => ({ contents: configSource, loader: "ts" }));
      },
    },
  ],
});
if (!result.success) throw new AggregateError(result.logs, "Bun compile failed");
if (inputs.source(root) !== sourceSHA256 || (releaseVersion && !releaseCommit && gitCommit() !== config.releaseCommit))
  throw Error("Sources changed during the build; run it again.");
const binaryHash = crypto
  .createHash("sha256")
  .update(new Uint8Array(await Bun.file(candidate).arrayBuffer()))
  .digest("hex");
await Bun.write(`${candidate}.sha256`, `${binaryHash}  ${path.basename(outfile)}\n`);
await Bun.write(
  `${candidate}.build.json`,
  JSON.stringify(
    {
      builtAt,
      target: buildTarget,
      bunVersion: Bun.version,
      testBuild: process.argv.includes("--test"),
      releaseVersion: config.releaseVersion,
      releaseCommit: config.releaseCommit,
      sha256: binaryHash,
      sourceSHA256,
      nativeSHA256: nativeHash,
      inputsSHA256,
    },
    null,
    2,
  ) + "\n",
);
for (const suffix of ["", ".sha256", ".build.json"]) fs.renameSync(candidate + suffix, outfile + suffix);
console.log(`Built ${outfile}`);
