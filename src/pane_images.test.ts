import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Terminal } from "./pane/terminal";
import { Terminal as Mirror, type Transport } from "./mirror";
import { Images } from "./pane_images";
import { Rect } from "./layout";
import { Differ } from "./frame_diff";
import type { ImagePlacement } from "./pane/surface";

const command = (control: string, data = "") => `\x1b_G${control}${data ? ";" + data : ""}\x1b\\`;
const red = command("a=T,f=24,s=1,v=1,i=71,c=2,r=2,C=1,q=2", "/wAA");
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACXBIWXMAAAsTAAALEwEAmpwYAAAACklEQVQIHWP4DwABAQEANl9ngAAAAABJRU5ErkJggg==";
const pictures = (t: Terminal, offset: number | null = null) => t.surface(1, offset).surface.images!;
const read =
  (t: Terminal) =>
  async (id: string, offset: number): Promise<string | null> =>
    t.native({ op: "image", text: id, skip: offset });
function using(body: (t: Terminal) => void) {
  const t = Terminal.create(20, 5);
  try {
    body(t);
  } finally {
    t.destroy();
  }
}

test("Kitty RGB and PNG images survive a surface, including file transport", () =>
  using(t => {
    t.feed(red);
    const [image] = pictures(t);
    expect(image).toMatchObject({
      x: 0,
      y: 0,
      width: 2,
      height: 2,
      image: { width: 1, height: 1, format: 24, bytes: 3 },
    });
    expect(t.native({ op: "image", text: image.image.id })).toBe("/wAA");
    expect(t.surface(1).surface.lines.join("")).not.toContain("\x1b_G");
    t.feed(command("a=T,f=100,i=72,c=1,r=1,C=1,q=2", png));
    expect(pictures(t)).toHaveLength(2);
    expect(pictures(t).find(p => p.image.format === 32)?.image.bytes).toBe(4);
    const dir = mkdtempSync(join(tmpdir(), "corgi-graphics-"));
    try {
      const path = join(dir, "image.png");
      writeFileSync(path, Buffer.from(png, "base64"));
      t.feed(command("a=T,t=f,f=100,i=73,c=1,r=1,C=1,q=2", Buffer.from(path).toString("base64")));
      expect(pictures(t)).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true });
    }
  }));

test("Unicode image placeholders retain their crops as cells are overwritten and scrolled", () =>
  using(t => {
    const pixels = Buffer.from([
      255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0,
    ]);
    t.feed(command("a=t,f=24,s=2,v=4,i=71,q=2", pixels.toString("base64")));
    t.feed(command("a=p,U=1,i=71,p=9,c=2,r=2,q=2"));
    expect(pictures(t)).toEqual([]);
    const marker = "\u{10eeee}";
    t.feed(
      `\x1b[2;4H\x1b[38;2;0;0;71;58:2::0:0:9m${marker}\u0305\u0305${marker}\u0305\u030d` +
        `\x1b[3;4H${marker}\u030d\u0305${marker}\u030d\u030d\x1b[0m`,
    );
    expect(pictures(t)).toMatchObject([
      { x: 3, y: 1, width: 2, height: 1, source_x: 0, source_y: 0, source_width: 2, source_height: 2 },
      { x: 3, y: 2, width: 2, height: 1, source_x: 0, source_y: 2, source_width: 2, source_height: 2 },
    ]);
    expect(t.surface(1).surface.lines.join("")).not.toContain(marker);
    t.feed("\x1b[2;4HX");
    expect(pictures(t)[0]).toMatchObject({ x: 4, y: 1, width: 1, source_x: 1, source_width: 1 });
    t.feed("\x1b[5;1H\n");
    expect(pictures(t).map(p => p.y)).toEqual([0, 1]);
    expect(pictures(t, 0).map(p => p.y)).toEqual([1, 2]);
    t.feed(command("a=d,d=I,i=71,q=2"));
    expect(pictures(t)).toEqual([]);
  }));

