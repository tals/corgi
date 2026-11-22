import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, renameSync, rmSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fileSource from "./file_source";
import { Source } from "./file_source";

const dirs: string[] = [];
const opened: Source[] = [];
const indexes = mkdtempSync(join(tmpdir(), "corgi-lines-"));
beforeAll(() => {
  process.env.CORGI_LINE_INDEX_DIR = indexes;
});
afterAll(() => {
  delete process.env.CORGI_LINE_INDEX_DIR;
  rmSync(indexes, { recursive: true, force: true });
});
function file(name: string, text: string | Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), "corgi-source-"));
  dirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}
async function open(path: string, opts: fileSource.Options = {}): Promise<Source> {
  const source = await Source.open(path, { follow: false, ...opts });
  opened.push(source);
  return source;
}
/** Every row, the line being written last. */
const rows = (s: Source) => Array.from({ length: s.count }, (_, i) => s.line(i));
const numbered = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}`).join("\n") + "\n";
afterEach(async () => {
  for (const source of opened.splice(0)) await source.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("picks how a file reads from its name and size", () => {
  expect(fileSource.modeFor("/a/src/app.ts", 1000)).toBe("code");
  expect(fileSource.modeFor("/a/src/app.ts", fileSource.code_limit + 1)).toBe("tail");
  for (const name of ["server.log", "out.log.1", "run.out", "events.jsonl", "app.log.2026-11-08"])
    expect(fileSource.modeFor(name, 10)).toBe("tail");
});

test("reads code whole, numbered from one, with or without a final newline", async () => {
  const s = await open(file("a.ts", "one\ntwo\r\nthree"));
  expect(s.mode).toBe("code");
  expect([s.count, s.first, s.line(1), s.line(2)]).toEqual([3, 1, "two\r", "three"]);
  expect(s.rowOf(3)).toBe(2);
  const t = await open(file("b.ts", "one\ntwo\n"));
  expect(t.count).toBe(2);
  const binary = await open(file("c.ts", new Uint8Array([1, 0, 2])));
  expect([binary.binary, binary.count]).toEqual([true, 0]);
});

test("reads only a large log's last block, from its first whole line", async () => {
  const path = file("big.log", numbered(1, 200_000));
  const s = await open(path);
  expect(s.mode).toBe("tail");
  expect(s.size).toBeGreaterThan(fileSource.block);
  expect(s.end - s.start).toBeLessThanOrEqual(fileSource.block);
  expect(s.line(s.count - 1)).toBe("line 200000");
  expect(s.line(0)).toMatch(/^line \d+$/);
  // Its numbers are unknown until it reads back to the start.
  expect(s.first).toBeNull();
  const shown = s.count;
  expect(await s.earlier()).toBe(true);
  expect(s.count).toBeGreaterThan(shown);
  expect(s.prepended).toBe(s.count - shown);
  // The block before ends where the window started: no line lost or doubled.
  const first = Number(s.line(0).slice(5));
  for (let i = 0; i < s.count; i++) expect(s.line(i)).toBe(`line ${first + i}`);
});

test("a small log reads whole and knows its numbers", async () => {
  const s = await open(file("small.log", numbered(1, 10)));
  expect([s.first, s.count, s.line(9)]).toEqual([1, 10, "line 10"]);
});

test("follows growth, completing a line being written", async () => {
  const path = file("grow.log", "a\nb\npart");
  const s = await open(path);
  expect([rows(s), s.partial, s.count]).toEqual([["a", "b", "part"], "part", 3]);
  appendFileSync(path, "ial\nc\n");
  await s.refresh();
  expect([rows(s), s.partial]).toEqual([["a", "b", "partial", "c"], ""]);
  expect(s.added).toBe(2);
  // A character split across two writes decodes whole.
  const smile = Buffer.from("é\n");
  appendFileSync(path, smile.subarray(0, 1));
  await s.refresh();
  appendFileSync(path, smile.subarray(1));
  await s.refresh();
  expect(rows(s).at(-1)).toBe("é");
});

test("starts again at the end of a log that was truncated or replaced", async () => {
  const path = file("roll.log", numbered(1, 50));
  const s = await open(path);
  truncateSync(path, 0);
  writeFileSync(path, "fresh\n");
  await s.refresh();
  expect([s.restarts, rows(s)]).toEqual([1, ["fresh"]]);
  // logrotate moves the file aside and starts another.
  renameSync(path, path + ".1");
  writeFileSync(path, "new file\n");
  await s.refresh();
  expect([s.restarts, rows(s)]).toEqual([2, ["new file"]]);
});

test("reads a followed file again after an edit in place that keeps its size", async () => {
  const path = file("same.log", "alpha\nbravo\n");
  const time = (seconds: number) => utimesSync(path, seconds, seconds);
  time(1000);
  const s = await open(path);
  await s.refresh();
  // Appending changes the size: that's growth, not an edit.
  appendFileSync(path, "carol\n");
  time(1001);
  await s.refresh(false);
  await s.refresh();
  expect([s.restarts, rows(s)]).toEqual([0, ["alpha", "bravo", "carol"]]);
  // An editor's save of as many bytes, only its time telling.
  writeFileSync(path, "ALPHA\nbravo\ncarol\n");
  time(1002);
  await s.refresh();
  expect([s.restarts, rows(s)]).toEqual([0, ["ALPHA", "bravo", "carol"]]);
  // Deep in a large one, the edit shows where the reader was, under the same numbers.
  const big = file("big.log", numbered(1, 100_000));
  utimesSync(big, 1000, 1000);
  const deep = await open(big, { line: 60_000 });
  const start = deep.start;
  expect(deep.line(deep.rowOf(60_000)!)).toBe("line 60000");
  writeFileSync(big, numbered(1, 100_000).replace("line 60000\n", "LINE 60000\n"));
  utimesSync(big, 1001, 1001);
  await deep.refresh();
  expect([deep.restarts, deep.start]).toEqual([0, start]);
  expect(deep.line(deep.rowOf(60_000)!)).toBe("LINE 60000");
  // One that adds a line before the window, still at the same size, numbers its lines again.
  writeFileSync(big, numbered(1, 100_000).replace("line 60000\n", "LINE 60000\n").replace("line 5\n", "line\n5\n"));
  utimesSync(big, 1002, 1002);
  await deep.refresh();
  expect(deep.start).toBe(start);
  expect(deep.line(deep.rowOf(60_001)!)).toBe("LINE 60000");
});

test("skips growth too fast to read, as a reader that fell behind", async () => {
  const path = file("fast.log", "start\n");
  const s = await open(path);
  appendFileSync(path, Buffer.alloc(fileSource.skip_after + 10, "x\n"));
  await s.refresh();
  expect(s.restarts).toBe(1);
  expect(s.end - s.start).toBeLessThanOrEqual(fileSource.block);
});

test("drops its oldest lines past the cap, keeping where earlier ones start", async () => {
  const path = file("cap.log", "");
  const s = await open(path);
  appendFileSync(path, numbered(1, fileSource.max_lines + 10));
  await s.refresh();
  expect(s.dropped).toBeGreaterThan(0);
  expect(s.count).toBeLessThanOrEqual(fileSource.max_lines);
  const first = Number(s.line(0).slice(5));
  expect(first).toBe(s.dropped + 1);
  expect(await s.earlier()).toBe(true);
  expect(s.line(0)).toBe("line 1");
  expect(s.line(s.prepended)).toBe(`line ${first}`);
});

test("keeps at most its byte cap of a log, and only the end of a line too long for it", async () => {
  const path = file("long.log", "start\n");
  const s = await open(path);
  const chunk = Buffer.alloc(4 << 20, "x");
  for (let i = 0; i < 5; i++) {
    appendFileSync(path, chunk);
    await s.refresh();
  }
  expect(s.restarts).toBe(0);
  expect(s.end - s.start).toBeLessThanOrEqual(fileSource.max_bytes);
  const kept = Reflect.get(s, "blocks") as { bytes: Uint8Array }[];
  expect(kept.reduce((n, b) => n + b.bytes.length, 0)).toBeLessThanOrEqual(fileSource.max_bytes);
  expect(s.dropped).toBe(1);
  expect(s.count).toBe(1);
  expect(s.partial.length).toBe(s.end - s.start);
  // A line ending it lets whole lines follow it.
  appendFileSync(path, "\nnext\n");
  await s.refresh();
  expect(s.line(s.count - 1)).toBe("next");
});

test("follows a code file that grows past the limit from its end, as a log", async () => {
  const path = file("gen.json", '{"a": 1}\n');
  const s = await open(path);
  expect(s.mode).toBe("code");
  appendFileSync(path, Buffer.alloc(fileSource.code_limit, "\n"));
  appendFileSync(path, "last\n");
  await s.refresh();
  expect(s.mode).toBe("tail");
  expect(s.lines).toEqual([]);
  expect(s.restarts).toBe(1);
  expect(s.end - s.start).toBeLessThanOrEqual(fileSource.block);
  expect(s.line(s.count - 1)).toBe("last");
});

test("moves a log's window to its start or its end", async () => {
  const s = await open(file("jump.log", numbered(1, 300_000)), { line: 150_000 });
  expect(s.atEnd).toBe(false);
  expect(await s.toEnd()).toBe(true);
  expect(s.atEnd).toBe(true);
  expect(s.restarts).toBe(1);
  expect(s.line(s.count - 1)).toBe("line 300000");
  expect(await s.toEnd()).toBe(false);
  expect(await s.toStart()).toBe(true);
  expect(s.rewinds).toBe(1);
  expect(s.start).toBe(0);
  expect(s.line(0)).toBe("line 1");
  expect(s.number(0)).toBe(1);
  expect(await s.toStart()).toBe(false);
});

test("scrolling back keeps to the caps from the end, and growth then leaves the place alone", async () => {
  const path = file("back.log", numbered(1, 300_000));
  const s = await open(path);
  // About 22,000 lines a block: four pass the cap.
  for (let i = 0; i < 4; i++) expect(await s.earlier()).toBe(true);
  expect(s.count).toBeLessThanOrEqual(fileSource.max_lines);
  expect(s.atEnd).toBe(false);
  expect(s.line(s.count - 1)).not.toBe("line 300000");
  const first = s.line(0),
    dropped = s.dropped;
  // A reader up there holds its place while the log grows.
  s.hold = 0;
  appendFileSync(path, numbered(300_001, 300_010));
  await s.refresh();
  expect([s.line(0), s.dropped]).toEqual([first, dropped]);
  // Reading forward isn't the log growing.
  const added = s.added;
  expect(await s.later()).toBe(true);
  expect(s.added).toBe(added);
});

test("growth past the caps drops lines on the side away from a place held in the window", async () => {
  const full = async (name: string) => {
    const path = file(name, "");
    const s = await open(path);
    appendFileSync(path, numbered(1, fileSource.max_lines));
    await s.refresh();
    return { path, s };
  };
  const grow = async ({ path, s }: { path: string; s: Source }) => {
    appendFileSync(path, numbered(fileSource.max_lines + 1, fileSource.max_lines + 100));
    await s.refresh();
  };
  // Held near the start: the growth gives way.
  const top = await full("top.log");
  top.s.hold = 10;
  await grow(top);
  expect([top.s.line(0), top.s.dropped, top.s.atEnd]).toEqual(["line 1", 0, false]);
  // Held a line up from the end: the oldest lines go, and the held one stays.
  const end = await full("end.log");
  const held = end.s.count - 30;
  end.s.hold = held;
  await grow(end);
  expect(end.s.dropped).toBeGreaterThan(0);
  expect(end.s.line(held - end.s.dropped)).toBe(`line ${held + 1}`);
  expect(end.s.atEnd).toBe(true);
  // Growth twice before the viewer draws again still keeps the held line.
  const twice = await full("twice.log");
  twice.s.hold = 7000;
  await grow(twice);
  appendFileSync(twice.path, numbered(fileSource.max_lines + 101, fileSource.max_lines + 5101));
  await twice.s.refresh();
  expect(twice.s.line(twice.s.hold!)).toBe("line 7001");
});

test("scrolls back past a line longer than a block, reaching back through it as one row", async () => {
  const long = "x".repeat(600_000);
  const s = await open(file("long.jsonl", "first\n" + long + "\n" + numbered(1, 1000)));
  expect(s.count).toBe(1000);
  expect(s.first).toBeNull();
  // Its end, cut, then more of it, then the rest and the line before.
  expect(await s.earlier()).toBe(true);
  expect([s.count, s.line(0).length]).toEqual([1001, fileSource.block - 1]);
  expect(await s.earlier()).toBe(true);
  expect([s.count, s.line(0).length]).toEqual([1001, 2 * fileSource.block - 1]);
  expect(await s.earlier()).toBe(true);
  expect([s.count, s.line(0), s.line(1), s.number(0)]).toEqual([1002, "first", long, 1]);
  expect(s.line(2)).toBe("line 1");
  expect(await s.earlier()).toBe(false);
});

test("scrolling back through a record longer than the byte cap keeps to the cap", async () => {
  const record = "x".repeat(40 << 20);
  const s = await open(file("huge.jsonl", "first\n" + record + "\n" + numbered(1, 1000)));
  const kept = () => (Reflect.get(s, "blocks") as { bytes: Uint8Array }[]).reduce((n, b) => n + b.bytes.length, 0);
  for (let reads = 0; reads < 400; reads++) {
    // A reader scrolling back holds the top row.
    s.hold = 0;
    if (!(await s.earlier())) break;
    expect(s.end - s.start).toBeLessThanOrEqual(fileSource.max_bytes);
    expect(kept()).toBeLessThanOrEqual(fileSource.max_bytes);
  }
  expect([s.start, s.line(0), s.count]).toEqual([0, "first", 2]);
  expect(s.line(1, 16)).toBe("x".repeat(16));
});

test("a growth too large for a held place's window keeps the held line", async () => {
  const path = file("burst.log", "");
  const s = await open(path);
  appendFileSync(path, numbered(1, fileSource.max_lines));
  await s.refresh();
  s.hold = 47_980;
  appendFileSync(path, numbered(fileSource.max_lines + 1, fileSource.max_lines + 41_000));
  await s.refresh();
  expect(s.line(s.hold!)).toBe("line 47981");
  expect(s.count).toBeLessThanOrEqual(fileSource.max_lines);
});

test("counts growth past a window that stops short of the end", async () => {
  const path = file("count.log", numbered(1, 300_000));
  const s = await open(path, { line: 1000 });
  expect(s.atEnd).toBe(false);
  appendFileSync(path, numbered(300_001, 300_010));
  await s.refresh();
  expect(s.added).toBe(10);
  expect(s.atEnd).toBe(false);
});

test("a read asked for in passing shows its failure, and one a close overtakes just stops", async () => {
  const s = await open(file("fail.log", numbered(1, 300_000)), { line: 100_000 });
  expect(s.start).toBeGreaterThan(0);
  Reflect.set(s, "read", () => Promise.reject(Error("EIO")));
  expect(await s.earlier()).toBe(false);
  expect(s.error).toBe("EIO");
  const other = await open(file("race.log", numbered(1, 300_000)), { line: 1000 });
  const jump = other.toEnd();
  await other.close();
  expect(await jump).toBe(false);
  expect(other.error).toBeNull();
});

test("an open called off stops scanning for its line", async () => {
  const abort = new AbortController();
  abort.abort();
  const path = file("deep.log", numbered(1, 300_000));
  expect(open(path, { line: 250_000, signal: abort.signal })).rejects.toThrow("Aborted");
});

test("a follow that fails says so until it works again", async () => {
  const path = file("err.log", "one\n");
  const s = await open(path);
  const update = Reflect.get(s, "check").bind(s);
  let fail = true;
  Reflect.set(s, "check", (named: boolean) => (fail ? Promise.reject(Error("EIO")) : update(named)));
  await s.refresh();
  expect(s.error).toBe("EIO");
  const version = s.version;
  await s.refresh();
  expect(s.version).toBe(version);
  fail = false;
  await s.refresh();
  expect(s.error).toBeNull();
});

test("opens a large log around a line its text named", async () => {
  const s = await open(file("seek.log", numbered(1, 300_000)), { line: 123_456 });
  const row = s.rowOf(123_456)!;
  expect(row).not.toBeNull();
  expect(s.line(row)).toBe("line 123456");
  expect(s.atEnd).toBe(false);
  // Past the end it shows the end.
  const end = await open(file("seek2.log", numbered(1, 300_000)), { line: 900_000 });
  expect(end.line(end.count - 1)).toBe("line 300000");
});

test("a line past the budget's scan opens at the end as far, and find scans on to it when asked", async () => {
  // Its lines are its own: an index of another test's file, were its inode reused, is seen as stale.
  const path = file("far.log", Array.from({ length: 300_000 }, (_, i) => `far ${i + 1}`).join("\n") + "\n");
  const s = await open(path, { line: 200_000, budget: 0 });
  expect(s.far).toEqual({ line: 200_000, bytes: s.size });
  expect(s.atEnd).toBe(true);
  expect(s.rowOf(200_000)).toBeNull();
  const progress: number[] = [];
  const unsub = () => progress.push(s.scan?.scanned ?? -1);
  Reflect.set(s, "opts", { ...Reflect.get(s, "opts"), changed: unsub });
  expect(await s.find()).toBe(true);
  expect([s.far, s.scan, s.seeking, s.seeks, s.sought]).toEqual([null, null, null, 1, 200_000]);
  expect(s.line(s.rowOf(200_000)!)).toBe("far 200000");
  expect(progress.some(n => n > 0)).toBe(true);
  // Nothing far: nothing to find. A line past the end stays missing, not far.
  expect(await s.find()).toBe(false);
  const gone = await open(path, { line: 900_000, budget: 0 });
  expect(gone.far).toMatchObject({ line: 900_000 });
  expect(await gone.find()).toBe(false);
  expect(gone.far).toBeNull();
  // A scan a close stops leaves the line to ask for again, so a later open may.
  const stopped = await open(path, { line: 250_000, budget: 0 });
  const found = stopped.find();
  await stopped.close();
  expect(await found).toBe(false);
  // Its index remembers how far the scans got: the line is found within no budget at all.
  const quick = await open(path, { line: 200_000, budget: 0 });
  expect(quick.far).toBeNull();
  expect(quick.line(quick.rowOf(200_000)!)).toBe("far 200000");
});

test("notices growth on its own while following", async () => {
  const path = file("live.log", "one\n");
  let changes = 0;
  const s = await Source.open(path, { changed: () => changes++ });
  opened.push(s);
  appendFileSync(path, "two\n");
  for (let i = 0; i < 100 && rows(s).at(-1) !== "two"; i++) await Bun.sleep(20);
  expect(rows(s)).toEqual(["one", "two"]);
  expect(changes).toBeGreaterThan(0);
});
