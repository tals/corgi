import { afterEach, expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fileAccess from "./file_access";
import * as fileSource from "./file_source";
import { Source } from "./file_source";
import * as protocol from "./protocol";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "corgi-access-"));
  dirs.push(dir);
  return dir;
}
/** Another computer's files as a daemon here answers for them, each
 * request crossing as JSON and decoded as the daemon decodes it. */
function daemon(): { files: fileAccess.Files; asked: string[] } {
  const asked: string[] = [];
  const files = fileAccess.remote(async (op, payload) => {
    asked.push(op);
    const wire = JSON.parse(JSON.stringify(payload));
    return JSON.parse(JSON.stringify(await fileAccess.answer(protocol.decoded(op, wire) as any)));
  });
  return { files, asked };
}
const numbered = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}`).join("\n") + "\n";
const rows = (s: Source) => Array.from({ length: s.count }, (_, i) => s.line(i));

test("finds a pane's file from its folder or home, as a diff names it too, and only files", async () => {
  const dir = folder();
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "a.ts"), "x");
  const here = fileAccess.local(dir),
    file = join(dir, "src", "a.ts");
  expect(await here.find("src/a.ts", dir)).toMatchObject({ path: file, size: 1 });
  expect((await here.find("~/src/a.ts", "/")).path).toBe(file);
  expect((await here.find("b/src/a.ts", dir)).path).toBe(file);
  expect(here.find("src", dir)).rejects.toThrow("NotAFile");
  expect(here.open(join(dir, "src"))).rejects.toThrow("NotAFile");
  expect(here.find("nope.ts", dir)).rejects.toThrow();
  // Another computer's daemon finds it the same way.
  expect(await daemon().files.find("src/a.ts", dir)).toEqual(await here.find("src/a.ts", dir));
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
  const go = () => {};
  expect(await h.line(1, text.length, go)).toBe(0);
  expect(await h.line(3, text.length, go)).toBe(8);
  expect(await h.line(text.length, text.length, go)).toBe(-1);
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
  expect(asked.splice(0)).toEqual(["file.stat", "file.read", "file.stat", "file.line", ...Array(4).fill("file.read")]);
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

test("a daemon reads only files, without waiting on a FIFO, and gives up a long scan for a line", async () => {
  const dir = folder(),
    fifo = join(dir, "pipe"),
    log = join(dir, "deep.log");
  Bun.spawnSync(["mkfifo", fifo]);
  writeFileSync(log, numbered(1, 1000));
  const ask = (op: fileAccess.Op, payload: object) => fileAccess.answer(protocol.decoded(op, payload) as any);
  expect(ask("file.read", { path: fifo, at: 0, length: 10 })).rejects.toThrow("NotAFile");
  expect(ask("file.read", { path: dir, at: 0, length: 10 })).rejects.toThrow("NotAFile");
  expect(ask("file.thumbnail", { path: fifo, width: 10, height: 10, pixels: 100 })).rejects.toThrow("NotAFile");
  expect(await ask("file.line", { path: log, line: 500, limit: 1 << 30 })).toEqual({ at: 4383 });
  const now = spyOn(Date, "now")
    .mockReturnValueOnce(0)
    .mockReturnValue(fileAccess.scan_ms + 1);
  try {
    expect(await ask("file.line", { path: log, line: 500, limit: 1 << 30 })).toEqual({ at: -1 });
  } finally {
    now.mockRestore();
  }
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
