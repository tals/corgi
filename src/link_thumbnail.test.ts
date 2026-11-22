import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { png_base64 } from "./assets/corgi_badge";
import { blink } from "./gif.test";
import * as hostImages from "./host_images";
import { Rect } from "./layout";
import { Loader, bases, imagePath, place } from "./link_thumbnail";
import { fit } from "./link_tooltip";
import type { Thumbnail } from "./link_tooltip";

const cell = { width: 10, height: 20 },
  image = new hostImages.Image({ png: new Uint8Array() }),
  id = image.id;
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

test("only image files on this machine get a thumbnail", () => {
  expect(imagePath("file:///tmp/paste/Shot.PNG")).toBe("/tmp/paste/Shot.PNG");
  expect(imagePath("file://localhost/tmp/a%20b.jpeg")).toBe("/tmp/a b.jpeg");
  expect(imagePath(`file://${hostname()}/tmp/a.webp`)).toBe("/tmp/a.webp");
  expect(imagePath("file://elsewhere/tmp/a.png")).toBeNull();
  expect(imagePath("file:///tmp/notes.ts")).toBeNull();
  expect(imagePath("file:///tmp/png")).toBeNull();
  expect(imagePath("https://example.com/a.png")).toBeNull();
});

test("a thumbnail is centered in its cells", () => {
  const rect = new Rect(5, 3, 26, 9);
  expect(placed(rect, { width: 235, height: 90, cell, image })).toBe(
    `\x1b[7;7H\x1b_Ga=p,i=${id},p=1,X=2,Y=5,z=1,C=1,q=1\x1b\\`,
  );
  // A narrow picture in the card's minimum width starts columns in.
  expect(placed(new Rect(0, 0, 17, 5), { width: 40, height: 40, cell, image })).toBe(
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
    loader.get(`file://${join(dir, "a.png")}`, cell);
    await loader.loading;
    const loaded = loader.get(`file://${join(dir, "a.png")}`, cell)!;
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
    const uri = (name: string) => `file://${join(dir, name)}`;

    expect(loader.get(uri("tall.png"), cell)).toBeNull();
    await loader.loading;
    const tall = loader.get(uri("tall.png"), cell)!;
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
    loader.get(uri("small.png"), cell);
    await loader.loading;
    expect(loader.get(uri("small.png"), cell)).toMatchObject({
      width: badge.readUInt32BE(16),
      height: badge.readUInt32BE(20),
    });

    for (const name of ["fake.png", "missing.png"]) {
      loader.get(uri(name), cell);
      await loader.loading;
      expect(loader.get(uri(name), cell)).toBeNull();
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
    const uri = `file://${join(dir, "blink.gif")}`;
    loader.get(uri, cell);
    await loader.loading;
    const shown = loader.get(uri, cell)!;
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
