import { expect, test } from "bun:test";
import { Differ } from "./frame_diff";
import * as hostImages from "./host_images";
import { Rect } from "./layout";
import { Terminal } from "./pane/terminal";

const cell = { width: 10, height: 20 };
const dot = (width = 1, height = 1) =>
  new hostImages.Image({ rgba: new Uint8Array(width * height * 4).fill(255), width, height });
const free = (image: hostImages.Image) => `\x1b_Ga=d,d=I,i=${image.id},q=2\x1b\\`;
const placed = (image: hostImages.Image, id: number, at: string, keys = "") =>
  `\x1b[${at}H\x1b_Ga=p,i=${image.id},p=${id}${keys},z=1,C=1,q=1\x1b\\`;

test("every picture has an id of its own, and knows its size", () => {
  expect(dot().id).not.toBe(dot().id);
  expect(dot(3, 2)).toMatchObject({ width: 3, height: 2 });
  const png = Buffer.alloc(24);
  png.writeUInt32BE(300, 16);
  png.writeUInt32BE(40, 20);
  expect(new hostImages.Image({ png })).toMatchObject({ width: 300, height: 40 });
});

test("presenting a frame sends the pictures it shows once and frees those it dropped", () => {
  const store = new hostImages.Store(),
    a = dot(),
    b = dot();
  store.frame(cell).show(a, { col: 0, row: 0 });
  expect(store.changed).toBe(true);
  expect(store.present()).toEqual({
    send: `\x1b_Ga=t,t=d,f=32,s=1,v=1,i=${a.id},q=1,m=0;/////w==\x1b\\`,
    draw: placed(a, 1, "1;1"),
    redraw: placed(a, 1, "1;1"),
    free: "",
  });
  // The same frame again writes nothing, and says so.
  expect(store.changed).toBe(false);
  store.frame(cell).show(a, { col: 0, row: 0 });
  expect(store.changed).toBe(false);
  expect(store.present()).toMatchObject({ send: "", draw: "", free: "" });
  store.frame(cell).show(b, { col: 0, row: 0 });
  expect(store.present()).toEqual({
    send: expect.stringContaining(`i=${b.id},`),
    draw: `\x1b_Ga=d,d=i,i=${a.id},p=1,q=2\x1b\\` + placed(b, 2, "1;1"),
    redraw: `\x1b_Ga=d,d=i,i=${a.id},p=1,q=2\x1b\\` + placed(b, 2, "1;1"),
    free: free(a),
  });
  store.frame(cell);
  expect(store.present()).toMatchObject({ send: "", draw: `\x1b_Ga=d,d=i,i=${b.id},p=2,q=2\x1b\\`, free: free(b) });
});

test("only the pictures that changed are written; one that moved keeps its placement", () => {
  const store = new hostImages.Store(),
    still = dot(),
    moving = dot();
  const frame = (col: number) => {
    const f = store.frame(cell);
    f.show(still, { col: 0, row: 0 });
    f.show(moving, { col, row: 3 });
    return store.present();
  };
  frame(1);
  const moved = frame(2);
  expect(moved.draw).toBe(placed(moving, 2, "4;3"));
  // Drawn from nothing, the host is shown both again.
  expect(moved.redraw).toBe(placed(still, 1, "1;1") + placed(moving, 2, "4;3"));
  // A copy takes a placement of its own, and gives it back.
  const f = store.frame(cell);
  f.show(still, { col: 0, row: 0 });
  f.show(still, { col: 5, row: 0 });
  f.show(moving, { col: 2, row: 3 });
  expect(store.present().draw).toBe(placed(still, 3, "1;6"));
  expect(frame(2).draw).toBe(`\x1b_Ga=d,d=i,i=${still.id},p=3,q=2\x1b\\`);
});

test("a frame never presented sends nothing", () => {
  const store = new hostImages.Store(),
    a = dot(),
    b = dot();
  store.frame(cell).show(a, { col: 0, row: 0 });
  store.frame(cell).show(b, { col: 0, row: 0 });
  const { send } = store.present();
  expect(send).toContain(`i=${b.id},`);
  expect(send).not.toContain(`i=${a.id},`);
});

test("leaving takes everything off and frees it", () => {
  const store = new hostImages.Store(),
    a = dot(),
    frame = store.frame(cell);
  frame.show(a, { col: 0, row: 0 });
  store.present();
  expect(store.close()).toBe(`\x1b_Ga=d,d=i,i=${a.id},p=1,q=2\x1b\\` + free(a));
  expect(store.close()).toBe("");
});

