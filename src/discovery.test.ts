import { test, expect } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as build_id from "./build_id";
import { installed, onPath, outdated, resolve as find } from "./discovery";
test("provider discovery follows current files, permissions and symlink targets", () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-discovery-")),
    command = join(root, "agent"),
    target = join(root, "target");
  try {
    expect(onPath("agent", root)).toBeNull();
    mkdirSync(command);
    expect(onPath("agent", root)).toBeNull();
    rmSync(command, { recursive: true });
    symlinkSync(target, command);
    expect(onPath("agent", root)).toBeNull();
    writeFileSync(target, "#!/bin/sh\n", { mode: 0o644 });
    expect(onPath("agent", root)).toBeNull();
    chmodSync(target, 0o755);
    expect(onPath("agent", root)).toBe(command);
    rmSync(target);
    expect(onPath("agent", root)).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("a bare provider name resolves past Corgi's own alias on PATH", () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-discovery-")),
    alias = join(root, "alias"),
    real = join(root, "real");
  try {
    const self = build_id.executablePath(
      import.meta.filename,
      process.execPath,
      resolve(import.meta.dir, "../corgi"),
      process.env.CORGI_APP_EXE,
    );
    mkdirSync(alias);
    mkdirSync(real);
    symlinkSync(self, join(alias, "claude"));
    expect(onPath("claude", alias)).toBeNull();
    writeFileSync(join(real, "claude"), "#!/bin/sh\n", { mode: 0o755 });
    expect(onPath("claude", `${alias}:${real}`)).toBe(join(real, "claude"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("an install too old for Corgi isn't installed once a probe turns it down", async () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-discovery-")),
    pi = join(root, "pi"),
    saved = { PATH: process.env.PATH, HOME: process.env.HOME, CORGI_PI_BIN: process.env.CORGI_PI_BIN };
  try {
    process.env.PATH = root;
    process.env.HOME = root;
    delete process.env.CORGI_PI_BIN;
    writeFileSync(pi, "#!/bin/sh\necho 0.84.2\n", { mode: 0o755 });
    expect(installed("pi")).toBe(true);
    await expect(find("pi")).rejects.toThrow("ProviderTooOld");
    expect(outdated("pi")).toBe("0.84.2");
    expect(installed("pi")).toBe(false);
    // An update is probed afresh.
    writeFileSync(pi, "#!/bin/sh\necho 1.20.0\n", { mode: 0o755 });
    expect(installed("pi")).toBe(true);
    expect(await find("pi")).toBe(pi);
    expect(outdated("pi")).toBeNull();
  } finally {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    rmSync(root, { recursive: true, force: true });
  }
});
