import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { png_base64 } from "./assets/corgi_badge";
import * as fileAccess from "./file_access";
import * as fileSource from "./file_source";
import { Source } from "./file_source";
import { blink } from "./gif.test";
import * as jobs from "./jobs";
import * as protocol from "./protocol";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
// Line indexes go to a folder of their own, not the user's.
const indexes = mkdtempSync(join(tmpdir(), "corgi-lines-"));
beforeAll(() => {
  process.env.CORGI_LINE_INDEX_DIR = indexes;
});
afterAll(() => {
  delete process.env.CORGI_LINE_INDEX_DIR;
  rmSync(indexes, { recursive: true, force: true });
});
function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "corgi-access-"));
  dirs.push(dir);
  return dir;
}
/** Another computer's files as a daemon here answers for them, each
 * request crossing as JSON and decoded as the daemon decodes it; a scan
 * for a line runs as a job there. */
function daemon(): { files: fileAccess.Files; asked: string[]; jobs: jobs.Jobs } {
  const asked: string[] = [],
    all = new jobs.Jobs(),
    owner = {};
  const files = fileAccess.remote(async (op, payload) => {
    asked.push(op);
    const wire = JSON.parse(JSON.stringify(payload));
    const answer =
      op === "file.scan"
        ? all.begin(owner, job => fileAccess.scan(protocol.decode("file.scan", wire), job), wire.wait)
        : op === "job.poll"
          ? all.poll(owner, wire.job, wire.wait)
          : op === "job.cancel"
            ? Promise.resolve(all.cancel(owner, wire.job) ?? {})
            : fileAccess.answer(protocol.decoded(op, wire) as any);
    return JSON.parse(JSON.stringify(await answer));
  });
  return { files, asked, jobs: all };
}
const numbered = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}`).join("\n") + "\n";
const rows = (s: Source) => Array.from({ length: s.count }, (_, i) => s.line(i));

test("finds a pane's file from its folder or home, as a diff names it too, and a folder when asked", async () => {
  const dir = folder();
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "a.ts"), "x");
  const here = fileAccess.local(dir),
    file = join(dir, "src", "a.ts");
  expect(await here.find("src/a.ts", dir)).toMatchObject({ path: file, size: 1 });
  expect((await here.find("~/src/a.ts", "/")).path).toBe(file);
  expect((await here.find("b/src/a.ts", dir)).path).toBe(file);
  expect(here.find("src", dir)).rejects.toThrow("NotAFile");
  expect(await here.find("src", dir, true)).toMatchObject({ path: join(dir, "src"), directory: true });
  expect((await here.find("src/a.ts", dir, true)).directory).toBe(false);
  expect(here.open(join(dir, "src"))).rejects.toThrow("NotAFile");
  expect(here.find("nope.ts", dir)).rejects.toThrow();
  // Another computer's daemon finds it the same way.
  expect(await daemon().files.find("src/a.ts", dir)).toEqual(await here.find("src/a.ts", dir));
});

test("lists a folder's entries with what links lead to, up to a limit", async () => {
  const dir = folder();
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "a.txt"), "abc");
  symlinkSync(join(dir, "sub"), join(dir, "to-sub"));
  symlinkSync(join(dir, "gone"), join(dir, "broken"));
  const { entries, more } = await fileAccess.here.list(dir);
  expect(more).toBe(false);
  expect(entries.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
    { name: "a.txt", directory: false, link: false, size: 3 },
    { name: "broken", directory: false, link: true, size: 0 },
    { name: "sub", directory: true, link: false, size: 0 },
    { name: "to-sub", directory: true, link: true, size: 0 },
  ]);
  expect(fileAccess.here.list(join(dir, "a.txt"))).rejects.toThrow();
  const many = folder();
  for (let i = 0; i <= fileAccess.list_limit; i++) writeFileSync(join(many, `f${i}`), "");
  const listed = await fileAccess.here.list(many);
  expect(listed.entries).toHaveLength(fileAccess.list_limit);
  expect(listed.more).toBe(true);
});

test("reads another computer's file through its daemon, a megabyte a request", async () => {
  const dir = folder(),
    path = join(dir, "big.ts"),
    text = Buffer.alloc(fileAccess.read_limit * 2 + 100, "abc\n");
  writeFileSync(path, text);
  const { files, asked } = daemon();
  const h = await files.open(path);
  expect(Buffer.from(await h.read(0, text.length)).equals(text)).toBe(true);
  expect(asked.filter(op => op === "file.read")).toHaveLength(3);
  expect(h.now).toBeNull();
  const go = () => {},
    whole = { budget: Infinity };
  expect(await h.find(1, whole)).toEqual({ kind: "found", at: 0 });
  expect(await h.find(3, whole)).toEqual({ kind: "found", at: 8 });
  expect(await h.find(text.length, whole)).toEqual({ kind: "missing", size: text.length });
  expect(await h.newlines(0, 40, go)).toBe(10);
  const local = await fileAccess.here.open(path);
  expect(await h.info()).toEqual(await local.info());
  await local.close();
  expect(files.open(join(dir, "gone.ts"))).rejects.toThrow();
  // It sends no change notices: a reader polls.
  expect(files.watch(path, go, go)).toBeNull();
});

test("a file peek reads another computer's code and follows its log, through a line its text named and a rotation", async () => {
  const dir = folder(),
    code = join(dir, "app.ts"),
    log = join(dir, "app.log");
  writeFileSync(code, "one\ntwo\n");
  writeFileSync(log, numbered(1, 300_000));
  const { files, asked } = daemon();
  const c = await Source.open(code, { files, follow: false });
  const s = await Source.open(log, { files, follow: false, line: 123_456 });
  // Code opens in two round trips, and a log at a line in three: a block's parts are asked for together.
  expect(asked.splice(0)).toEqual(["file.stat", "file.read", "file.stat", "file.scan", ...Array(4).fill("file.read")]);
  try {
    expect([c.mode, c.lines]).toEqual(["code", ["one", "two"]]);
    writeFileSync(code, "one\ntwo\nthree\n");
    await c.refresh();
    expect(c.lines).toEqual(["one", "two", "three"]);
    expect(s.line(s.rowOf(123_456)!)).toBe("line 123456");
    appendFileSync(log, numbered(300_001, 300_002));
    await s.refresh();
    expect(s.added).toBe(2);
    await s.toEnd();
    appendFileSync(log, numbered(300_003, 300_003));
    await s.refresh();
    expect(s.line(s.count - 1)).toBe("line 300003");
    renameSync(log, log + ".1");
    writeFileSync(log, "fresh\n");
    await s.refresh();
    expect(rows(s)).toEqual(["fresh"]);
    // A poll that finds nothing new takes one round trip.
    asked.splice(0);
    await s.refresh();
    expect(asked).toEqual(["file.stat"]);
  } finally {
    await c.close();
    await s.close();
  }
});

test("another computer's log rotated between its lookup and reads is read anew, not mixed with the old", async () => {
  const dir = folder(),
    log = join(dir, "app.log");
  let generation = 0;
  const rotate = (lines: number) => {
    renameSync(log, `${log}.${++generation}`);
    writeFileSync(log, numbered(1, lines).replaceAll("line", `new${generation}`));
  };
  // Rotates the log as the next read, after the lookup that found it, reaches the daemon.
  let before: number | null = null;
  const files = fileAccess.remote(async (op, payload) => {
    if (op === "file.read" && before !== null) {
      rotate(before);
      before = null;
    }
    const wire = JSON.parse(JSON.stringify(payload));
    return JSON.parse(JSON.stringify(await fileAccess.answer(protocol.decoded(op, wire) as any)));
  });
  writeFileSync(log, numbered(1, 100_000));
  // As it opens.
  before = 50_000;
  const s = await Source.open(log, { files, follow: false });
  try {
    expect(s.line(s.count - 1)).toBe("new1 50000");
    expect(rows(s).every(row => row.startsWith("new1 "))).toBe(true);
    // As it follows growth.
    appendFileSync(log, numbered(50_001, 50_010).replaceAll("line", "new1"));
    before = 30_000;
    await s.refresh(false);
    expect(s.line(s.count - 1)).toBe("new2 30000");
    expect(rows(s).every(row => row.startsWith("new2 "))).toBe(true);
    // As it reads further back.
    before = 20_000;
    await s.earlier();
    expect(s.line(s.count - 1)).toBe("new3 20000");
    expect(rows(s).every(row => row.startsWith("new3 "))).toBe(true);
    expect(s.error).toBeNull();
  } finally {
    await s.close();
  }
});

test("another computer's files cross its link in smaller amounts: less read whole, a binary file's first block, and growth past a block starts again at the end", async () => {
  const dir = folder(),
    code = join(dir, "big.ts"),
    bin = join(dir, "photo.jpg"),
    log = join(dir, "app.log");
  writeFileSync(code, numbered(1, 100_000));
  writeFileSync(bin, Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0]), Buffer.alloc(512 << 10, 1)]));
  writeFileSync(log, "start\n");
  const { files, asked } = daemon();
  const opened: Source[] = [];
  try {
    const c = await Source.open(code, { files, follow: false });
    opened.push(c);
    expect(c.mode).toBe("tail");
    asked.splice(0);
    // Read here, the same file is code.
    const local = await Source.open(code, { follow: false });
    opened.push(local);
    expect(local.mode).toBe("code");
    const b = await Source.open(bin, { files, follow: false });
    opened.push(b);
    expect([b.binary, b.size]).toEqual([true, (512 << 10) + 5]);
    expect(asked.filter(op => op === "file.read")).toHaveLength(fileSource.block / fileAccess.read_limit);
    const s = await Source.open(log, { files, follow: false });
    opened.push(s);
    appendFileSync(log, numbered(1, 30_000));
    await s.refresh();
    expect(s.restarts).toBe(1);
    expect(s.line(s.count - 1)).toBe("line 30000");
  } finally {
    for (const s of opened) await s.close();
  }
});

test("a daemon reads only the file it was asked for, without waiting on a FIFO, and scans for a line as a job", async () => {
  const dir = folder(),
    fifo = join(dir, "pipe"),
    log = join(dir, "deep.log");
  Bun.spawnSync(["mkfifo", fifo]);
  writeFileSync(log, numbered(1, 1000));
  const { id, size } = await fileAccess.here.find(log);
  const ask = (op: fileAccess.Op, payload: object) => fileAccess.answer(protocol.decoded(op, payload) as any);
  expect(ask("file.read", { path: fifo, id, at: 0, length: 10 })).rejects.toThrow("NotAFile");
  expect(ask("file.read", { path: dir, id, at: 0, length: 10 })).rejects.toThrow("NotAFile");
  expect(ask("file.thumbnail", { path: fifo, width: 10, height: 10, pixels: 100 })).rejects.toThrow("NotAFile");
  // Its path names another file than the one it was found to be.
  expect(ask("file.read", { path: log, id: "0:0", at: 0, length: 10 })).rejects.toThrow("FileChanged");
  const all = new jobs.Jobs(),
    owner = {},
    scan = (payload: object, wait = 1000) =>
      all.begin(owner, job => fileAccess.scan(protocol.decode("file.scan", payload), job), wait);
  expect(scan({ path: log, id: "0:0", line: 500, budget: 1 << 30 })).resolves.toMatchObject({
    done: true,
    error: "FileChanged",
  });
  const found = await scan({ path: log, id, line: 500, budget: 1 << 30 });
  expect(found).toMatchObject({ done: true, results: [{ kind: "found", at: 4383 }] });
  // Without a budget, a line past where the index's scan stopped is far, from there; one it passed is found.
  expect((await scan({ path: log, id, line: 900, budget: 0 })).results).toEqual([{ kind: "far", bytes: size - 4383 }]);
  expect((await scan({ path: log, id, line: 400, budget: 0 })).results).toEqual([{ kind: "found", at: 3483 }]);
  // Past what the index knows of a larger one, a line is far without a budget.
  // Its lines differ from the other files', so an index of one of them, were its inode reused, is seen as stale.
  const slow = join(dir, "slow.log");
  writeFileSync(slow, Array.from({ length: 400_000 }, (_, i) => `slow ${i + 1}`).join("\n") + "\n");
  const { id: slow_id, size: slow_size } = await fileAccess.here.find(slow);
  expect((await scan({ path: slow, id: slow_id, line: 399_999, budget: 0 })).results).toEqual([
    { kind: "far", bytes: slow_size },
  ]);
  // The scan's progress reaches a poll, and a cancel stops it.
  const begun = await scan({ path: slow, id: slow_id, line: 399_999, budget: 1 << 30 }, 0);
  const stops: string[] = [];
  const stopped = all.begin(
    owner,
    job =>
      new Promise((_, reject) =>
        job.signal.addEventListener("abort", () => {
          stops.push((job.signal.reason as Error).message);
          reject(job.signal.reason);
        }),
      ),
    0,
  );
  all.cancel(owner, (await stopped).job);
  expect(stops).toEqual(["Cancelled"]);
  let news = begun;
  while (!news.done) news = { job: begun.job, ...(await all.poll(owner, begun.job, 1000)) };
  expect(news.results).toEqual([{ kind: "found", at: expect.any(Number) }]);
  expect(news.progress).toMatchObject({ lines: 399_998, size: expect.any(Number) });
});

test("a thumbnail too big for a daemon's reply is sent as large as fits it, or still", async () => {
  const box = { width: 640, height: 480 },
    pixels = fileAccess.remote_limits.frames;
  const base64 = (p: { png: Uint8Array; frames: { png: Uint8Array }[] }) =>
    [p.png, ...p.frames.map(f => f.png)].reduce((sum, png) => sum + Buffer.from(png).toString("base64").length, 0);
  const photo = await new Bun.Image(Buffer.from(png_base64, "base64")).resize(2400, 1800).png().buffer();
  const whole = await fileAccess.sendable(photo, box, pixels, Infinity);
  const half = Math.floor(base64(whole) / 2);
  const smaller = await fileAccess.sendable(photo, box, pixels, half);
  expect(base64(smaller)).toBeLessThanOrEqual(half);
  // Made at a few sizes about the estimate, not shrunk well past it.
  expect(base64(smaller)).toBeGreaterThan(half * 0.7);
  expect(smaller.width).toBeLessThan(whole.width);
  expect(smaller.width / smaller.height).toBeCloseTo(whole.width / whole.height, 1);

  const playing = await fileAccess.sendable(blink, box, pixels, Infinity);
  expect(playing.frames.length).toBeGreaterThan(0);
  // Its frames made smaller don't fit either, so its first shows.
  const still = await fileAccess.sendable(blink, box, pixels, base64(playing) - 1);
  expect(still).toMatchObject({ width: playing.width, height: playing.height, frames: [] });

  await expect(fileAccess.sendable(photo, box, pixels, 10)).rejects.toThrow("TooLarge");
  // A daemon's own replies stay under it.
  expect(fileAccess.thumbnail_limit).toBeLessThan(4 << 20);
});

test.if(process.platform === "linux")("reads a file in /proc, which gives no size, to its end", async () => {
  const s = await Source.open("/proc/self/status", { follow: false });
  try {
    expect(s.mode).toBe("code");
    expect(s.lines.some(line => line.startsWith("Pid:"))).toBe(true);
  } finally {
    await s.close();
  }
});
