import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accounts } from "./accounts";

function dirWith(config: string | null): string {
  const root = mkdtempSync(join(tmpdir(), "corgi-goose-"));
  if (config !== null) writeFileSync(join(root, "config.yaml"), config);
  return root;
}

test("Goose identity is its configured provider", () => {
  const root = dirWith("GOOSE_PROVIDER: ollama_cloud\nGOOSE_MODEL: gemma4:31b\n");
  try {
    expect(accounts.identity(root)).toEqual({ email: "ollama_cloud", id: "goose:ollama_cloud" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Goose identity reads active_provider first", () => {
  const root = dirWith("active_provider: ollama_cloud\nproviders:\n  ollama_cloud:\n    model: gemma4:31b\n");
  try {
    expect(accounts.identity(root)).toEqual({ email: "ollama_cloud", id: "goose:ollama_cloud" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Goose identity accepts provider spellings and quotes", () => {
  const root = dirWith("provider: 'openai'\n");
  try {
    expect(accounts.identity(root)).toEqual({ email: "openai", id: "goose:openai" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Goose identity is null without a config or a provider", () => {
  const missing = dirWith(null);
  const empty = dirWith("plugins:\n  corgi:\n    enabled: true\n");
  try {
    expect(accounts.identity(missing)).toBe(null);
    expect(accounts.identity(empty)).toBe(null);
  } finally {
    rmSync(missing, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  }
});
