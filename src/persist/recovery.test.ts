import { test, expect, spyOn } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  readdirSync,
  symlinkSync,
  statSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { atomicWrite } from "../os";
import { save as saveInference } from "../inference/setup";
import { install } from "../integration";
import { Runtime } from "../runtime";
import * as checkpoint from "./checkpoint";
import * as recovery from "./recovery";

test("atomic writes avoid stale temp collisions and preserve private permissions", () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-atomic-review-")),
    dest = join(root, "saved.json"),
    other = join(root, "unrelated");
  try {
    writeFileSync(other, "untouched");
    symlinkSync(other, `${dest}.tmp-${process.pid}`);
    atomicWrite(dest, "new state");
    expect(readFileSync(dest, "utf8")).toBe("new state");
    expect(readFileSync(other, "utf8")).toBe("untouched");
    expect(statSync(dest).mode & 0o777).toBe(0o600);
    expect(readdirSync(root).sort()).toEqual(["saved.json", "saved.json.tmp-" + process.pid, "unrelated"].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("failed atomic replacement removes only its own temporary file", () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-atomic-review-")),
    dest = join(root, "directory");
  try {
    mkdirSync(dest, { mode: 0o700 });
    expect(() => atomicWrite(dest, "state")).toThrow();
    expect(readdirSync(root)).toEqual(["directory"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("atomic writes reject an unsafe parent directory", () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-atomic-review-")),
    parent = join(root, "public");
  try {
    mkdirSync(parent, { mode: 0o755 });
    expect(() => atomicWrite(join(parent, "saved"), "state")).toThrow("UnsafeSocketDirectory");
    expect(readdirSync(parent)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("successful migrated recovery keeps its backup when the final rewrite fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-recovery-review-")),
    prior = process.env.XDG_STATE_HOME,
    r = new Runtime();
  process.env.XDG_STATE_HOME = root;
  const source = recovery.path(join(root, "control.sock")),
    bytes = readFileSync(new URL("../fixtures/steps/checkpoint-4.in.json", import.meta.url), "utf8");
  mkdirSync(dirname(source), { recursive: true, mode: 0o700 });
  writeFileSync(source, bytes, { mode: 0o600 });
  const restore = spyOn(checkpoint, "restore").mockImplementationOnce(async () => {
      rmSync(source);
      mkdirSync(source, { mode: 0o700 });
    }),
    error = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await recovery.load(r, join(root, "control.sock"), process.execPath)).toBe(true);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(readFileSync(source + ".v4", "utf8")).toBe(bytes);
    expect(error).toHaveBeenCalledTimes(1);
  } finally {
    restore.mockRestore();
    error.mockRestore();
    r.destroy();
    if (prior === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prior;
    rmSync(root, { recursive: true, force: true });
  }
});

test("inference settings preserve ordinary config directory permissions", () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-config-review-")),
    parent = join(root, "config");
  try {
    mkdirSync(parent, { mode: 0o755 });
    saveInference(join(parent, "choice.json"), "off");
    expect(JSON.parse(readFileSync(join(parent, "choice.json"), "utf8")).inference).toBe("off");
    expect(statSync(parent).mode & 0o777).toBe(0o755);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("hook settings preserve ordinary config directory and file permissions", async () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-config-review-")),
    parent = join(root, "claude"),
    prior = process.env.CLAUDE_CONFIG_DIR;
  try {
    mkdirSync(parent, { mode: 0o755 });
    process.env.CLAUDE_CONFIG_DIR = parent;
    const file = join(parent, "settings.json");
    writeFileSync(file, "{}", { mode: 0o644 });
    await install("claude");
    expect(JSON.parse(readFileSync(file, "utf8")).hooks).toBeDefined();
    expect(readFileSync(file + ".corgi-backup", "utf8")).toBe("{}");
    expect(statSync(file).mode & 0o777).toBe(0o644);
    expect(statSync(parent).mode & 0o777).toBe(0o755);
  } finally {
    if (prior === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prior;
    rmSync(root, { recursive: true, force: true });
  }
});
