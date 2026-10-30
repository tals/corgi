/** Build benchmark subjects from a separately frozen source/native tree. Never builds native code. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as benchmark from "./cpu_lock";

function option(name: string) {
  const index = process.argv.indexOf(`--${name}`),
    value = index < 0 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) throw Error(`Required --${name}`);
  return resolve(value);
}
const source = option("source"),
  native = option("native-root"),
  referencePath = option("reference"),
  out = option("out"),
  reference = JSON.parse(readFileSync(referencePath, "utf8")),
  bytecodeSplit = process.argv.includes("--bytecode-split"),
  sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const release = await benchmark.acquire();
try {
  if (reference.bunVersion !== Bun.version || reference.target !== "linux-x64" || reference.testBuild)
    throw Error("Require the reference Bun version, Linux x64 target, and production assets");
  const productHash = () => {
    const hash = createHash("sha256");
    for (const path of [...new Bun.Glob("{src,assets}/**/*").scanSync({ cwd: source, onlyFiles: true })].sort())
      hash.update(path).update(readFileSync(join(source, path)));
    return hash.digest("hex");
  };
  if (productHash() !== reference.sourceSHA256) throw Error("Frozen product source hash mismatch");
  const files = ["lib/libcorgi_term.so", "lib/libcorgi_system.so", "bin/pty-exec", "bin/corgi-hook"],
    nativeHash = createHash("sha256"),
    nativeFiles: Record<string, string> = {};
  for (const path of files) {
    const bytes = readFileSync(join(native, path));
    nativeHash.update(bytes);
    nativeFiles[path] = sha(bytes);
  }
  if (nativeHash.digest("hex") !== reference.nativeSHA256) throw Error("Frozen native asset hash mismatch");
  mkdirSync(out, { recursive: false });
  mkdirSync(join(out, "source"));
  for (const [name, path] of [
    ["builder.ts.fixture", import.meta.path],
    ["subject.ts.fixture", join(import.meta.dir, "viewer_memory_subject.ts")],
    ["production-build.ts.fixture", join(source, "build.ts")],
    ["package.json.fixture", join(source, "package.json")],
    ["bun.lock.fixture", join(source, "bun.lock")],
    ["frozen-inputs.json", join(source, "memory-frozen-inputs.json")],
  ])
    if (existsSync(path)) writeFileSync(join(out, "source", name), readFileSync(path));
  const subjectPath = join(import.meta.dir, "viewer_memory_subject.ts"),
    original = readFileSync(subjectPath, "utf8"),
    subject = original.replaceAll('"../../src/', JSON.stringify(source + "/src/").slice(0, -1)),
    start = subject.indexOf("// BEGIN APPLICATION MODES"),
    end = subject.indexOf("// END APPLICATION MODES");
  if (start < 0 || end < start) throw Error("Memory subject application boundary missing");
  const tiny =
      subject.slice(0, start) +
      'async function setup(): Promise<State> { if (mode !== "tiny") throw Error("TinyModeRequired"); return { details: {}, close() {} }; }\n' +
      subject.slice(end + "// END APPLICATION MODES".length),
    assets =
      files.map((path, i) => `import a${i} from ${JSON.stringify(join(native, path))} with {type:"file"};`).join("\n") +
      `\nexport const nativeFiles={${files.map((path, i) => `${JSON.stringify(path)}:a${i}`).join(",")}};` +
      `export const nativeHash=${JSON.stringify(reference.nativeSHA256)};export const testBuild=false;`,
    config = {
      releaseVersion: reference.releaseVersion,
      releaseCommit: reference.releaseCommit,
      builtAt: reference.builtAt,
      updateURL: "",
      updatePublicKey: "",
      sentryDSN: "",
    },
    configSource = Object.entries(config)
      .map(([key, value]) => `export const ${key}=${JSON.stringify(value)};`)
      .join("\n"),
    binaries: Record<string, { path: string; sha256: string }> = {};
  for (const [name, contents] of [
    ["subject", subject],
    ["tiny", tiny],
  ] as const) {
    const entry = join(out, `${name}.entry.ts`),
      outfile = join(out, name);
    writeFileSync(entry, contents);
    const result = await Bun.build({
      entrypoints: [
        entry,
        ...(name === "subject"
          ? [join(source, "src/providers/codex/files_worker.ts"), join(source, "src/trackers/resources_worker.ts")]
          : []),
      ],
      target: "bun",
      ...(bytecodeSplit ? { bytecode: true, splitting: true, format: "esm" as const } : {}),
      compile: { target: "bun-linux-x64", outfile },
      plugins: [
        {
          name: "memory-frozen-assets",
          setup(build) {
            build.onLoad({ filter: /\/build_assets\.ts$/ }, () => ({ contents: assets, loader: "ts" }));
            build.onLoad({ filter: /\/build_config\.ts$/ }, () => ({ contents: configSource, loader: "ts" }));
          },
        },
      ],
    });
    if (!result.success) throw new AggregateError(result.logs, "Memory subject build failed");
    binaries[name] = { path: outfile, sha256: sha(readFileSync(outfile)) };
  }
  if (productHash() !== reference.sourceSHA256) throw Error("Product source changed during memory build");
  for (const path of files)
    if (sha(readFileSync(join(native, path))) !== nativeFiles[path])
      throw Error("Native asset changed during memory build");
  writeFileSync(
    join(out, "build.json"),
    JSON.stringify(
      {
        kind: "initialized-viewer-memory-ladder",
        reference,
        source,
        native,
        nativeFiles,
        binaries,
        variant: bytecodeSplit ? "bytecode-split-esm" : "production-default",
        bundler_options: bytecodeSplit ? { bytecode: true, splitting: true, format: "esm" } : {},
        bun: { path: process.execPath, version: Bun.version, sha256: sha(readFileSync(process.execPath)) },
        inputs: {
          builder: sha(readFileSync(import.meta.path)),
          subject: sha(original),
          production_build: sha(readFileSync(join(source, "build.ts"))),
          reference: sha(readFileSync(referencePath)),
          package_json: sha(readFileSync(join(source, "package.json"))),
          bun_lock: sha(readFileSync(join(source, "bun.lock"))),
        },
        build_options:
          "Production target/compile/native-assets/testBuild=false; subject retains the same two worker entrypoints. Only the explicit bundler_options differ. No minification or GC changes. Tiny control intentionally contains no application code/assets/workers.",
        fixture_policy:
          "No PTY/provider/daemon. review_summaries.want read-ahead disabled. Stable idle agents, intensity0, badge none,160x48 host,132x47 pane. Ordinary allocation and GC settings.",
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await release();
}
