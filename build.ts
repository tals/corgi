import { basename } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
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
const nativeRoot = option(
  "native-root",
  buildTarget === `${process.platform}-${process.arch}`
    ? `${root}/native/zig-out`
    : `${root}/dist/native-${buildTarget}`,
);
if (!existsSync(`${root}/node_modules/@earendil-works/pi-tui`)) {
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
const args = [`${root}/scripts/zig`, "build", "--build-file", `${root}/native/build.zig`, "-Doptimize=ReleaseFast"];
// An explicit --target builds for the oldest systems a release supports, not this machine.
if (process.argv.slice(2).some(arg => arg === "--target" || arg.startsWith("--target=")))
  args.push(
    `-Dtarget=${arch === "arm64" ? "aarch64" : "x86_64"}-${platform === "darwin" ? "macos.13.0" : "linux-gnu.2.28"}`,
  );
args.push("--prefix", nativeRoot);
const sysroot = option("sysroot", process.env.CORGI_PROBE_SYSROOT ?? "");
if (sysroot) args.push("--sysroot", sysroot, `-Dsysroot=${sysroot}`);
if (!process.argv.includes("--no-native")) {
  const native = Bun.spawn(args, { stdout: "inherit", stderr: "inherit" });
  // Zig has already said why.
  const status = await native.exited;
  if (status) process.exit(status);
}
if (process.argv.includes("--native-only")) process.exit(0);
mkdirSync(`${root}/dist`, { recursive: true });
const suffix = platform === "darwin" ? "dylib" : "so";
const files = [`lib/libcorgi_term.${suffix}`, `lib/libcorgi_system.${suffix}`, "bin/pty-exec", "bin/corgi-hook"];
const hash = createHash("sha256");
for (const file of files) hash.update(new Uint8Array(await Bun.file(`${nativeRoot}/${file}`).arrayBuffer()));
const imports = files
  .map((file, i) => `import asset${i} from ${JSON.stringify(`${nativeRoot}/${file}`)} with {type:"file"};`)
  .join("\n");
const nativeHash = hash.digest("hex");
const assets = `${imports}\nexport const nativeFiles={${files.map((file, i) => `${JSON.stringify(file)}:asset${i}`).join(",")}};export const nativeHash=${JSON.stringify(nativeHash)};export const testBuild=${process.argv.includes("--test")};`;
const config = {
  releaseVersion: option("release-version", "0.1.0-dev"),
  releaseCommit: option("release-commit") || gitCommit(),
  updateURL: option("update-url"),
  updatePublicKey: option("update-public-key"),
  sentryDSN: option("sentry-dsn"),
};
const outfile = option(
  "outfile",
  `${root}/dist/${buildTarget === `${process.platform}-${process.arch}` ? "corgi" : `corgi-${buildTarget}`}${process.argv.includes("--test") ? "-test" : ""}`,
);
const sourceHash = createHash("sha256");
for (const path of [...new Bun.Glob("{src,assets}/**/*").scanSync({ cwd: root, onlyFiles: true })].sort())
  sourceHash.update(path).update(new Uint8Array(await Bun.file(`${root}/${path}`).arrayBuffer()));
const sourceSHA256 = sourceHash.digest("hex");
// The same inputs keep their first build's time, so the binary and the daemon's build id stay put.
const inputsSHA256 = createHash("sha256")
  .update(JSON.stringify([buildTarget, Bun.version, process.argv.includes("--test"), sourceSHA256, nativeHash, config]))
  .digest("hex");
const previous = await Bun.file(`${outfile}.build.json`)
  .json()
  .catch(() => null);
const builtAt =
  previous?.inputsSHA256 === inputsSHA256 && typeof previous.builtAt === "string"
    ? previous.builtAt
    : new Date().toISOString();
const configSource = Object.entries({ ...config, builtAt })
  .map(([key, value]) => `export const ${key}=${JSON.stringify(value)};`)
  .join("\n");
const result = await Bun.build({
  entrypoints: [
    `${root}/src/main.ts`,
    `${root}/src/providers/codex/files_worker.ts`,
    `${root}/src/trackers/resources_worker.ts`,
  ],
  target: "bun",
  compile: { target: `bun-${platform}-${arch}` as any, outfile },
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
const binaryHash = createHash("sha256")
  .update(new Uint8Array(await Bun.file(outfile).arrayBuffer()))
  .digest("hex");
await Bun.write(`${outfile}.sha256`, `${binaryHash}  ${basename(outfile)}\n`);
await Bun.write(
  `${outfile}.build.json`,
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
console.log(`Built ${outfile}`);
