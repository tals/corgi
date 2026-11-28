import { test, expect } from "bun:test";
import { YAML } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import skill from "../assets/corgi-recall-skill.md" with { type: "text" };

function frontMatter(text: string): { name?: unknown; description?: unknown } {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  expect(match).not.toBeNull();
  return YAML.parse(match![1]!) as { name?: unknown; description?: unknown };
}

test("the recall skill's front matter names it and its triggers", () => {
  const { name, description } = frontMatter(skill);
  expect(name).toBe("corgi-recall");
  expect(typeof description).toBe("string");
  const text = String(description);
  expect(text).toMatch(/recall what an earlier or other agent session learned, decided or found/);
  expect(text).toMatch(/hand a task to the session that owns an area/);
});

test("the recall skill stays short", () => {
  expect(skill.trimEnd().split("\n").length).toBeLessThan(150);
});

test("the docs show how to install the recall skill", () => {
  const read = (file: string) => readFileSync(join(import.meta.dir, "..", file), "utf8");
  const reference = read("docs/reference.md");
  for (const command of [
    "corgi skill install recall",
    "corgi skill status",
    "corgi skill uninstall recall",
    "corgi skill show recall",
  ])
    expect(reference).toContain(command);
  expect(read("README.md")).toContain("`corgi skill install recall`");
});

test("the recall skill teaches search, reading, live checks, handover and safety", () => {
  for (const phrase of [
    "--workspace '*'",
    "--max-age all",
    "--tools",
    "--session",
    "corgi memory get",
    "untrusted",
    "corgi list --json",
    ".panes[]",
    ".headless_sessions[]",
    ".result.conversations",
    "NoPane",
    "CORGI_PANE",
    "CORGI_HEADLESS_ID",
    "confirm",
  ])
    expect(skill).toContain(phrase);
  // `memory search` counts hits toward MEMORY.md, so recall reads with `get` only.
  expect(skill).not.toContain("corgi memory search");
});
