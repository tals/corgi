import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { png_base64 } from "./assets/corgi_badge";
import * as fileAccess from "./file_access";
import { blink } from "./gif.test";
import * as hostImages from "./host_images";
import { Rect } from "./layout";
import { Loader, isImage, place } from "./link_thumbnail";
import { fit } from "./link_tooltip";
import type { Thumbnail } from "./link_tooltip";
import { bases } from "./picture";
import * as protocol from "./protocol";

const cell = { width: 10, height: 20 },
  image = new hostImages.Image({ png: new Uint8Array() }),
  id = image.id;
const here = fileAccess.here;
/** Places `t` alone in a frame. */
function placed(rect: Rect, t: Thumbnail): string {
  const frame = new hostImages.FrameImages(cell);
  place(frame, rect, t);
  return frame.commands();
}
/** What `store` writes around a frame whose card shows `t`, or shows none. */
function show(store: hostImages.Store, t: Thumbnail | null) {
  const frame = store.frame(cell);
  if (t) place(frame, new Rect(0, 0, 80, 30), t);
  return store.present();
}

test("only image files get a thumbnail", () => {
  expect(isImage("/tmp/paste/Shot.PNG")).toBe(true);
  expect(isImage("shots/a b.jpeg")).toBe(true);
  expect(isImage("/tmp/notes.ts")).toBe(false);
  expect(isImage("/tmp/png")).toBe(false);
  expect(isImage("/tmp/.png/a")).toBe(false);
});

test("a thumbnail is centered in its cells", () => {
  const rect = new Rect(5, 3, 26, 9);
  expect(placed(rect, { width: 235, height: 90, cell, image })).toBe(
    `\x1b[7;7H\x1b_Ga=p,i=${id},p=1,X=2,Y=5,z=1,C=1,q=1\x1b\\`,
  );
  // A narrow picture in the card's minimum width starts columns in.
  expect(placed(new Rect(0, 0, 17, 6), { width: 40, height: 40, cell, image })).toBe(
    `\x1b[4;7H\x1b_Ga=p,i=${id},p=1,X=5,z=1,C=1,q=1\x1b\\`,
  );
});

