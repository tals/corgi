import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as paths from "./paths";

interface Config {
  endpoint: string;
  region?: string;
  bucket?: string;
  credentialsFile?: string;
}
interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}
interface Manifest {
  schema: number;
  run: string;
  source: { revision: string; dirty: boolean };
  archive: { bytes: number; sha256: string };
  files: Record<string, { bytes: number; sha256: string; mode: number }>;
}

const expand = (name: string) => (name.startsWith("~/") ? path.join(os.homedir(), name.slice(2)) : name);
const bucket = "corgi-benchmarks";

function readConfig<T>(filename: string): T {
  try {
    return JSON.parse(fs.readFileSync(expand(filename), "utf8"));
  } catch {
    throw Error("Unable to read benchmark configuration or credentials; see ARTIFACTS.md");
  }
}

export function id(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) throw Error("Invalid benchmark run ID");
  return value;
}

export function client(): Bun.S3Client {
  const dedicated = process.env.CORGI_BENCHMARK_CONFIG ?? path.join(os.homedir(), ".config/corgi/benchmarks.json");
  const filename =
    process.env.CORGI_BENCHMARK_CONFIG || fs.existsSync(dedicated)
      ? dedicated
      : (process.env.CORGI_RELEASE_CONFIG ?? path.join(os.homedir(), ".config/corgi/release.json"));
  const config = readConfig<Config>(filename);
  if (filename === dedicated && config.bucket && config.bucket !== bucket)
    throw Error(`Benchmark storage must use the dedicated ${bucket} bucket`);
  const credentials =
    process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
      ? {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          sessionToken: process.env.AWS_SESSION_TOKEN,
        }
      : readConfig<Credentials>(config.credentialsFile ?? "");
  if (!config.endpoint || !credentials.accessKeyId || !credentials.secretAccessKey)
    throw Error("Benchmark endpoint and credentials are required; see ARTIFACTS.md");
  return new Bun.S3Client({
    endpoint: config.endpoint,
    region: config.region ?? "auto",
    bucket,
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
  });
}

