import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fileAccess from "./file_access";
import * as filePeek from "./file_peek";
import { Rect } from "./layout";
import { Writer } from "./text";

const dirs: string[] = [];
const peeks: filePeek.Peek[] = [];
const indexes = mkdtempSync(join(tmpdir(), "corgi-lines-"));
beforeAll(() => {
  process.env.CORGI_LINE_INDEX_DIR = indexes;
});
afterAll(() => {
  delete process.env.CORGI_LINE_INDEX_DIR;
  rmSync(indexes, { recursive: true, force: true });
});
function file(name: string, text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "corgi-peek-"));
  dirs.push(dir);
  writeFileSync(join(dir, name), text);
  return join(dir, name);
}
async function peek(path: string, line: number | null = null, budget?: number): Promise<filePeek.Peek> {
  const p = new filePeek.Peek(path, { path, line, column: null }, () => {}, fileAccess.here, budget);
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

test("a line deep in a large log is asked about, found once asked, with the scan's progress between", async () => {
  const lines = Array.from({ length: 300_000 }, (_, i) => `INFO step ${i + 1}`).join("\n") + "\n";
  const path = file("deep.log", lines),
    rect = new Rect(0, 0, 80, filePeek.rows + 3);
  // Not a byte scanned on the pointer's say-so: the card asks, over the log's end.
  const p = await peek(path, 250_000, 0);
  let text = shown(p, rect);
  expect(text).toContain("Finding line 250,000 may take a while");
  expect(text).toContain("▸ Find line 250,000");
  expect(text).toContain("step 300000");
  expect(p.hit(1)).toEqual({ kind: "find" });
  expect(p.hit(0)).toBeNull();
  expect(p.hit(filePeek.banner_rows + 2)?.kind).toBe("line");
  expect(p.banner).toBe(filePeek.banner_rows);
  // The row starts the scan, whose progress shows while it runs.
  const s = p.reader!.source,
    seen: string[] = [];
  const find = Reflect.get(s, "fh").find.bind(Reflect.get(s, "fh"));
  Reflect.get(s, "fh").find = (n: number, opts: { progress?: (x: unknown) => void }) =>
    find(n, {
      ...opts,
      progress: (x: { scanned: number; size: number; lines: number }) => {
        opts.progress?.(x);
        seen.push(shown(p, rect));
      },
    });
  p.find();
  for (let i = 0; i < 100 && s.seeks === 0; i++) await Bun.sleep(10);
  expect(s.far).toBeNull();
  expect(seen.some(t => /Finding line 250,000… [\d.]+ [KM]B of [\d.]+ MB · [\d,]+ lines/.test(t))).toBe(true);
  text = shown(p, rect);
  expect(text).not.toContain("Find line");
  expect(text).toContain("250000 INFO step 250000");
  expect(p.lineAt(5)).toBe(250_000);
  expect(p.banner).toBe(0);
  // Found and indexed, the same line opens without asking next time.
  const again = await peek(path, 250_000, 0);
  expect(again.banner).toBe(0);
  expect(shown(again, rect)).toContain("250000 INFO step 250000");
});

test("says when it can't read the file", async () => {
  const p = await peek("/nonexistent/corgi/file.ts");
  expect(shown(p, new Rect(0, 0, 60, filePeek.rows + 3))).toContain("Can't read it: ENOENT");
});