test("a PNG goes in 4096-byte chunks, with its animation after it", () => {
  const store = new hostImages.Store(),
    image = new hostImages.Image({
      png: new Uint8Array(4000),
      animation: { delay: 200, frames: [{ png: new Uint8Array(3), x: 1, y: 2, base: 1, delay: 100 }] },
    });
  store.frame(cell).show(image, { col: 0, row: 0 });
  const sent = store.present().send;
  expect(sent).toStartWith(`\x1b_Ga=t,t=d,f=100,i=${image.id},q=1,m=1;`);
  expect(sent).toContain("\x1b_Gm=0;");
  expect(sent).toContain(`\x1b_Ga=f,t=d,f=100,i=${image.id},x=1,y=2,c=1,z=100,q=2,m=0;AAAA\x1b\\`);
  expect(sent).toEndWith(`\x1b_Ga=a,i=${image.id},r=1,z=200,q=2\x1b\\\x1b_Ga=a,i=${image.id},s=3,v=1,q=2\x1b\\`);
});

test("a placement writes only the keys it uses", () => {
  const frame = new hostImages.FrameImages(cell),
    image = dot();
  frame.show(image, { col: 4, row: 2 });
  frame.show(image, { col: 0, row: 0, x: 3, y: 5, region: new Rect(1, 2, 3, 4), cols: 6, rows: 2, z: -1 });
  expect(frame.commands()).toBe(
    placed(image, 1, "3;5") + `\x1b[1;1H\x1b_Ga=p,i=${image.id},p=2,x=1,y=2,w=3,h=4,X=3,Y=5,c=6,r=2,z=-1,C=1,q=1\x1b\\`,
  );
});

test("a picture is cut around the cells the frame covers, whenever they are covered", () => {
  const store = new hostImages.Store(),
    image = dot(60, 20);
  // Six cells across row 3, with the middle two covered.
  let frame = store.frame(cell);
  frame.show(image, { col: 2, row: 3 });
  frame.cover(new Rect(4, 0, 2, 10));
  expect(frame.commands()).toBe(
    placed(image, 1, "4;3", ",x=0,y=0,w=20,h=20") + placed(image, 2, "4;7", ",x=40,y=0,w=20,h=20"),
  );
  store.present();
  // Covered first and shown after cuts the same; a picture in a card isn't cut.
  frame = store.frame(cell);
  frame.cover(new Rect(4, 0, 2, 10));
  frame.show(image, { col: 2, row: 3 });
  frame.show(image, { col: 2, row: 3, top: true });
  expect(frame.commands()).toContain(placed(image, 3, "4;3"));
  expect(store.present().draw).toBe(placed(image, 3, "4;3"));
  // A card drawn over that card cuts its picture too.
  frame = store.frame(cell);
  frame.show(image, { col: 2, row: 3, top: true });
  frame.coverAll(new Rect(4, 0, 2, 10));
  expect(frame.commands()).toBe(
    placed(image, 1, "4;3", ",x=0,y=0,w=20,h=20") + placed(image, 2, "4;7", ",x=40,y=0,w=20,h=20"),
  );
  store.present();
  // All covered, it is placed nowhere and the host keeps it.
  frame = store.frame(cell);
  frame.cover(new Rect(0, 0, 20, 10));
  frame.show(image, { col: 2, row: 3 });
  expect(frame.commands()).toBe("");
  expect(store.present()).toMatchObject({ send: "", free: "" });
});

test("a cut keeps the part of the picture a region asked for, by the pixel", () => {
  const frame = new hostImages.FrameImages(cell),
    image = dot(100, 100);
  frame.show(image, { col: 1, row: 1, x: 5, y: 3, region: new Rect(10, 20, 30, 40), z: -1 });
  frame.cover(new Rect(0, 2, 10, 1));
  // The rows above the covered one, and those below it.
  expect(frame.commands()).toBe(
    `\x1b[2;2H\x1b_Ga=p,i=${image.id},p=1,x=10,y=20,w=30,h=17,X=5,Y=3,z=-1,C=1,q=1\x1b\\` +
      `\x1b[4;2H\x1b_Ga=p,i=${image.id},p=2,x=10,y=57,w=30,h=3,X=5,z=-1,C=1,q=1\x1b\\`,
  );
  // A scaled picture can't be cut: under a cover it goes whole.
  const scaled = new hostImages.FrameImages(cell);
  scaled.show(image, { col: 1, row: 1, cols: 4, rows: 2 });
  scaled.cover(new Rect(0, 2, 10, 1));
  expect(scaled.commands()).toBe("");
});

