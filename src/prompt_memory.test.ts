import { afterEach, beforeEach, expect, test } from "bun:test";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as accounts from "./accounts";
import { Memory, caps } from "./prompt_memory";
import { flock } from "./native_bridge";

let base = "";
let memory: Memory;
const now = new Date(2026, 9, 30, 9, 15);
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "corgi-memory-"));
  memory = new Memory(join(base, "memory"));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));
const write = (name: string, text: string) => {
  mkdirSync(join(memory.dir, name, ".."), { recursive: true });
  writeFileSync(join(memory.dir, name), text);
};
const read = (name: string) => readFileSync(join(memory.dir, name), "utf8");

test("all memory writers leave files alone while another writer holds the lock", () => {
  write("MEMORY.md", "- held\n");
  const file = join(memory.dir, "MEMORY.md"),
    fd = openSync(join(memory.dir, ".write.lock"), "a");
  try {
    expect(flock(fd)).toBe(true);
    for (const write of [
      () => memory.append(file, "new"),
      () => memory.add("new", "long", now),
      () => memory.edit(file, 0, "held", "changed"),
      () => memory.forgetLine("MEMORY.md", 1),
      () => memory.strike([{ file, line: "- held" }]),
      () => memory.dream(now),
      () => memory.recall([{ file: "2026-10-30.md", line: 1, text: "held" }], now),
    ])
      expect(write).toThrow("MemoryBusy");
    expect(read("MEMORY.md")).toBe("- held\n");
  } finally {
    closeSync(fd);
  }
  memory.append(file, "new");
  expect(read("MEMORY.md")).toBe("- held\n- new\n");
});

test("a failed move leaves its original line intact", () => {
  write("MEMORY.md", "- original\n");
  writeFileSync(join(memory.dir, "workspaces"), "not a directory");
  expect(() =>
    memory.add("moved", { workspace: "project" }, now, { file: "MEMORY.md", line: 1, moved: true }),
  ).toThrow();
  expect(read("MEMORY.md")).toBe("- original\n");
});

test("erasing a log line also removes only its unchanged promoted copy", () => {
  const wrote = [memory.add("first", "today", now), memory.add("second", "today", now)].map(w => ({
    file: w.path,
    line: w.text,
  }));
  const other = new Memory(memory.dir);
  for (const d of [28, 29, 30]) other.recall(other.search("first second"), new Date(2026, 9, d));
  expect(other.dream(now)).toEqual(["second", "first"]);
  expect(other.edit(join(memory.dir, "MEMORY.md"), 0, "second", "second edited by user")).toBe(true);
  expect(memory.strike(wrote)).toEqual([]);
  expect(read("MEMORY.md")).toBe("- second edited by user\n");
  expect(other.dream(now)).toEqual([]);
  expect(other.search("first")).toEqual([]);
});
/** Sets a file's modification time to local `date`. */

test("the root sits beside accounts.json", () => {
  expect(Memory.root()).toBe(join(dirname(accounts.path()), "memory"));
});

test("daily logs are named by local date", () => {
  expect(memory.today(now)).toBe(join(memory.dir, "2026-10-30.md"));
  expect(memory.today(new Date(2026, 0, 2, 23, 59))).toBe(join(memory.dir, "2026-01-02.md"));
});

test("append adds a bullet, making folders and finishing an open last line", () => {
  const long = join(memory.dir, "MEMORY.md"),
    today = memory.today(now);
  expect(memory.append(long, "Runs tests with bun, never npm.")).toEqual({
    file: long,
    line: "- Runs tests with bun, never npm.",
  });
  expect(memory.append(long, "- CI runs unit tests\n  in parallel")).toEqual({
    file: long,
    line: "- CI runs unit tests in parallel",
  });
  expect(read("MEMORY.md")).toBe("- Runs tests with bun, never npm.\n- CI runs unit tests in parallel\n");
  write("2026-10-30.md", "# Thursday\n- open line");
  expect(memory.append(today, "picked Opus for the prompt").file).toBe(today);
  expect(read("2026-10-30.md")).toBe("# Thursday\n- open line\n- picked Opus for the prompt\n");
  expect(memory.append(today, "   ")).toEqual({ file: today, line: "" });
  expect(read("2026-10-30.md")).toEndWith("prompt\n");
});

