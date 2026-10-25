import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Quit } from "../../subprocess";
import { open } from "./launcher";

function withRoot(root: string, config: string | null): void {
  if (config === null) return;
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config", "config.yaml"), config);
}

test("Goose launcher reports its provider and model from config", async () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-goose-"));
  const prev = process.env.GOOSE_PATH_ROOT;
  process.env.GOOSE_PATH_ROOT = root;
  try {
    withRoot(root, "active_provider: ollama_cloud\nproviders:\n  ollama_cloud:\n    model: gemma4:31b\n");
    const launcher = open("");
    const info = await launcher.account(Quit.init(), 0);
    expect(info.signed_in).toBe(true);
    expect(info.account.text()).toBe("ollama_cloud");
    expect((await launcher.model("/tmp", Quit.init())).model).toBe("gemma4:31b");
    expect(launcher.watches?.()).toEqual([join(root, "config", "config.yaml")]);
    launcher.close();
  } finally {
    if (prev === undefined) delete process.env.GOOSE_PATH_ROOT;
    else process.env.GOOSE_PATH_ROOT = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Goose launcher reads the active provider's model, not the first", async () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-goose-"));
  const prev = process.env.GOOSE_PATH_ROOT;
  process.env.GOOSE_PATH_ROOT = root;
  try {
    withRoot(root, "active_provider: second\nproviders:\n  first:\n    model: one\n  second:\n    model: two\n");
    const launcher = open("");
    expect((await launcher.model("/tmp", Quit.init())).model).toBe("two");
    launcher.close();
  } finally {
    if (prev === undefined) delete process.env.GOOSE_PATH_ROOT;
    else process.env.GOOSE_PATH_ROOT = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Goose launcher without config reports unsigned", async () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-goose-"));
  const prev = process.env.GOOSE_PATH_ROOT;
  process.env.GOOSE_PATH_ROOT = root;
  try {
    withRoot(root, null);
    const launcher = open("");
    const info = await launcher.account(Quit.init(), 0);
    expect(info.signed_in).toBe(null);
    expect(info.account.text()).toBe("");
    expect((await launcher.model("/tmp", Quit.init())).model).toBe("");
    launcher.close();
  } finally {
    if (prev === undefined) delete process.env.GOOSE_PATH_ROOT;
    else process.env.GOOSE_PATH_ROOT = prev;
    rmSync(root, { recursive: true, force: true });
  }
});
