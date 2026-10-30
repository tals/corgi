import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { png_base64 } from "./assets/corgi_badge";
import { blink } from "./gif.test";
import { Rect } from "./layout";
import { Loader, imagePath, place, remove } from "./link_thumbnail";
import { fit } from "./link_tooltip";

const cell = { width: 10, height: 20 };

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
  expect(place(rect, { width: 235, height: 90, cell })).toBe(
    "\x1b7\x1b[7;7H\x1b_Ga=p,i=730140,p=1,X=2,Y=5,z=1,C=1,q=2\x1b\\\x1b8",
  );
  // A narrow picture in the card's minimum width starts columns in.
  expect(place(new Rect(0, 0, 17, 5), { width: 40, height: 40, cell })).toBe(
    "\x1b7\x1b[4;7H\x1b_Ga=p,i=730140,p=1,X=5,Y=0,z=1,C=1,q=2\x1b\\\x1b8",
  );
});

test("a thumbnail too big for the screen is scaled down by the host, and kept", async () => {
  const t = { width: 400, height: 480, cell };
  // Room below the link for it whole.
  expect(fit(100, 40, { x: 0, y: 2 }, t)).toBe(t);
  // In the middle, it shrinks to fit above the link: 26 rows less a border, copy row and rule.
  const shrunk = fit(100, 40, { x: 0, y: 26 }, t)!;
  expect(shrunk).toEqual({ width: 370, height: 440, cell, of: t });
  expect(place(new Rect(0, 1, 39, 26), shrunk)).toContain(",c=37,r=22,");
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
    expect(loader.sync(fit(100, 40, { x: 0, y: 26 }, loaded))).toStartWith("\x1b_Ga=t,");
    expect(loader.sync(loaded)).toBe("");
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
    expect(loader.sync(tall)).toStartWith("\x1b_Ga=t,t=d,f=100,i=730140,q=2,m=");
    expect(loader.sync(tall)).toBe("");
    expect(loader.sync(null)).toBe(remove);
    expect(loader.sync(null)).toBe("");

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
    const sent = loader.sync(shown);
    expect(sent).toStartWith("\x1b_Ga=t,t=d,f=100,i=730140,q=2,m=0;");
    expect(sent).toContain("\x1b_Ga=f,t=d,f=100,i=730140,x=12,y=2,c=1,z=100,q=2,m=0;");
    expect(sent).toEndWith("\x1b_Ga=a,i=730140,r=1,z=200,q=2\x1b\\\x1b_Ga=a,i=730140,s=3,v=1,q=2\x1b\\");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
