import { test, expect, afterEach, beforeEach } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import * as setup from "./setup";
import * as models from "./models";

const fixtures = resolve(import.meta.dir, "../../tests/fixtures/voice"),
  saved = process.env.XDG_CACHE_HOME,
  bun = dirname(process.execPath);
let dir = "",
  served: Record<string, Uint8Array<ArrayBuffer>> = {},
  requests: string[] = [],
  server: ReturnType<typeof Bun.serve>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "corgi-setup-"));
  process.env.XDG_CACHE_HOME = join(dir, "cache");
  requests = [];
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const name = new URL(request.url).pathname.slice(1);
      requests.push(name);
      return served[name] ? new Response(served[name]) : new Response("missing", { status: 404 });
    },
  });
});
afterEach(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
  if (saved === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = saved;
});
function entry(name: "base.en" | "filter", content: string, sha256?: string): models.Entry {
  const data = new TextEncoder().encode(content) as Uint8Array<ArrayBuffer>;
  served[name] = data;
  return {
    name,
    file: `ggml-${name}.bin`,
    url: `http://127.0.0.1:${server.port}/${name}`,
    bytes: data.length,
    sha256: sha256 ?? createHash("sha256").update(data).digest("hex"),
  };
}
async function report(entries: { model: models.Entry; filter: models.Entry }, path = `${fixtures}:${bun}`) {
  let out = "";
  const code = await setup.run({ model: "base.en" }, { write: text => (out += text), entries, path });
  return { code, out };
}

test("missing files are downloaded, verified and renamed into place", async () => {
  const entries = { model: entry("base.en", "model bytes"), filter: entry("filter", "filter bytes") };
  const { code, out } = await report(entries);
  expect(code).toBe(0);
  expect(out).toContain(`[ok] whisper-server ${fixtures}/whisper-server`);
  expect(out).toContain(`[ok] ffmpeg ${fixtures}/ffmpeg`);
  expect(out).toContain("downloading model base.en");
  expect(out).toContain("100%");
  expect(out).toContain("Voice is ready");
  expect(readFileSync(models.fileOf(entries.model), "utf8")).toBe("model bytes");
  expect(existsSync(models.fileOf(entries.model) + ".part")).toBe(false);
  expect(requests).toEqual(["base.en", "filter"]);
  // A second run has nothing to fetch.
  const again = await report(entries);
  expect(again.code).toBe(0);
  expect(again.out).not.toContain("downloading");
  expect(requests).toHaveLength(2);
});

test("a download that does not match its checksum is deleted", async () => {
  const entries = { model: entry("base.en", "model bytes", "0".repeat(64)), filter: entry("filter", "filter") };
  const { code, out } = await report(entries);
  expect(code).toBe(1);
  expect(out).toContain("[failed] model base.en: the download did not match its checksum");
  expect(existsSync(models.fileOf(entries.model))).toBe(false);
  expect(existsSync(models.fileOf(entries.model) + ".part")).toBe(false);
  expect(out).toContain("[ok] speech filter");
});

test("a download that cannot be written fails instead of hanging", async () => {
  const entries = { model: entry("base.en", "model bytes"), filter: entry("filter", "filter") },
    cache = dirname(models.fileOf(entries.model));
  mkdirSync(cache, { recursive: true });
  chmodSync(cache, 0o500);
  try {
    const { code, out } = await report(entries);
    expect(code).toBe(1);
    expect(out).toContain("[failed] model base.en: the download failed");
  } finally {
    chmodSync(cache, 0o755);
  }
  expect(existsSync(models.fileOf(entries.model) + ".part")).toBe(false);
});

test("missing tools are reported with how to install them", async () => {
  const entries = { model: entry("base.en", "m"), filter: entry("filter", "f") };
  const { code, out } = await report(entries, join(dir, "empty"));
  expect(code).toBe(1);
  expect(out).toContain(`[missing] whisper-server: install with ${setup.hint("whisper-server")}`);
  expect(out).toContain(`[missing] ffmpeg: install with ${setup.hint("ffmpeg")}`);
  expect(out).toContain("Voice is not ready");
});

test("a whisper-server without --vad is too old", async () => {
  const bin = join(dir, "bin"),
    old = join(bin, "whisper-server");
  mkdirSync(bin);
  writeFileSync(old, "#!/bin/sh\necho 'usage: whisper-server [options]'\n");
  chmodSync(old, 0o755);
  const entries = { model: entry("base.en", "m"), filter: entry("filter", "f") };
  const { code, out } = await report(entries, `${bin}:${fixtures}`);
  expect(code).toBe(1);
  expect(out).toContain(`[too old] whisper-server at ${old} has no --vad`);
});

test("install hints follow the platform", () => {
  expect(setup.hint("whisper-server", "macos")).toBe("brew install whisper-cpp");
  expect(setup.hint("ffmpeg", "macos")).toBe("brew install ffmpeg");
  expect(setup.hint("whisper-server", "arch")).toBe("sudo pacman -S whisper-cpp");
  expect(setup.hint("whisper-server", "debian")).toBe("sudo apt install whisper.cpp-tools");
  expect(setup.hint("whisper-server", "linux")).toContain("build whisper.cpp from source");
});