test("Unicode image placeholders split adjacent runs and reach the last column", () =>
  using(t => {
    t.feed(command("a=t,f=24,s=2,v=1,i=71,q=2", "/wAAAP8A"));
    t.feed(command("a=t,f=24,s=1,v=1,i=72,q=2", "/wAA"));
    t.feed(command("a=p,U=1,i=71,p=9,c=2,r=1,q=2"));
    t.feed(command("a=p,U=1,i=71,p=10,c=1,r=1,q=2"));
    t.feed(command("a=p,U=1,i=72,p=8,c=1,r=1,q=2"));
    const cell = (image: number, placement: number, col: string) =>
      `\x1b[38;2;0;0;${image};58:2::0:0:${placement}m\u{10eeee}̅${col}`;
    t.feed(
      `\x1b[2;1H${cell(71, 9, "̅")}${cell(71, 9, "̍")}${cell(72, 8, "̅")}${cell(71, 10, "̅")}` +
        `\x1b[3;19H${cell(71, 9, "̅")}${cell(71, 9, "̍")}` +
        `\x1b[4;1H${cell(72, 8, "̅")}\x1b[0m`,
    );
    const runs = pictures(t).map(p => ({ x: p.x, y: Math.floor(p.y), width: p.width, image: p.image.width }));
    expect(runs).toEqual([
      { x: 0, y: 1, width: 2, image: 2 },
      { x: 2, y: 1, width: 1, image: 1 },
      { x: 3, y: 1, width: 1, image: 2 },
      { x: 18, y: 2, width: 2, image: 2 },
      { x: 0, y: 3, width: 1, image: 1 },
    ]);
  }));

test("images retain the completed synchronized frame and replacements get a new identity", () =>
  using(t => {
    t.feed(red);
    const before = pictures(t);
    t.feed("\x1b[?2026h" + command("a=d,d=A,q=2"));
    expect(pictures(t)).toEqual(before);
    expect(t.native({ op: "image", text: before[0].image.id })).toBe("/wAA");
    t.feed("\x1b[?2026l");
    expect(pictures(t)).toEqual([]);
    t.feed(red);
    expect(pictures(t)[0].image.id).not.toBe(before[0].image.id);
    t.feed("\x1b[?1049h");
    expect(pictures(t)).toEqual([]);
    t.feed("\x1b[?1049l");
    expect(pictures(t)).toHaveLength(1);
  }));

test("placements follow scrollback, source crops, pixel offsets and cell sizes", () =>
  using(t => {
    t.native({ op: "pixels", start_x: 10, start_y: 20 });
    t.feed(command("a=T,f=24,s=2,v=1,i=71,c=2,r=2,X=5,Y=10,C=1,q=2", "/wAAAP8A"));
    expect(pictures(t)[0]).toMatchObject({ x: 0.5, y: 0.5, width: 1.5, height: 1.5 });
    t.feed("\r\n".repeat(5));
    expect(pictures(t)[0].y).toBe(-0.5);
    expect(pictures(t, 0)[0].y).toBe(0.5);
    expect(pictures(t)[0].y).toBe(-0.5);
    t.resize(24, 5);
    expect(pictures(t)[0].x).toBe(0.5);
  }));

test("image chunks are bounded and ordinary redraws carry only metadata", () =>
  using(t => {
    const pixels = Buffer.alloc(300_000, 42).toString("base64");
    for (let i = 0; i < pixels.length; i += 4096)
      t.feed(
        command(
          i === 0 ? "a=T,f=24,s=1000,v=100,i=71,c=2,r=2,C=1,q=2,m=1" : `m=${Number(i + 4096 < pixels.length)}`,
          pixels.slice(i, i + 4096),
        ),
      );
    const [p] = pictures(t);
    expect(p.image.bytes).toBe(300_000);
    const first = t.native({ op: "image", text: p.image.id }) as string;
    expect(first.length).toBe(256 * 1024);
    expect(Buffer.from(first, "base64")).toEqual(Buffer.alloc(192 * 1024, 42));
    t.feed("text");
    expect(pictures(t)[0].image.id).toBe(p.image.id);
    expect(JSON.stringify(t.surface(1).surface).length).toBeLessThan(5000);
  }));

test("viewer remaps ids, clips pixels to its pane, caches uploads and frees hidden images", async () => {
  const t = Terminal.create(20, 5),
    host = Terminal.create(40, 15);
  const images = new Images(() => {}),
    rect = new Rect(5, 3, 1, 1),
    cell = { width: 8, height: 16 };
  try {
    t.feed(red);
    let calls = 0;
    const load = async (id: string, offset: number) => {
      calls++;
      return read(t)(id, offset);
    };
    const frame = (ps: ImagePlacement[]) => {
      const hide = images.begin();
      const draw = images.draw(ps, rect, cell, load);
      const writes = images.end();
      host.feed(hide + draw + writes);
      return { draw, writes };
    };
    frame(pictures(t));
    await images.settled();
    expect(frame(pictures(t)).writes).toContain("a=t,t=d,f=32,s=8,v=16,i=268435456");
    const next = frame(pictures(t));
    expect(next.writes).toBe("");
    expect(next.draw).toContain("\x1b[4;6H");
    expect(calls).toBe(1);
    const placed = pictures(host);
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({ x: 5, y: 3, width: 1, height: 1 });
    const data = Buffer.from((await read(host)(placed[0].image.id, 0)) ?? "", "base64");
    expect(data).toEqual(Buffer.from(Array(128).fill([255, 0, 0, 255]).flat()));
    expect(frame([]).writes).toContain("a=d,d=I,i=268435456");
    expect(pictures(host)).toEqual([]);
  } finally {
    t.destroy();
    host.destroy();
  }
});

