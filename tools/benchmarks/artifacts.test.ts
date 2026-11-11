import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as artifacts from "./artifacts";
import * as paths from "./paths";

const temporary: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
function directory(): string {
  const result = fs.mkdtempSync(path.join(os.tmpdir(), "corgi-artifacts-test-"));
  temporary.push(result);
  return result;
}
function bundle(root: string, contents = "measurement\n"): string {
  const source = path.join(root, "input");
  fs.mkdirSync(path.join(source, "evidence"), { recursive: true });
  fs.writeFileSync(path.join(source, "report.md"), "[Evidence](evidence/result.json)\n");
  fs.writeFileSync(path.join(source, "evidence/result.json"), contents);
  const output = path.join(root, "bundle");
  artifacts.archive("pack", source, output);
  const manifest = JSON.parse(fs.readFileSync(path.join(output, "manifest.json"), "utf8"));
  manifest.run = "test-run";
  fs.writeFileSync(path.join(output, "manifest.json"), JSON.stringify(manifest));
  return output;
}
function storage() {
  const objects = new Map<string, Uint8Array>();
  let corrupt = false;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const key = new URL(request.url).pathname;
      if (request.method === "PUT") {
        expect(request.headers.get("if-none-match")).toBe("*");
        if (objects.has(key)) return new Response(null, { status: 412 });
        objects.set(key, new Uint8Array(await request.arrayBuffer()));
        return new Response(null);
      }
      const body = objects.get(key);
      if (!body) return new Response(null, { status: 404 });
      return new Response(corrupt && key.endsWith(".gz") ? "corrupted" : new Uint8Array(body));
    },
  });
  servers.push(server);
  const client = new Bun.S3Client({
    bucket: "corgi-benchmarks",
    endpoint: server.url.toString(),
    region: "auto",
    accessKeyId: "test",
    secretAccessKey: "test",
  });
  return { client, objects, corrupt: () => (corrupt = true) };
}

test("publish and fetch preserve report links, bytes and permissions; identical retries work", async () => {
  const root = directory(),
    frozen = bundle(root),
    remote = storage();
  await artifacts.publish(remote.client, "test-run", frozen);
  await artifacts.publish(remote.client, "test-run", frozen);
  expect(remote.objects.size).toBe(2);
  const downloaded = path.join(root, "downloaded");
  await artifacts.fetchRun(remote.client, "test-run", downloaded);
  expect(fs.readFileSync(path.join(downloaded, "evidence/result.json"), "utf8")).toBe("measurement\n");
  expect(fs.readFileSync(path.join(downloaded, "report.md"), "utf8")).toContain("evidence/result.json");
  await expect(artifacts.fetchRun(remote.client, "test-run", downloaded)).rejects.toThrow("already exists");
});

test("a different run cannot overwrite an existing ID", async () => {
  const remote = storage();
  await artifacts.publish(remote.client, "test-run", bundle(directory()));
  const before = new Map(remote.objects);
  await expect(artifacts.publish(remote.client, "test-run", bundle(directory(), "different"))).rejects.toThrow(
    "checksum mismatch",
  );
  expect(remote.objects).toEqual(before);
});

test("failed read-back never publishes a completed manifest; corrupted downloads never extract", async () => {
  const root = directory(),
    frozen = bundle(root),
    remote = storage();
  remote.corrupt();
  await expect(artifacts.publish(remote.client, "test-run", frozen)).rejects.toThrow("checksum mismatch");
  expect([...remote.objects.keys()].some(key => key.endsWith("manifest.json"))).toBe(false);
  remote.objects.set(
    "/corgi-benchmarks/network/test-run/manifest.json",
    fs.readFileSync(path.join(frozen, "manifest.json")),
  );
  const downloaded = path.join(root, "downloaded");
  await expect(artifacts.fetchRun(remote.client, "test-run", downloaded)).rejects.toThrow("checksum or size mismatch");
  expect(fs.existsSync(downloaded)).toBe(false);
  expect(fs.readdirSync(root).filter(name => name.startsWith(".download-"))).toEqual([]);
});

