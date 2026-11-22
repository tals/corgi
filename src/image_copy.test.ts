import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { png_base64 } from "./assets/corgi_badge";
import * as fileAccess from "./file_access";
import { Copies, copyName } from "./image_copy";
import * as protocol from "./protocol";
import { Openers } from "./url_opener";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "corgi-copies-"));
  dirs.push(dir);
  return dir;
}
const png = Buffer.from(png_base64, "base64");
/** Another computer's files as a daemon here answers for them, each request crossing as JSON. */
function daemon(): { files: fileAccess.Files; asked: string[] } {
  const asked: string[] = [];
  const files = fileAccess.remote(async (op, payload) => {
    asked.push(op);
    const wire = JSON.parse(JSON.stringify(payload));
    return JSON.parse(JSON.stringify(await fileAccess.answer(protocol.decoded(op as fileAccess.Op, wire) as any)));
  });
  return { files, asked };
}
/** A computer whose every file holds `bytes`, though it says it holds
 * `size`, and whose reads bring `extra` bytes more than asked for. */
function lying(bytes: Uint8Array, size = bytes.length, extra = 0): { files: fileAccess.Files; reads: number[] } {
  const reads: number[] = [];
  const handle: fileAccess.Handle = {
    now: null,
    info: async () => ({ path: "/x", size, mtime: 0, id: "1:1", directory: false }),
    read: async (at, length) => {
      reads.push(length);
      return Uint8Array.from({ length: length + extra }, (_, i) => bytes[at + i] ?? 0x41);
    },
    find: async () => ({ kind: "missing", size }),
    newlines: async () => 0,
    close: async () => {},
  };
  const files: fileAccess.Files = {
    limits: { ...fileAccess.remote_limits, whole: 100 },
    find: async () => handle.info(),
    open: async () => handle,
    watch: () => null,
    thumbnail: async () => {
      throw Error("Unsupported");
    },
    list: async () => {
      throw Error("Unsupported");
    },
    walk: async () => {
      throw Error("Unsupported");
    },
  };
  return { files, reads };
}

test("another computer's image is copied whole into a private folder under its own name", async () => {
  const there = folder(),
    root = folder();
  const path = join(there, "a shot #1.png");
  writeFileSync(path, png);
  const { files, asked } = daemon();
  const copies = new Copies(root);
  const copy = await copies.fetch(files, path);
  expect(basename(copy)).toBe("a shot #1.png");
  expect(dirname(dirname(copy))).toBe(root);
  expect(basename(dirname(copy))).toStartWith("corgi-image-copy-");
  expect(readFileSync(copy)).toEqual(png);
  expect(statSync(dirname(copy)).mode & 0o777).toBe(0o700);
  expect(statSync(copy).mode & 0o777).toBe(0o600);
  // It checks the image didn't change while it copied.
  expect(asked).toEqual(["file.stat", "file.read", "file.stat"]);
  // Opened again, the image is the same copy, until it changes.
  asked.length = 0;
  expect(await copies.fetch(files, path)).toBe(copy);
  expect(asked).toEqual(["file.stat"]);
  writeFileSync(path, Buffer.concat([png, Buffer.from("changed")]));
  const again = await copies.fetch(files, path);
  expect(dirname(again)).not.toBe(dirname(copy));
  expect(readFileSync(again)).toEqual(Buffer.concat([png, Buffer.from("changed")]));
  // The copy a desktop viewer may still have open stays.
  expect(readFileSync(copy)).toEqual(png);
  // The opener checks the copy as it does any image here.
  writeFileSync(join(there, "notes.png"), "plain text");
  await expect(new Openers().openImage(await copies.fetch(files, join(there, "notes.png")))).rejects.toThrow(
    "NotAnImage",
  );
});

test("a copy stops at the image limit, and at the size the daemon gave, whatever its replies carry", async () => {
  const root = folder();
  const big = lying(png, 1001);
  await expect(new Copies(root, 1000).fetch(big.files, "/x/big.png")).rejects.toThrow("TooLarge");
  expect(big.reads).toEqual([]);
  expect(readdirSync(root)).toEqual([]);
  // Each read asks for a step's worth, and what comes back past it is dropped.
  const generous = lying(png, png.length, 64);
  const copy = await new Copies(root, png.length).fetch(generous.files, "/x/shot.png");
  expect(readFileSync(copy)).toEqual(png);
  expect(generous.reads.every(n => n <= 100)).toBe(true);
  expect(generous.reads.reduce((a, b) => a + b, 0)).toBe(png.length);
});

