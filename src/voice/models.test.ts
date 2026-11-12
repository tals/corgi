import { test, expect, afterEach } from "bun:test";
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as models from "./models";

const saved = { XDG_CACHE_HOME: process.env.XDG_CACHE_HOME, HOME: process.env.HOME };
afterEach(() => {
  for (const [key, value] of Object.entries(saved))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
});

test("the catalog names every model and pins each file", () => {
  expect(models.names).toEqual(["tiny.en", "base.en", "small.en", "medium", "large-v3-turbo"]);
  for (const entry of [...Object.values(models.catalog), models.filter]) {
    expect(entry.url.endsWith("/" + entry.file)).toBe(true);
    expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.bytes).toBeGreaterThan(0);
  }
  expect(models.catalog["base.en"].file).toBe("ggml-base.en.bin");
  expect(models.filter.file).toBe("ggml-silero-v6.2.0.bin");
});

test("parseName accepts only catalog names", () => {
  expect(models.parseName("small.en")).toBe("small.en");
  expect(models.parseName("large")).toBeNull();
  expect(models.parseName("")).toBeNull();
});

test("models live in the cache directory and count only at their full size", () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-models-"));
  try {
    process.env.XDG_CACHE_HOME = dir;
    expect(models.cacheDir()).toBe(join(dir, "corgi", "voice"));
    delete process.env.XDG_CACHE_HOME;
    process.env.HOME = dir;
    expect(models.cacheDir()).toBe(join(dir, ".cache", "corgi", "voice"));
    const entry = models.filter;
    expect(models.installed(entry)).toBe(false);
    mkdirSync(models.cacheDir(), { recursive: true });
    const fd = openSync(models.fileOf(entry), "w");
    ftruncateSync(fd, entry.bytes - 1);
    expect(models.installed(entry)).toBe(false);
    ftruncateSync(fd, entry.bytes);
    closeSync(fd);
    expect(models.installed(entry)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