test("paths reject the checkout, symlinks into it and invalid run IDs", () => {
  expect(() => paths.external(path.join(paths.repository, "dist/results"))).toThrow("outside the checkout");
  const link = path.join(directory(), "link");
  fs.symlinkSync(paths.repository, link);
  expect(() => paths.external(path.join(link, "results"))).toThrow("outside the checkout");
  const dangling = path.join(directory(), "dangling");
  fs.symlinkSync(path.join(paths.repository, "not-created"), dangling);
  expect(() => paths.external(dangling)).toThrow();
  for (const name of ["", "..", "../escape", "/absolute", "a/b"]) expect(() => artifacts.id(name)).toThrow();
});

test("S3 configuration cannot select the release bucket or expose malformed credentials", () => {
  const root = directory();
  const config = path.join(root, "config.json"),
    credentials = path.join(root, "credentials.json");
  const previous = process.env.CORGI_BENCHMARK_CONFIG;
  const access = process.env.AWS_ACCESS_KEY_ID,
    secret = process.env.AWS_SECRET_ACCESS_KEY;
  try {
    process.env.CORGI_BENCHMARK_CONFIG = config;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    fs.writeFileSync(credentials, JSON.stringify({ accessKeyId: "test", secretAccessKey: "test", bucket: "corgi" }));
    const value = { endpoint: "http://127.0.0.1:1", credentialsFile: credentials, bucket: "corgi-benchmarks" };
    fs.writeFileSync(config, JSON.stringify(value));
    expect(new URL(artifacts.client().file("probe").presign()).pathname).toBe("/corgi-benchmarks/probe");
    fs.writeFileSync(config, JSON.stringify({ ...value, bucket: "corgi" }));
    expect(() => artifacts.client()).toThrow("dedicated corgi-benchmarks bucket");
    fs.writeFileSync(config, JSON.stringify(value));
    fs.writeFileSync(credentials, "invalid-json-with-sensitive-value");
    expect(() => artifacts.client()).toThrow("Unable to read benchmark configuration or credentials");
  } finally {
    for (const [key, value] of [
      ["CORGI_BENCHMARK_CONFIG", previous],
      ["AWS_ACCESS_KEY_ID", access],
      ["AWS_SECRET_ACCESS_KEY", secret],
    ]) {
      if (value === undefined) delete process.env[key!];
      else process.env[key!] = value;
    }
  }
});

test("archives cannot extract traversal paths even with matching archive checksums", () => {
  const root = directory();
  const result = Bun.spawnSync([
    "python3",
    "-c",
    `import hashlib, io, json, pathlib, sys, tarfile
root = pathlib.Path(sys.argv[1])
archive = root / 'archive.tar.gz'
with tarfile.open(archive, 'w:gz') as output:
    entry = tarfile.TarInfo('../escaped')
    entry.size = 1
    output.addfile(entry, io.BytesIO(b'x'))
(root / 'manifest.json').write_text(json.dumps(dict(schema=1, files={}, archive=dict(bytes=archive.stat().st_size, sha256=hashlib.sha256(archive.read_bytes()).hexdigest()))))`,
    root,
  ]);
  expect(result.exitCode).toBe(0);
  expect(() => artifacts.archive("extract", root, path.join(root, "unpacked"))).toThrow("Unsafe archive path");
  expect(fs.existsSync(path.join(root, "escaped"))).toBe(false);
});

test("archive verification checks individual files, and refuses links", () => {
  const root = directory(),
    frozen = bundle(root),
    manifestFile = path.join(frozen, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  manifest.files["report.md"].sha256 = "0".repeat(64);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const extracted = path.join(root, "extracted");
  expect(() => artifacts.archive("extract", frozen, extracted)).toThrow("File manifest mismatch");
  expect(fs.existsSync(extracted)).toBe(false);
  fs.symlinkSync("report.md", path.join(root, "input/link"));
  expect(() => artifacts.archive("pack", path.join(root, "input"), path.join(root, "bad"))).toThrow(
    "Only regular files",
  );
});