test("a picture the host refuses is sent again, and given up after three tries", () => {
  const store = new hostImages.Store(),
    image = dot();
  const show = () => {
    store.frame(cell).show(image, { col: 0, row: 0 });
    return store.present();
  };
  expect(show().send).not.toBe("");
  expect(store.refused(12)).toBe(false);
  for (let tries = 1; tries < 3; tries++) {
    expect(store.refused(image.id)).toBe(true);
    expect(store.changed).toBe(true);
    expect(show()).toMatchObject({ send: expect.stringContaining("a=t"), draw: placed(image, 1, "1;1") });
  }
  expect(store.refused(image.id)).toBe(true);
  expect(image.failed).toBe(true);
  // What the host may still have of it goes.
  expect(show()).toMatchObject({ send: `\x1b_Ga=d,d=I,i=${image.id},q=2\x1b\\`, draw: "" });
  expect(show()).toMatchObject({ send: "", draw: "" });
});

test("refusals far apart don't add up", () => {
  const store = new hostImages.Store(),
    image = dot();
  for (let tries = 0; tries < 5; tries++) {
    store.frame(cell).show(image, { col: 0, row: 0 });
    store.present();
    expect(store.refused(image.id, tries * 60_000)).toBe(true);
  }
  expect(image.failed).toBe(false);
});

test("a picture shown twice at one spot is placed once, and the frame settles", () => {
  const store = new hostImages.Store(),
    image = dot(),
    frame = store.frame(cell);
  frame.show(image, { col: 2, row: 1 });
  frame.show(image, { col: 2, row: 1 });
  expect(store.present().draw).toBe(placed(image, 1, "2;3"));
  expect(store.changed).toBe(false);
});

test("a host shows what the frames say: placed, moved, cut and taken off", () => {
  const host = new Terminal(20, 5),
    store = new hostImages.Store(),
    image = dot(20, 20);
  const shown = () => (host.surface(1).surface.images ?? []).map(p => ({ x: p.x, y: p.y, width: p.width }));
  const present = (draw: (frame: hostImages.FrameImages) => void) => {
    draw(store.frame(cell));
    const writes = store.present();
    host.feed(writes.send + writes.draw + writes.free);
  };
  try {
    present(frame => frame.show(image, { col: 1, row: 1 }));
    expect(shown()).toMatchObject([{ x: 1, y: 1 }]);
    present(frame => frame.show(image, { col: 4, row: 2 }));
    expect(shown()).toMatchObject([{ x: 4, y: 2 }]);
    const whole = shown()[0].width;
    present(frame => {
      frame.show(image, { col: 4, row: 2 });
      frame.cover(new Rect(5, 0, 1, 5));
    });
    expect(shown()).toMatchObject([{ x: 4, y: 2, width: whole / 2 }]);
    present(() => {});
    expect(shown()).toEqual([]);
  } finally {
    host.destroy();
  }
});

test("the differ writes the pictures' changes in the frame's update, and all of them on a screen drawn anew", () => {
  const d = Differ.create(20, 4),
    frame = (text: string) => `\x1b[?25l\x1b[0m\x1b[H\x1b[J${text}\x1b[1;1H`;
  try {
    // Nothing shows yet: the screen is drawn whole, with every picture.
    expect(d.diff(frame("one"), { draw: "<draw>", redraw: "<redraw>" }).toString()).toContain("\x1b7<redraw>\x1b8");
    // Inside the frame's own update, when it has one.
    const updated = Differ.create(20, 4);
    try {
      const whole = updated.diff(`\x1b[?2026h${frame("one")}\x1b[?2026l`, { draw: "", redraw: "<redraw>" });
      expect(whole.toString()).toContain("\x1b7<redraw>\x1b8\x1b[?2026l");
    } finally {
      updated.destroy();
    }
    const next = d.diff(frame("two"), { draw: "<draw>", redraw: "<redraw>" }).toString();
    expect(next).toStartWith("\x1b[?2026h");
    expect(next).toContain("<draw>");
    expect(next).not.toContain("<redraw>");
    expect(next.indexOf("<draw>")).toBeLessThan(next.indexOf("\x1b[?2026l"));
    // Pictures alone still make an update; nothing to draw makes none.
    const alone = d.diff(frame("two"), { draw: "<draw>", redraw: "<redraw>" }).toString();
    expect(alone).toContain("<draw>");
    expect(alone).not.toContain("two");
    expect(d.diff(frame("two"), { draw: "", redraw: "<redraw>" }).toString()).toBe("");
  } finally {
    d.destroy();
  }
});