test("a thumbnail too big for the screen is scaled down by the host, and kept", async () => {
  const t = { width: 400, height: 480, cell, image };
  // Room below the link for it whole.
  expect(fit(100, 40, { x: 0, y: 2 }, t)).toBe(t);
  // In the middle, it shrinks to fit above the link: 26 rows less a border, copy row and rule.
  const shrunk = fit(100, 40, { x: 0, y: 26 }, t)!;
  expect(shrunk).toEqual({ width: 370, height: 440, cell, of: t });
  expect(placed(new Rect(0, 1, 39, 26), shrunk)).toContain(",c=37,r=22,");
  expect(fit(100, 6, { x: 0, y: 3 }, t)).toBeNull();

  const dir = mkdtempSync(join(tmpdir(), "corgi-thumb-"));
  try {
    writeFileSync(
      join(dir, "a.png"),
      await new Bun.Image(Buffer.from(png_base64, "base64")).resize(400, 480).png().buffer(),
    );
    const loader = new Loader(() => {});
    loader.get(join(dir, "a.png"), here, cell);
    await loader.loading;
    const loaded = loader.get(join(dir, "a.png"), here, cell)!;
    const store = new hostImages.Store();
    expect(show(store, fit(100, 40, { x: 0, y: 26 }, loaded)).send).toStartWith("\x1b_Ga=t,");
    expect(show(store, loaded).send).toBe("");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the loader shrinks the hovered image, sends it once, and frees it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-thumb-"));
  try {
    const badge = Buffer.from(png_base64, "base64");
    writeFileSync(join(dir, "tall.png"), await new Bun.Image(badge).resize(300, 900).png().buffer());
    writeFileSync(join(dir, "small.png"), badge);
    writeFileSync(join(dir, "fake.png"), "not an image");
    let wakes = 0;
    const loader = new Loader(() => wakes++);
    const at = (name: string) => join(dir, name);

    expect(loader.get(at("tall.png"), here, cell)).toBeNull();
    await loader.loading;
    const tall = loader.get(at("tall.png"), here, cell)!;
    // 24 rows tall at most, keeping the aspect.
    expect(tall).toMatchObject({ width: 160, height: 480 });
    expect(wakes).toBe(1);
    const store = new hostImages.Store(),
      id = tall.image!.id;
    expect(show(store, tall).send).toStartWith(`\x1b_Ga=t,t=d,f=100,i=${id},q=1,m=`);
    expect(show(store, tall)).toMatchObject({ send: "", draw: "", free: "" });
    // No card shows it: the host frees it, and takes it again for the next card.
    expect(show(store, null)).toMatchObject({ send: "", free: `\x1b_Ga=d,d=I,i=${id},q=2\x1b\\` });
    expect(show(store, null)).toEqual({ send: "", draw: "", redraw: "", free: "" });
    expect(show(store, tall).send).toStartWith("\x1b_Ga=t,");

    // Small images keep their size.
    loader.get(at("small.png"), here, cell);
    await loader.loading;
    expect(loader.get(at("small.png"), here, cell)).toMatchObject({
      width: badge.readUInt32BE(16),
      height: badge.readUInt32BE(20),
    });

    for (const name of ["fake.png", "missing.png"]) {
      loader.get(at(name), here, cell);
      await loader.loading;
      expect(loader.get(at(name), here, cell)).toBeNull();
    }
    expect(wakes).toBe(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an animated GIF is sent as a Kitty animation that loops", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-thumb-"));
  try {
    writeFileSync(join(dir, "blink.gif"), blink);
    const loader = new Loader(() => {});
    const path = join(dir, "blink.gif");
    loader.get(path, here, cell);
    await loader.loading;
    const shown = loader.get(path, here, cell)!;
    expect(shown).toMatchObject({ width: 20, height: 10 });
    const sent = show(new hostImages.Store(), shown).send,
      id = shown.image!.id;
    expect(sent).toStartWith(`\x1b_Ga=t,t=d,f=100,i=${id},q=1,m=0;`);
    expect(sent).toContain(`\x1b_Ga=f,t=d,f=100,i=${id},x=12,y=2,c=1,z=100,q=2,m=0;`);
    expect(sent).toEndWith(`\x1b_Ga=a,i=${id},r=1,z=200,q=2\x1b\\\x1b_Ga=a,i=${id},s=3,v=1,q=2\x1b\\`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("each GIF frame is drawn over the picture its disposal leaves", () => {
  const frame = (disposal: number, whole = false) => ({
    still: new Uint8Array(),
    left: whole ? 0 : 4,
    top: whole ? 0 : 2,
    width: whole ? 20 : 4,
    height: whole ? 10 : 4,
    delay: 100,
    disposal,
  });
  const of = (...frames: ReturnType<typeof frame>[]) => bases({ width: 20, height: 10, frames });
  // Kept frames build on the last; a restored one is undone, back to what it was drawn over.
  expect(of(frame(1, true), frame(1), frame(3), frame(3), frame(0))).toEqual([1, 2, 2, 2]);
  expect(of(frame(1, true), frame(0), frame(3), frame(1), frame(3), frame(1))).toEqual([1, 2, 2, 4, 4]);
  // A cleared whole frame, or a part of a clear canvas, leaves it clear.
  expect(of(frame(2, true), frame(2), frame(1))).toEqual([0, 0]);
  // Clearing part of a picture can't be composed.
  expect(of(frame(1, true), frame(2), frame(1))).toBeNull();
});

test("another computer's image is shrunk by its daemon, which sends only the thumbnail", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-thumb-"));
  try {
    const photo = join(dir, "photo.png"),
      gif = join(dir, "blink.gif");
    writeFileSync(photo, await new Bun.Image(Buffer.from(png_base64, "base64")).resize(2400, 1800).png().buffer());
    writeFileSync(gif, blink);
    // Each request crosses as JSON and is decoded as the daemon decodes it.
    const asked: string[] = [];
    let crossed = 0;
    const there = fileAccess.remote(async (op, payload) => {
      asked.push(op);
      const reply = JSON.stringify(
        await fileAccess.answer(protocol.decoded(op, JSON.parse(JSON.stringify(payload))) as any),
      );
      crossed += reply.length;
      return JSON.parse(reply);
    });
    const loader = new Loader(() => {});
    loader.get(photo, there, cell);
    await loader.loading;
    const shown = loader.get(photo, there, cell)!;
    // The same as it shrinks here, in one request carrying a fraction of the file.
    const local = await here.thumbnail(photo, { width: 640, height: 480 });
    expect(shown).toMatchObject({ width: local.width, height: local.height });
    expect(asked).toEqual(["file.thumbnail"]);
    expect(crossed).toBeLessThan(Bun.file(photo).size / 2);
    expect(show(new hostImages.Store(), shown).send).toStartWith(`\x1b_Ga=t,t=d,f=100,i=${shown.image!.id},q=1,m=`);
    // An animated GIF keeps its frames.
    loader.get(gif, there, cell);
    await loader.loading;
    const playing = loader.get(gif, there, cell)!;
    expect(show(new hostImages.Store(), playing).send).toContain(
      `\x1b_Ga=f,t=d,f=100,i=${playing.image!.id},x=12,y=2,c=1,z=100`,
    );
    // A file that isn't an image has none.
    writeFileSync(join(dir, "fake.png"), "not an image");
    loader.get(join(dir, "fake.png"), there, cell);
    await loader.loading;
    expect(loader.get(join(dir, "fake.png"), there, cell)).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