test("a copy's name stays inside its folder and keeps the image's type", async () => {
  expect(copyName("/home/me/shots/../../etc/evil.png")).toBe("evil.png");
  expect(copyName("/tmp/a\nb\x1b[31m\x9b.png")).toBe("a_b_[31m_.png");
  expect(copyName("shot.png/")).toBe("shot.png");
  expect(copyName("/tmp/..")).toBe("image");
  expect(copyName("/")).toBe("image");
  expect(copyName("C:\\Users\\me\\..\\shot.png")).toBe("C:\\Users\\me\\..\\shot.png");
  const root = folder();
  const { files, reads } = lying(png);
  // A name that isn't an image's isn't read at all.
  await expect(new Copies(root).fetch(files, "/x/..")).rejects.toThrow("NotAnImage");
  await expect(new Copies(root).fetch(files, "/x/notes.txt")).rejects.toThrow("NotAnImage");
  expect(reads).toEqual([]);
  expect(readdirSync(root)).toEqual([]);
  const copy = await new Copies(root).fetch(files, "/x/\x1b]0;hi\x07.png");
  expect(basename(copy)).toBe("_]0;hi_.png");
  expect(dirname(dirname(copy))).toBe(root);
});

test("a viewer removes its copies as it exits, and the next copy removes an earlier viewer's old ones", async () => {
  const root = folder();
  const { files } = lying(png);
  const day = 24 * 60 * 60;
  const left = (name: string, age: number) => {
    const dir = join(root, name);
    mkdirSync(dir);
    writeFileSync(join(dir, "shot.png"), png);
    const when = Date.now() / 1000 - age;
    utimesSync(dir, when, when);
    return dir;
  };
  const old = left("corgi-image-copy-old", 2 * day),
    recent = left("corgi-image-copy-new", 60),
    other = left("corgi-other-old", 2 * day);
  const copies = new Copies(root);
  const first = await copies.fetch(files, "/x/first.png");
  expect(existsSync(old)).toBe(false);
  expect(existsSync(recent)).toBe(true);
  expect(existsSync(other)).toBe(true);
  // This viewer's own copies stay while it runs, however old.
  utimesSync(dirname(first), Date.now() / 1000 - 2 * day, Date.now() / 1000 - 2 * day);
  const second = await copies.fetch(files, "/x/second.png");
  expect(existsSync(first)).toBe(true);
  // A failed copy leaves nothing behind.
  const failing = {
    ...files,
    open: async () => ({
      ...(await files.open("/x")),
      read: async () => {
        throw Error("FileChanged");
      },
    }),
  };
  await expect(copies.fetch(failing, "/x/third.png")).rejects.toThrow("FileChanged");
  expect(readdirSync(root).sort()).toEqual(
    [basename(dirname(first)), basename(dirname(second)), basename(recent), basename(other)].sort(),
  );
  copies.close();
  expect(readdirSync(root).sort()).toEqual([basename(recent), basename(other)].sort());
});

test("opening an image again while it copies waits for the same copy", async () => {
  const root = folder();
  const { files, reads } = lying(png);
  const copies = new Copies(root);
  const [a, b] = await Promise.all([copies.fetch(files, "/x/shot.png"), copies.fetch(files, "/x/shot.png")]);
  expect(a).toBe(b);
  expect(reads.reduce((sum, n) => sum + n, 0)).toBe(png.length);
  expect(readdirSync(root)).toHaveLength(1);
});

test("a copy cut short, or of an image that changes as it copies, fails and leaves nothing", async () => {
  const root = folder();
  const { files } = lying(png);
  // The image ends early, as one still being written does.
  const short = {
    ...files,
    open: async () => ({
      ...(await files.open("/x")),
      read: async (at: number) => png.subarray(at, Math.min(at + 100, 100)),
    }),
  };
  await expect(new Copies(root).fetch(short, "/x/shot.png")).rejects.toThrow("FileChanged");
  // The image grows past the size it had when the copy began.
  let mtime = 0;
  const growing = {
    ...files,
    open: async () => {
      const handle = await files.open("/x");
      return { ...handle, info: async () => ({ ...(await handle.info()), mtime: mtime++ }) };
    },
  };
  await expect(new Copies(root).fetch(growing, "/x/shot.png")).rejects.toThrow("FileChanged");
  expect(readdirSync(root)).toEqual([]);
});

test("a copy that finishes after the viewer exits is removed and opens nothing", async () => {
  const root = folder();
  const { files } = lying(png);
  let release = () => {};
  const held = new Promise<void>(resolve => (release = resolve));
  const slow = {
    ...files,
    open: async () => {
      const handle = await files.open("/x");
      return { ...handle, read: async (at: number, length: number) => (await held, handle.read(at, length)) };
    },
  };
  const copies = new Copies(root);
  const copying = copies.fetch(slow, "/x/shot.png");
  await Bun.sleep(10);
  copies.close();
  release();
  await expect(copying).rejects.toThrow("Closed");
  await expect(copies.fetch(files, "/x/shot.png")).rejects.toThrow("Closed");
  expect(readdirSync(root)).toEqual([]);
});
