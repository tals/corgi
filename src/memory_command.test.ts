import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./memory_command";
import { Memory } from "./prompt_memory";

const folders: string[] = [];
afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const now = new Date(2026, 9, 31, 12);
function memory() {
  const dir = mkdtempSync(join(tmpdir(), "corgi-memory-"));
  folders.push(dir);
  mkdirSync(join(dir, "workspaces"));
  writeFileSync(join(dir, "MEMORY.md"), "- Prefers bun over npm\n- Main branch is protected\n");
  writeFileSync(join(dir, "2026-10-31.md"), "- foo = baz\n");
  writeFileSync(join(dir, "2026-10-30.md"), "- Ran bun test in CI\n");
  writeFileSync(join(dir, "2026-10-12.md"), "- Picked the bun dig routine\n- Tried npm once\n");
  writeFileSync(join(dir, "workspaces", "corgi.md"), "- Tests run with bun test src\n");
  return { dir, m: new Memory(dir), cmd: (...args: string[]) => run(new Memory(dir), args, now) };
}

test("search finds every word first, curated files before logs, newest logs first", () => {
  const { cmd } = memory();
  expect(cmd("search", "bun")).toBe(
    [
      "MEMORY.md:1  Prefers bun over npm",
      "workspaces/corgi.md:1  Tests run with bun test src",
      "2026-10-30.md:1  Ran bun test in CI",
      "2026-10-12.md:1  Picked the bun dig routine",
      "",
    ].join("\n"),
  );
  expect(cmd("search", "bun", "test")).toBe(
    "workspaces/corgi.md:1  Tests run with bun test src\n2026-10-30.md:1  Ran bun test in CI\n",
  );
  // With no line holding every word, the lines holding most of them.
  expect(cmd("search", "npm", "flamingo").split("\n")[0]).toBe("MEMORY.md:1  Prefers bun over npm");
  // A file's name counts: a date finds its log.
  expect(cmd("search", "2026-10-12")).toContain("2026-10-12.md:2  Tried npm once");
  expect(cmd("search", "bun", "--limit", "1")).toBe(
    "MEMORY.md:1  Prefers bun over npm\n(+3 more; --limit 4 shows them)\n",
  );
  expect(cmd("search", "flamingo")).toBe("No memory line holds: flamingo\n");
});

test("get lists the files, or reads a file's lines numbered, saying where more begins", () => {
  const { dir, cmd } = memory();
  expect(cmd("get")).toBe(
    [
      "MEMORY.md              2 lines  loaded",
      "2026-10-31.md          1 line   loaded (today)",
      "workspaces/corgi.md    1 line",
      "2026-10-30.md          1 line   loaded (yesterday)",
      "2026-10-12.md          2 lines",
      "",
    ].join("\n"),
  );
  expect(cmd("get", "MEMORY.md:2")).toBe("2  - Main branch is protected\n");
  writeFileSync(join(dir, "big.md"), Array.from({ length: 130 }, (_, i) => `- line ${i + 1}`).join("\n") + "\n");
  const read = cmd("get", "big.md").split("\n");
  expect(read[0]).toBe("  1  - line 1");
  expect(read.at(-2)).toBe("… more: corgi memory get big.md:121");
  expect(cmd("get", "big.md:3-4")).toBe("3  - line 3\n4  - line 4\n");
  expect(() => cmd("get", "../outside.md")).toThrow("NotInMemory");
});

test("add writes one line where it's asked, and not a line that's there already", () => {
  const { dir, cmd } = memory();
  expect(cmd("add", "Ships", "on", "Fridays")).toBe("added 2026-10-31.md:2\n");
  expect(readFileSync(join(dir, "2026-10-31.md"), "utf8")).toBe("- foo = baz\n- Ships on Fridays\n");
  expect(cmd("add", "--long", "Lives in Brooklyn")).toBe("added MEMORY.md:3\n");
  expect(cmd("add", "--workspace", "corgi", "Uses Zig 0.17")).toBe("added workspaces/corgi.md:2\n");
  // Already in today's log, or in MEMORY.md, it isn't written again.
  expect(cmd("add", "Ships on Fridays")).toBe("already in 2026-10-31.md:2\n");
  expect(cmd("add", "-", "Prefers  bun over npm")).toBe("already in MEMORY.md:1\n");
  // A fact that changed replaces its line.
  expect(cmd("add", "--replaces", "2026-10-31.md:1", "foo = qux")).toBe("replaced 2026-10-31.md:1\n");
  expect(readFileSync(join(dir, "2026-10-31.md"), "utf8")).toBe("- foo = qux\n- Ships on Fridays\n");
  expect(() => cmd("add", "--long", "--workspace", "corgi", "x")).toThrow("Usage");
  expect(() => cmd("add")).toThrow("Usage");
});

test("add tells its caller each line it writes, and the one it replaced, and not one already there", () => {
  const { dir } = memory(),
    heard: unknown[] = [],
    cmd = (...args: string[]) => run(new Memory(dir), args, now, change => heard.push(change));
  cmd("add", "Deploys from main");
  cmd("add", "Prefers bun over npm");
  cmd("add", "--replaces", "2026-10-31.md:1", "foo = qux");
  cmd("add", "--long", "--replaces", "2026-10-30.md:1", "CI runs bun test");
  cmd("forget", "MEMORY.md:1");
  expect(heard).toEqual([
    { file: join(dir, "2026-10-31.md"), line: "- Deploys from main", was: null },
    {
      file: join(dir, "2026-10-31.md"),
      line: "- foo = qux",
      was: { file: join(dir, "2026-10-31.md"), line: "- foo = baz" },
    },
    // Moved to MEMORY.md, it still replaced the log's line.
    {
      file: join(dir, "MEMORY.md"),
      line: "- CI runs bun test",
      was: { file: join(dir, "2026-10-30.md"), line: "- Ran bun test in CI" },
    },
  ]);
});

test("forget drops one line by its place", () => {
  const { dir, cmd } = memory();
  expect(cmd("forget", "MEMORY.md:2")).toBe("forgot MEMORY.md:2: Main branch is protected\n");
  expect(readFileSync(join(dir, "MEMORY.md"), "utf8")).toBe("- Prefers bun over npm\n");
  expect(() => cmd("forget", "MEMORY.md:9")).toThrow("NoSuchLine");
  expect(() => cmd("forget", "MEMORY.md")).toThrow("Usage");
  expect(() => cmd("wipe")).toThrow("Usage");
});

test("the log lines a search brings back count toward moving them to MEMORY.md", () => {
  const { dir, m } = memory(),
    on = (day: number, ...args: string[]) => run(m, args, new Date(2026, 9, day, 12));
  on(30, "search", "dig", "routine");
  on(30, "search", "dig");
  on(31, "search", "routine");
  expect(m.dream(new Date(2026, 9, 31, 13))).toEqual(["Picked the bun dig routine"]);
  expect(readFileSync(join(dir, "MEMORY.md"), "utf8")).toContain("- Picked the bun dig routine\n");
});

test("--replaces with --long moves the line to MEMORY.md", () => {
  const { dir, cmd } = memory();
  expect(cmd("add", "--long", "--replaces", "2026-10-31.md:1", "foo is baz")).toBe("replaced MEMORY.md:3\n");
  expect(readFileSync(join(dir, "2026-10-31.md"), "utf8")).toBe("");
  expect(readFileSync(join(dir, "MEMORY.md"), "utf8")).toContain("- foo is baz\n");
});
