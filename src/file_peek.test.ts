import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as filePeek from "./file_peek";
import { Rect } from "./layout";
import { Writer } from "./text";

const dirs: string[] = [];
const peeks: filePeek.Peek[] = [];
function file(name: string, text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "corgi-peek-"));
  dirs.push(dir);
  writeFileSync(join(dir, name), text);
  return join(dir, name);
}
async function peek(path: string, line: number | null = null): Promise<filePeek.Peek> {
  const p = new filePeek.Peek(path, { path, line, column: null }, () => {});
  peeks.push(p);
  await p.opened;
  return p;
}
const shown = (p: filePeek.Peek, rect: Rect) => {
  const w = new Writer();
  filePeek.draw(w, rect, p, null);
  return w.s.replace(/\x1b\[[\d;]*[A-Za-z]/g, "");
};
afterEach(() => {
  for (const p of peeks.splice(0)) p.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("sits under the name, or over it without room below", () => {
  expect(filePeek.geometry(120, 40, { x: 30, y: 5 })).toEqual(new Rect(28, 6, 88, filePeek.rows + 3));
  expect(filePeek.geometry(120, 40, { x: 30, y: 30 })).toEqual(new Rect(28, 16, 88, filePeek.rows + 3));
  expect(filePeek.geometry(60, 40, { x: 50, y: 5 })!.x).toBe(2);
  expect(filePeek.geometry(30, 40, { x: 0, y: 0 })).toBeNull();
});

test("shows the named line amid its context, and the line under a click", async () => {
  const lines = Array.from({ length: 200 }, (_, i) => `const v${i + 1} = ${i + 1};`).join("\n");
  const p = await peek(file("a.ts", lines), 120);
  const rect = new Rect(0, 0, 80, filePeek.rows + 3);
  const text = shown(p, rect);
  expect(text).toContain("a.ts:120");
  expect(text).toContain("200 lines");
  expect(text).toContain("120 const v120 = 120;");
  expect(text).toContain("115 const v115");
  expect(text).toContain("125 const v125");
  expect(p.lineAt(filePeek.bodyRow(rect, 10, 2 + 5)!)).toBe(120);
  filePeek.wheel(p, false);
  expect(p.lineAt(0)).toBe(118);
});

test("follows a log's end, and pauses once scrolled up", async () => {
  const path = file("x.log", Array.from({ length: 40 }, (_, i) => `INFO step ${i}`).join("\n") + "\n");
  const p = await peek(path);
  const rect = new Rect(0, 0, 80, filePeek.rows + 3);
  expect(shown(p, rect)).toContain("● live");
  expect(shown(p, rect)).toContain("step 39");
  filePeek.wheel(p, true);
  appendFileSync(path, "WARN step 40\n");
  await p.reader!.source.refresh();
  const text = shown(p, rect);
  expect(text).toContain("‖ paused");
  expect(text).toContain("1 new");
});

test("says when it can't read the file", async () => {
  const p = await peek("/nonexistent/corgi/file.ts");
  expect(shown(p, new Rect(0, 0, 60, filePeek.rows + 3))).toContain("Can't read it: ENOENT");
});