test("load reads MEMORY.md, yesterday, today and the workspace note under headings", () => {
  write("MEMORY.md", "# Memory\n\n- Runs tests with bun.\n");
  write("2026-10-28.md", "- too old to load\n");
  write("2026-10-29.md", "- splitter: heavy rule picked\n");
  write("2026-10-30.md", "- sidebar test flakes on CI\n");
  write("workspaces/corgi.md", "- main is the only branch\n");
  const loaded = memory.load("corgi", now);
  expect(loaded.files).toEqual([
    { name: "MEMORY.md", lines: 2 },
    { name: "2026-10-29.md", lines: 1 },
    { name: "2026-10-30.md", lines: 1 },
    { name: "workspaces/corgi.md", lines: 1 },
  ]);
  expect(loaded.text).toBe(
    [
      "## MEMORY.md\n# Memory\n- Runs tests with bun.",
      "## 2026-10-29 (yesterday)\n- splitter: heavy rule picked",
      "## 2026-10-30 (today)\n- sidebar test flakes on CI",
      "## Workspace corgi\n- main is the only branch",
    ].join("\n\n"),
  );
  expect(memory.load(null, now).files.map(f => f.name)).toEqual(["MEMORY.md", "2026-10-29.md", "2026-10-30.md"]);
  expect(new Memory(join(base, "missing")).load("corgi", now)).toEqual({ text: "", files: [] });
});

test("yesterday crosses month and year boundaries", () => {
  write("2025-12-31.md", "- new year's eve\n");
  expect(memory.load(null, new Date(2026, 0, 1, 8)).files).toEqual([{ name: "2025-12-31.md", lines: 1 }]);
});

test("each file loads capped, oldest whole lines dropped first, and says how many didn't fit", () => {
  const lines = Array.from({ length: 2000 }, (_, i) => `- note ${String(i).padStart(4, "0")}`);
  write("MEMORY.md", lines.join("\n"));
  write("2026-10-30.md", lines.join("\n"));
  write("workspaces/corgi.md", lines.join("\n"));
  const loaded = memory.load("corgi", now);
  const sections = loaded.text.split("\n\n").map(s => s.split("\n").slice(1));
  for (const [section, cap] of [
    [sections[0], caps.long],
    [sections[1], caps.day],
    [sections[2], caps.workspace],
  ] as const) {
    expect(section.at(-1)).toBe("- note 1999");
    expect(Buffer.byteLength(section.join("\n")) + 1).toBeLessThanOrEqual(cap);
    expect(Buffer.byteLength(section.join("\n")) + 1 + 12).toBeGreaterThan(cap);
    expect(section.every(line => /^- note \d{4}$/.test(line))).toBe(true);
  }
  expect(loaded.text.split("\n")[0]).toBe(
    `## MEMORY.md (${2000 - sections[0].length} older lines not loaded; search for them)`,
  );
  expect(loaded.files[2]).toEqual({ name: "workspaces/corgi.md", lines: sections[2].length });
  write("2026-10-29.md", "é".repeat(5000));
  const long = memory.load(null, now).text.split("\n\n")[1].split("\n")[1];
  expect(Buffer.byteLength(long)).toBeLessThanOrEqual(caps.day - 1);
  expect(long).toMatch(/^é+$/);
});

test("workspace names can't leave the workspaces folder", () => {
  write("workspaces/..-etc.md", "- slashes become dashes\n");
  expect(memory.load("../etc", now).files).toEqual([]);
  write("workspaces/a-b.md", "- found\n");
  expect(memory.load("a/b", now).files).toEqual([{ name: "workspaces/a-b.md", lines: 1 }]);
  expect(memory.load("...", now).files).toEqual([]);
});