test("pane images survive frame diffs and moving panes without retransmission", async () => {
  const child = Terminal.create(20, 5),
    host = Terminal.create(40, 15),
    differ = Differ.create(40, 15);
  const images = new Images(() => {}),
    cell = { width: 8, height: 16 };
  try {
    child.feed(red);
    const draw = (x: number, y: number) => {
      const hide = images.begin();
      const placement = images.draw(pictures(child), new Rect(x, y, 5, 5), cell, read(child));
      const frame = "\x1b[?2026h" + hide + "\x1b[H\x1b[Junchanged" + placement + "\x1b[?2026l";
      host.feed(differ.diff(frame));
      const writes = images.end();
      if (writes) {
        host.feed(writes);
        differ.invalidateImages();
      }
      return writes;
    };
    draw(3, 4);
    await images.settled();
    draw(3, 4);
    draw(3, 4);
    expect(pictures(host)[0]).toMatchObject({ x: 3, y: 4, width: 2, height: 2 });
    expect(draw(8, 2)).toBe("");
    expect(pictures(host)).toHaveLength(1);
    expect(pictures(host)[0]).toMatchObject({ x: 8, y: 2 });
    expect(draw(8, 2)).toBe("");
    expect(pictures(host)).toHaveLength(1);
  } finally {
    differ.destroy();
    child.destroy();
    host.destroy();
  }
});

test("a discarded transfer cannot resurrect an image and mirror selection holds image state", async () => {
  const t = Terminal.create(20, 5),
    images = new Images(() => {});
  const mirror = new Mirror(
    {
      request: async () => {
        throw Error("unused");
      },
    } as Transport,
    1,
    20,
    5,
  );
  try {
    t.feed(red);
    mirror.receive(t.surface(1));
    const before = mirror.images;
    mirror.holding_selection = true;
    t.feed(command("a=d,d=A,q=2"));
    mirror.receive(t.surface(1));
    expect(mirror.images).toEqual(before);
    mirror.holding_selection = false;
    mirror.receive(t.surface(1));
    expect(mirror.images).toEqual([]);
    const deferred = Promise.withResolvers<string>();
    images.begin();
    images.draw(before, new Rect(0, 0, 10, 5), { width: 8, height: 16 }, () => deferred.promise);
    images.end();
    const loading = images.settled();
    images.clear();
    deferred.resolve("/wAA");
    await loading;
    expect(images.end()).toBe("");
  } finally {
    mirror.destroy();
    t.destroy();
  }
});

test("images are cut around covered cells and stay uploaded while covered", async () => {
  const t = Terminal.create(20, 5),
    host = Terminal.create(40, 15);
  const images = new Images(() => {}),
    rect = new Rect(2, 1, 10, 5),
    cell = { width: 8, height: 16 };
  try {
    t.feed(command("a=T,f=24,s=1,v=1,i=72,c=6,r=4,C=1,q=2", "/wAA"));
    let calls = 0;
    const load = async (id: string, offset: number) => {
      calls++;
      return read(t)(id, offset);
    };
    const frame = (covered: Rect[]) => {
      const hide = images.begin();
      const draw = images.draw(pictures(t), rect, cell, load, covered);
      const writes = images.end();
      host.feed(hide + draw + writes);
      return writes;
    };
    const placed = () =>
      pictures(host)
        .map(p => [p.x, p.y, p.source_x, p.source_y, p.source_width, p.source_height])
        .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    frame([]);
    await images.settled();
    frame([]);
    // A card in the middle leaves the strips above and below it and the cells beside it.
    expect(frame([new Rect(4, 2, 2, 1), new Rect(30, 10, 5, 5)])).toBe("");
    expect(placed()).toEqual([
      [2, 1, 0, 0, 48, 16],
      [2, 2, 0, 16, 16, 16],
      [6, 2, 32, 16, 16, 16],
      [2, 3, 0, 32, 48, 32],
    ]);
    // Covering all of it places nothing but keeps the upload.
    expect(frame([rect])).toBe("");
    expect(pictures(host)).toEqual([]);
    expect(frame([])).toBe("");
    expect(placed()).toEqual([[2, 1, 0, 0, 48, 64]]);
    expect(calls).toBe(1);
  } finally {
    t.destroy();
    host.destroy();
  }
});