export async function checksum(stream: ReadableStream<Uint8Array>): Promise<string> {
  const hash = new Bun.CryptoHasher("sha256");
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

export function archive(operation: "pack" | "verify" | "extract", ...args: string[]): void {
  const result = Bun.spawnSync(["python3", path.join(import.meta.dir, "artifact_archive.py"), operation, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode) throw Error(`Archive ${operation} failed:\n${result.stderr.toString()}`);
}

async function request(file: Bun.S3File, method: "GET" | "PUT", body?: Bun.BunFile): Promise<Response> {
  try {
    return await fetch(file.presign({ method, expiresIn: 3600 }), {
      method,
      body,
      headers: method === "PUT" ? { "If-None-Match": "*" } : undefined,
      signal: AbortSignal.timeout(30 * 60 * 1000),
    });
  } catch {
    // Fetch errors can include a credential-bearing presigned URL.
    throw Error(`R2 ${method} failed; check network access and benchmark storage configuration`);
  }
}

export async function putVerified(store: Bun.S3Client, key: string, filename: string): Promise<void> {
  const local = Bun.file(filename);
  if (local.size > 5 * 1024 ** 3) throw Error("Bundle exceeds 5 GiB; split it into smaller runs");
  const expected = await checksum(local.stream());
  const remote = store.file(key);
  const written = await request(remote, "PUT", local);
  await written.body?.cancel();
  if (!written.ok && written.status !== 412) throw Error(`R2 PUT ${key}: HTTP ${written.status}`);
  const read = await request(remote, "GET");
  if (!read.ok || !read.body) throw Error(`R2 GET ${key}: HTTP ${read.status}`);
  if ((await checksum(read.body)) !== expected)
    throw Error(`R2 checksum mismatch at ${key}; existing objects are never overwritten`);
}

export async function publish(store: Bun.S3Client, run: string, bundle: string): Promise<void> {
  id(run);
  archive("verify", bundle);
  const manifest: Manifest = JSON.parse(fs.readFileSync(path.join(bundle, "manifest.json"), "utf8"));
  if (manifest.run !== run) throw Error("Manifest run ID mismatch");
  const prefix = `network/${run}`;
  await putVerified(store, `${prefix}/archive.tar.gz`, path.join(bundle, "archive.tar.gz"));
  // A manifest is the completion record. List only runs that have one.
  await putVerified(store, `${prefix}/manifest.json`, path.join(bundle, "manifest.json"));
}

async function download(store: Bun.S3Client, key: string, filename: string): Promise<void> {
  const response = await request(store.file(key), "GET");
  if (!response.ok) throw Error(`R2 GET ${key}: HTTP ${response.status}`);
  await Bun.write(filename, response);
}

export async function fetchRun(store: Bun.S3Client, run: string, destination: string): Promise<void> {
  id(run);
  destination = paths.external(destination);
  if (fs.existsSync(destination)) throw Error(`Destination already exists: ${destination}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = fs.mkdtempSync(path.join(path.dirname(destination), ".download-"));
  try {
    await download(store, `network/${run}/manifest.json`, path.join(temporary, "manifest.json"));
    const manifest: Manifest = JSON.parse(fs.readFileSync(path.join(temporary, "manifest.json"), "utf8"));
    if (manifest.run !== run || manifest.schema !== 1) throw Error("Invalid remote manifest");
    await download(store, `network/${run}/archive.tar.gz`, path.join(temporary, "archive.tar.gz"));
    archive("extract", temporary, destination);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

async function main(args: string[]): Promise<void> {
  const [command, value, extra] = args;
  if (!command || command === "--help") {
    console.log(`Usage: bun tools/benchmarks/artifacts.ts
  new LABEL                   create a fresh run directory outside the checkout
  pack RUN_DIRECTORY          freeze a completed run into the local archive cache
  publish RUN_ID              upload the frozen bundle and verify its bytes
  list                        list completed runs in R2 (the results index)
  fetch RUN_ID [DESTINATION]   download and verify into a fresh cache directory`);
    return;
  }
  if (command === "new") {
    const directory = paths.run(id(value ?? "network"));
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    console.log(directory);
    return;
  }
  if (command === "pack") {
    if (!value) throw Error("pack requires a run directory");
    const directory = paths.external(value);
    const run = id(path.basename(directory));
    const parent = path.join(paths.cache(), ".archives");
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const bundle = path.join(parent, run);
    if (fs.existsSync(bundle)) throw Error(`Frozen bundle already exists: ${bundle}; use a new run ID`);
    const temporary = fs.mkdtempSync(path.join(parent, ".pack-"));
    try {
      const stage = path.join(temporary, "bundle");
      archive("pack", directory, stage);
      const git = (...flags: string[]) => {
        const result = Bun.spawnSync(["git", ...flags], { cwd: paths.repository });
        if (result.exitCode) throw Error("Unable to record source revision");
        return result.stdout.toString().trim();
      };
      const manifest: Manifest = JSON.parse(fs.readFileSync(path.join(stage, "manifest.json"), "utf8"));
      manifest.run = run;
      manifest.source = { revision: git("rev-parse", "HEAD"), dirty: !!git("status", "--porcelain") };
      fs.writeFileSync(path.join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
      fs.renameSync(stage, bundle);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
    console.log(bundle);
    return;
  }
  const store = client();
  switch (command) {
    case "publish": {
      const run = id(value ?? "");
      await publish(store, run, path.join(paths.cache(), ".archives", run));
      console.log(`Verified s3://${bucket}/network/${run}/manifest.json`);
      break;
    }
    case "fetch": {
      const run = id(value ?? "");
      const destination = paths.external(extra ?? path.join(paths.cache(), run));
      await fetchRun(store, run, destination);
      console.log(destination);
      break;
    }
    case "list": {
      let continuationToken: string | undefined;
      do {
        let page: Bun.S3ListObjectsResponse;
        try {
          page = await store.list({ prefix: "network/", continuationToken });
        } catch {
          throw Error("R2 list failed; grant read/write access to corgi-benchmarks (see ARTIFACTS.md)");
        }
        for (const object of page.contents ?? [])
          if (/^network\/[^/]+\/manifest\.json$/.test(object.key)) console.log(`s3://${bucket}/${object.key}`);
        continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
      } while (continuationToken);
      break;
    }
    default:
      throw Error("Unknown command; use --help");
  }
}

if (import.meta.main)
  main(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : "Benchmark artifact command failed");
    process.exitCode = 1;
  });