test("instructions carry the persona, memory, context and where to write", () => {
  const text = memory.instructions("## MEMORY.md\n- Runs tests with bun.", "Focused pane: Fix sidebar flicker", now);
  expect(text).toStartWith("You are Corgi, a terse, helpful assistant living in the user's terminal multiplexer.");
  expect(text).toContain("Today is 2026-10-30.");
  expect(text).toContain("# Memory\n\n## MEMORY.md\n- Runs tests with bun.");
  expect(text).toContain("# Context\n\nFocused pane: Fix sidebar flicker");
  // OpenClaw's: recall searches first; what's asked to be remembered goes to
  // today's log; MEMORY.md is curated.
  expect(text).toContain(`Your memory is Markdown in ${memory.dir}`);
  expect(text).toContain("# Memory Recall\n");
  expect(text).toContain("run `corgi memory search <words>`; for hits, use `corgi memory get FILE:LINE`");
  expect(text).toContain('add it to today\'s log with `corgi memory add "<one self-contained line>"`');
  expect(text).toContain("MEMORY.md is curated: change it (`--long`) only when the user asks you to curate memory.");
  expect(text).toContain("`--replaces FILE:LINE`");
  expect(memory.instructions("", "", now)).not.toContain("# Memory\n");
});

test("strike drops each written line once, from its own file, only as written", () => {
  write("2026-10-30.md", "- a\n- b\n- a\n- c edited by hand\n");
  write("MEMORY.md", "- b\n");
  const today = join(memory.dir, "2026-10-30.md"),
    long = join(memory.dir, "MEMORY.md");
  const missed = memory.strike([
    { file: today, line: "- a" },
    { file: today, line: "- b" },
    { file: today, line: "- c" },
    { file: long, line: "- missing" },
    { file: join(base, "outside.md"), line: "- a" },
  ]);
  expect(read("2026-10-30.md")).toBe("- a\n- c edited by hand\n");
  expect(read("MEMORY.md")).toBe("- b\n");
  expect(missed).toEqual([
    { file: today, line: "- c" },
    { file: long, line: "- missing" },
    { file: join(base, "outside.md"), line: "- a" },
  ]);
  expect(memory.strike([])).toEqual([]);
});

test("inside follows links before comparing", () => {
  mkdirSync(memory.dir, { recursive: true });
  expect(memory.inside(join(memory.dir, "2026-10-30.md"))).toBe(true);
  expect(memory.inside(join(memory.dir, "workspaces", "new", "x.md"))).toBe(true);
  expect(memory.inside(memory.dir)).toBe(true);
  expect(memory.inside(join(memory.dir, "..", "accounts.json"))).toBe(false);
  expect(memory.inside(join(base, "memory-other", "x.md"))).toBe(false);
  mkdirSync(join(base, "outside"));
  symlinkSync(join(base, "outside"), join(memory.dir, "escape"));
  expect(memory.inside(join(memory.dir, "escape", "x.md"))).toBe(false);
  symlinkSync(memory.dir, join(base, "alias"));
  expect(memory.inside(join(base, "alias", "MEMORY.md"))).toBe(true);
  expect(new Memory(join(base, "alias")).inside(join(memory.dir, "MEMORY.md"))).toBe(true);
});

test("a log line searches keep finding moves to MEMORY.md, as OpenClaw's dreaming does", () => {
  write("MEMORY.md", "- Prefers bun\n");
  write("2026-10-28.md", "- Deploys go out on Thursdays\n- Tried npm once\n");
  const hit = { file: "2026-10-28.md", line: 1, text: "Deploys go out on Thursdays" },
    once = { file: "2026-10-28.md", line: 2, text: "Tried npm once" };
  // Three recalls on one day aren't enough; a second day makes it.
  memory.recall([hit, once], now);
  memory.recall([hit], now);
  memory.recall([hit], now);
  expect(memory.dream(now)).toEqual([]);
  memory.recall([hit], new Date(2026, 9, 31, 9));
  expect(memory.dream(new Date(2026, 9, 31, 10))).toEqual(["Deploys go out on Thursdays"]);
  expect(read("MEMORY.md")).toBe("- Prefers bun\n- Deploys go out on Thursdays\n");
  // Moved once; MEMORY.md's own lines aren't counted.
  memory.recall([{ file: "MEMORY.md", line: 2, text: "Deploys go out on Thursdays" }], now);
  expect(memory.dream(now)).toEqual([]);
  expect(read("MEMORY.md")).toBe("- Prefers bun\n- Deploys go out on Thursdays\n");
});

