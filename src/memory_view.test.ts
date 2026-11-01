import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { View } from "./memory_view";
import { Memory } from "./prompt_memory";
import { Rect } from "./layout";
import { Writer } from "./text";

/** The screen's text after replaying the cursor moves in `ansi`. */
function screen(ansi: string, cols: number, rows: number): string[] {
  const grid = Array.from({ length: rows }, () => Array(cols).fill(" "));
  let x = 0,
    y = 0;
  for (const m of ansi.matchAll(/\x1b\[([\d;?]*)([A-Za-z])|\x1b\][^\x1b]*\x1b\\|([\s\S])/gu)) {
    if (m[2] === "H") {
      const [r, c] = (m[1] || "1;1").split(";").map(Number);
      y = r - 1;
      x = c - 1;
    } else if (m[3] !== undefined) {
      if (y < rows && x < cols) grid[y][x] = m[3];
      x++;
    }
  }
  return grid.map(row => row.join(""));
}

const folders: string[] = [];
afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});
/** A memory folder on 2026-10-31 with a curated file, two logs and a workspace note. */
function memory() {
  const dir = mkdtempSync(join(tmpdir(), "corgi-memory-"));
  folders.push(dir);
  mkdirSync(join(dir, "workspaces"));
  writeFileSync(join(dir, "MEMORY.md"), "- Prefers bun over npm\n- Main branch is protected\n");
  writeFileSync(join(dir, "2026-10-31.md"), "- foo = baz\n");
  writeFileSync(join(dir, "2026-10-29.md"), "- Shipped the launcher\n");
  writeFileSync(join(dir, "workspaces", "corgi.md"), "- Tests run with bun test src\n");
  const clock = { now: new Date(2026, 9, 31, 12).getTime() };
  const view = new View(new Memory(dir), "corgi", () => clock.now);
  return { dir, view, clock };
}
function draw(view: View, w = 70, h = 16): string[] {
  const out = new Writer();
  view.draw(out, new Rect(0, 0, w, h));
  return screen(out.s, w, h).map(l => l.trimEnd());
}
const type = (view: View, text: string) => {
  for (const c of text) view.key(c.charCodeAt(0));
};

test("every file shows under a heading that says whether the model starts with it", () => {
  const { view } = memory();
  const lines = draw(view);
  expect(lines[0]).toContain("Search memory");
  expect(lines.slice(2, 13)).toEqual([
    expect.stringMatching(/^MEMORY\.md +loaded · 2$/),
    "  · Prefers bun over npm",
    "  · Main branch is protected",
    expect.stringMatching(/^Today +loaded · 1$/),
    "  · foo = baz",
    expect.stringMatching(/^Workspace corgi +loaded · 1$/),
    "  · Tests run with bun test src",
    expect.stringMatching(/^2026-10-29 +not loaded · 1$/),
    "  · Shipped the launcher",
    "",
    "",
  ]);
  expect(lines[0]).toMatch(/^ \/  Search memory +5 lines/);
  expect(lines.at(-1)).toContain("⏎ edit   ⇥ add   ⌫ delete   / search");
});

test("/ or typing searches every file, as the model picker does; Esc ends the search, then goes back", () => {
  const { view } = memory();
  view.key(47);
  type(view, "bun");
  let lines = draw(view);
  expect(lines[0]).toMatch(/^ \/  bun +2 of 5/);
  expect(lines.filter(l => l.startsWith("  · "))).toEqual([
    "  · Prefers bun over npm",
    "  · Tests run with bun test src",
  ]);
  // In a search Backspace edits it, and on nothing typed leaves it.
  view.key(127);
  expect(draw(view)[0]).toMatch(/^ \/  bu /);
  expect(view.key(27)).toBeNull();
  lines = draw(view);
  expect(lines.filter(l => l.startsWith("  · "))).toHaveLength(5);
  type(view, "fo");
  expect(draw(view).filter(l => l.startsWith("  · "))).toEqual(["  · foo = baz"]);
  view.key(127);
  view.key(127);
  view.key(127);
  expect(draw(view).at(-1)).toContain("/ search");
  expect(view.key(27)).toEqual({ kind: "close" });
});

test("a line is edited in place, added to its file, or deleted with Backspace twice", () => {
  const { dir, view } = memory();
  // Down to "Main branch is protected", then edit it.
  view.sequence("\x1b[B");
  view.key(13);
  for (let i = 0; i < "protected".length; i++) view.key(127);
  type(view, "open");
  view.key(13);
  expect(readFileSync(join(dir, "MEMORY.md"), "utf8")).toBe("- Prefers bun over npm\n- Main branch is open\n");
  // Tab writes one more line in the same file.
  view.key(9);
  expect(draw(view).at(-1)).toContain("⏎ save");
  type(view, "Ship on Fridays");
  view.key(13);
  expect(readFileSync(join(dir, "MEMORY.md"), "utf8")).toContain("- Ship on Fridays\n");
  expect(draw(view).find(l => l.includes("Ship on Fridays"))).toBeDefined();
  // Backspace asks, and Esc keeps it; twice deletes. Forward Delete does too.
  view.key(127);
  expect(draw(view).at(-1)).toContain("⌫ again deletes");
  view.key(27);
  expect(readFileSync(join(dir, "MEMORY.md"), "utf8")).toContain("Ship on Fridays");
  view.key(127);
  view.key(127);
  expect(readFileSync(join(dir, "MEMORY.md"), "utf8")).not.toContain("Ship on Fridays");
  view.sequence("\x1b[3~");
  view.sequence("\x1b[3~");
  expect(readFileSync(join(dir, "MEMORY.md"), "utf8")).toBe("- Prefers bun over npm\n");
});

test("an edit to a line the model changed meanwhile leaves the file alone and says so", () => {
  const { dir, view } = memory();
  view.key(13);
  writeFileSync(join(dir, "MEMORY.md"), "- Prefers pnpm\n");
  type(view, "!");
  view.key(13);
  expect(readFileSync(join(dir, "MEMORY.md"), "utf8")).toBe("- Prefers pnpm\n");
  expect(draw(view).at(-1)).toContain("That line changed meanwhile");
  // The list reads the file again: what's there now shows.
  expect(draw(view)[3]).toBe("  · Prefers pnpm");
});

test("lines the model writes show up while the view is open", () => {
  const { dir, view, clock } = memory();
  writeFileSync(join(dir, "2026-10-31.md"), "- foo = baz\n- bar = qux\n");
  expect(draw(view).some(l => l.includes("bar = qux"))).toBe(false);
  clock.now += 1000;
  expect(draw(view).some(l => l.includes("bar = qux"))).toBe(true);
});

test("an empty file has a place to add its first line; Ctrl+E opens the file in the editor", () => {
  const { dir, view } = memory();
  writeFileSync(join(dir, "2026-10-31.md"), "");
  view.reload();
  // Today's place is under its heading.
  view.sequence("\x1b[B");
  view.sequence("\x1b[B");
  expect(draw(view).find(l => l.includes("nothing here yet"))).toBeDefined();
  expect(view.key(5)).toEqual({ kind: "open", file: join(dir, "2026-10-31.md") });
  view.key(13);
  type(view, "first");
  view.key(13);
  expect(readFileSync(join(dir, "2026-10-31.md"), "utf8")).toBe("- first\n");
});
