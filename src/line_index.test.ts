import { afterEach, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fileAccess from "./file_access";
import * as lineIndex from "./line_index";

const dirs: string[] = [];
const handles: fileAccess.Handle[] = [];
afterEach(async () => {
  for (const h of handles.splice(0)) await h.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "corgi-index-"));
  dirs.push(dir);
  return dir;
}
async function open(path: string): Promise<fileAccess.Handle> {
  const h = await fileAccess.here.open(path);
  handles.push(h);
  return h;
}
/** A file reading `fh`, counting the bytes read. */
function counted(fh: fileAccess.Handle): lineIndex.Readable & { bytes: number } {
  return {
    bytes: 0,
    info: () => fh.info(),
    read(at, length) {
      this.bytes += length;
      return fh.read(at, length);
    },
  };
}
const numbered = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}`).join("\n") + "\n";
const whole = { budget: Infinity };

test("finds a line, keeps points a stride apart, and resumes from the furthest one", async () => {
  const dir = folder(),
    path = join(dir, "a.log");
  writeFileSync(path, numbered(1, 500_000));
  const fh = counted(await open(path)),
    index = await lineIndex.LineIndex.load(fh, dir);
  expect(await lineIndex.find(fh, index, 1, whole)).toEqual({ kind: "found", at: 0 });
  expect(await lineIndex.find(fh, index, 3, whole)).toEqual({ kind: "found", at: 14 });
  const size = (await fh.info()).size;
  expect(await lineIndex.find(fh, index, 400_000, whole)).toEqual({ kind: "found", at: expect.any(Number) });
  expect(index.points.length).toBeGreaterThan(2);
  for (let i = 1; i < index.points.length; i++)
    expect(index.points[i].at - index.points[i - 1].at).toBeGreaterThanOrEqual(index.stride);
  expect(index.covers(400_000)).toBe(true);
  expect(index.covers(450_000)).toBe(false);
  // A line it passed reads a stride at most; one past the scan's end goes on from there.
  const before = fh.bytes;
  expect(await lineIndex.find(fh, index, 350_000, whole)).toEqual({ kind: "found", at: expect.any(Number) });
  expect(fh.bytes - before).toBeLessThanOrEqual(index.stride + lineIndex.chunk);
  const resumed = fh.bytes;
  expect(await lineIndex.find(fh, index, 600_000, whole)).toEqual({ kind: "missing", size });
  expect(fh.bytes - resumed).toBeLessThanOrEqual(size - index.resume(400_001).at + lineIndex.chunk);
  expect(index.lines).toBe(500_000);
  expect(index.scanned).toBe(size);
});

test("saves under the tmp dir, loads for the same file, and starts over once the file was rewritten", async () => {
  const dir = folder(),
    store = join(dir, "lines"),
    path = join(dir, "a.log");
  writeFileSync(path, numbered(1, 100_000));
  const fh = counted(await open(path));
  let index = await lineIndex.LineIndex.load(fh, store);
  await lineIndex.find(fh, index, 50_000, { budget: Infinity });
  await index.save(fh);
  expect(readdirSync(store)).toHaveLength(1);
  const loaded = await lineIndex.LineIndex.load(fh, store);
  expect([loaded.scanned, loaded.lines, loaded.points]).toEqual([index.scanned, index.lines, index.points]);
  // An appended log keeps its indexed prefix.
  appendFileSync(path, numbered(100_001, 100_002));
  expect((await lineIndex.LineIndex.load(fh, store)).scanned).toBe(index.scanned);
  // A file rewritten under the same identity doesn't: its bytes at the scan's end differ.
  truncateSync(path, 0);
  writeFileSync(path, numbered(2, 100_000));
  index = await lineIndex.LineIndex.load(fh, store);
  expect([index.scanned, index.lines, index.points]).toEqual([0, 0, []]);
  // One shorter than the scan reached doesn't either.
  truncateSync(path, 100);
  expect((await lineIndex.LineIndex.load(fh, store)).scanned).toBe(0);
});

test("a budget stops the scan with how far it has to go, keeping what it read for the next", async () => {
  const dir = folder(),
    path = join(dir, "a.log");
  writeFileSync(path, numbered(1, 300_000));
  const fh = counted(await open(path)),
    index = await lineIndex.LineIndex.load(fh, dir),
    size = (await fh.info()).size,
    progress: lineIndex.Progress[] = [];
  const far = await lineIndex.find(fh, index, 299_000, {
    budget: 2 * lineIndex.chunk,
    progress: p => progress.push(p),
  });
  expect(far).toEqual({ kind: "far", bytes: size - 2 * lineIndex.chunk });
  expect(index.scanned).toBe(2 * lineIndex.chunk);
  expect(progress.at(-1)).toEqual({ scanned: 2 * lineIndex.chunk, size, lines: index.lines });
  // Asked again, it goes on from there rather than from the start.
  const read = fh.bytes;
  expect(await lineIndex.find(fh, index, 299_000, { budget: Infinity })).toEqual({
    kind: "found",
    at: expect.any(Number),
  });
  expect(fh.bytes - read).toBeLessThanOrEqual(size - 2 * lineIndex.chunk + lineIndex.chunk);
  // A signal stops it where it is.
  const abort = new AbortController();
  abort.abort();
  expect(lineIndex.find(fh, index, 300_001, { budget: Infinity, signal: abort.signal })).rejects.toThrow("Aborted");
});

test("keeps to its size: points thin out past the cap, and the oldest indexes go", async () => {
  const index = new lineIndex.LineIndex("1:1");
  for (let i = 1; i <= lineIndex.max_points + 1; i++) index.add(i * 10, i * lineIndex.first_stride);
  expect(index.points.length).toBeLessThanOrEqual(lineIndex.max_points);
  expect(index.stride).toBe(lineIndex.first_stride * 2);
  for (let i = 1; i < index.points.length; i++)
    expect(index.points[i].at - index.points[i - 1].at).toBeGreaterThanOrEqual(index.stride);
  const dir = folder(),
    store = join(dir, "lines");
  for (let i = 0; i < lineIndex.max_files; i++) {
    writeFileSync(join(dir, `f${i}`), "x\n");
    const fh = await open(join(dir, `f${i}`)),
      one = await lineIndex.LineIndex.load(fh, store);
    one.advance(2, 1);
    await one.save(fh);
  }
  expect(readdirSync(store)).toHaveLength(lineIndex.max_files);
});

test("an index directory that isn't the user's own private one is neither read nor pruned", async () => {
  const dir = folder(),
    elsewhere = join(dir, "elsewhere"),
    store = join(dir, "lines");
  mkdirSync(elsewhere);
  for (let i = 0; i < lineIndex.max_files + 2; i++) writeFileSync(join(elsewhere, `kept${i}.json`), "{}");
  // Planted where the index would go.
  symlinkSync(elsewhere, store);
  writeFileSync(join(dir, "f"), numbered(1, 10));
  const fh = await open(join(dir, "f")),
    index = await lineIndex.LineIndex.load(fh, store);
  expect(await lineIndex.find(fh, index, 5, whole)).toMatchObject({ kind: "found" });
  expect(readdirSync(elsewhere)).toHaveLength(lineIndex.max_files + 2);
});