test("a line edited since it was recalled stays, and moved lines stay under a cap, oldest first out", () => {
  write("2026-10-28.md", "- edited since\n");
  const stale = { file: "2026-10-28.md", line: 1, text: "was this" };
  for (const d of [28, 29, 30]) memory.recall([stale], new Date(2026, 9, d));
  expect(memory.dream(now)).toEqual([]);
  // Each line near 4 KB: the third moved pushes the first out.
  const big = (c: string) => c.repeat(4000);
  write("2026-10-27.md", ["a", "b", "c"].map(c => `- ${big(c)}`).join("\n") + "\n");
  for (const [i, c] of ["a", "b", "c"].entries()) {
    for (const d of [28, 29, 30])
      memory.recall([{ file: "2026-10-27.md", line: i + 1, text: big(c) }], new Date(2026, 9, d));
    memory.dream(now);
  }
  expect(read("MEMORY.md")).toBe(`- ${big("b")}\n- ${big("c")}\n`);
});

test("this workspace's note has its place even while empty, and the model is told its name", () => {
  write("workspaces/api.md", "- Uses Postgres\n");
  expect(memory.groups(now, "corgi").map(g => [g.title, g.loaded, g.lines.length])).toEqual([
    ["MEMORY.md", true, 0],
    ["Today", true, 0],
    ["Workspace corgi", true, 0],
    ["Workspace api", false, 1],
  ]);
  expect(memory.instructions("", "", now, "corgi")).toContain(
    "Facts that hold only in this workspace (its project, conventions, people and plans) go to its note " +
      'instead: `corgi memory add --workspace "corgi" "<line>"`.',
  );
  // Nothing in the name can end its quotes or expand.
  expect(memory.instructions("", "", now, 'my "ws" $(x)')).toContain('--workspace "my ws (x)"');
  expect(memory.instructions("", "", now)).not.toContain("--workspace");
  // The name the model is told leads to the note that's loaded.
  for (const [workspace, told] of [
    ["Q&A!", "Q&A"],
    ["a\\b", "a-b"],
  ]) {
    expect(memory.instructions("", "", now, workspace)).toContain(`--workspace "${told}"`);
    memory.add("a fact", { workspace: told }, now);
    expect(memory.load(workspace, now).files).toEqual([{ name: `workspaces/${told}.md`, lines: 1 }]);
  }
});

test("a line or file name with controls reads with spaces, and still edits", () => {
  write("MEMORY.md", "- copied \x1b]52;c;aGk=\x07 here\n");
  write("workspaces/x\x1b[2J.md", "- \x9b31m red\n");
  const groups = memory.groups(now, null),
    drawn = groups.flatMap(g => [g.title, ...g.lines.map(l => l.text)]).join(" ");
  expect(drawn).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
  expect(groups[0].lines).toEqual([{ at: 0, text: "copied ]52;c;aGk= here" }]);
  expect(groups.map(g => g.title)).toContain("Workspace x [2J");
  expect(memory.edit(groups[0].file, 0, groups[0].lines[0].text, "kept")).toBe(true);
  expect(read("MEMORY.md")).toBe("- kept\n");
  memory.add("bell \x07 here", "long", now);
  expect(read("MEMORY.md")).toBe("- kept\n- bell here\n");
});

test("--replaces with a file named moves the line there", () => {
  write("2026-10-30.md", "- foo = bar\n- other\n");
  expect(memory.add("foo is baz", "long", now, { file: "2026-10-30.md", line: 1, moved: true })).toEqual({
    status: "replaced",
    file: "MEMORY.md",
    line: 1,
    path: join(memory.dir, "MEMORY.md"),
    text: "- foo is baz",
    was: { file: join(memory.dir, "2026-10-30.md"), line: "- foo = bar" },
  });
  expect(read("2026-10-30.md")).toBe("- other\n");
  expect(read("MEMORY.md")).toBe("- foo is baz\n");
  // Without, it's rewritten where it was.
  expect(memory.add("other, changed", "today", now, { file: "2026-10-30.md", line: 1 })).toMatchObject({
    file: "2026-10-30.md",
    was: { file: join(memory.dir, "2026-10-30.md"), line: "- other" },
  });
  expect(read("2026-10-30.md")).toBe("- other, changed\n");
});
