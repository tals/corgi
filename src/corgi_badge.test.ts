import { test, expect } from "bun:test";
import { State, reply_prefix, hide, hit, place } from "./corgi_badge";
import { Terminal } from "./pane/terminal";
import type { Cell } from "./fork_hero";
const cell = { width: 9, height: 18 };
async function upload(s: State, now: number, size: Cell | null = cell): Promise<string> {
  const first = s.upload(now, size);
  await s.loading;
  return first + s.upload(now, size);
}
const reply = (body: string) => reply_prefix + body + "\x1b\\";
test("badge uploads only on support or lost-image recovery", async () => {
  const s = new State();
  expect(await upload(s, 0)).toBe("");
  expect(s.accept(reply("i=730031;OK"))).toBe(true);
  const out = await upload(s, 0);
  expect(out).toContain("s=27,v=27");
  expect(out.includes("m=0;")).toBe(true);
  s.accept(reply("i=730031;OK"));
  expect(await upload(s, 2000)).toBe("");
  expect(place().length).toBeLessThan(100);
  s.accept(reply("i=730031,p=1;ENOENT:missing"));
  expect((await upload(s, 4000)).length).toBeGreaterThan(100);
  expect(s.accept(reply("i=7300319;OK"))).toBe(false);
});
test("unanswered probe falls back to the emoji and upgrades on a late reply", async () => {
  const s = new State();
  await upload(s, 1000);
  expect(s.mode()).toBe("pending");
  expect(await upload(s, 2500)).toBe("");
  expect(s.mode()).toBe("emoji");
  s.accept(reply("i=730031;OK"));
  expect((await upload(s, 3000)).length).toBeGreaterThan(100);
  s.accept(reply("i=730031;OK"));
  expect(s.mode()).toBe("image");
});
test("emoji hit area covers only its two cells", () => {
  expect(hit("emoji", 30, 1, 0)).toBe(false);
  expect(hit("emoji", 30, 2, 0)).toBe(true);
  expect(hit("emoji", 30, 3, 0)).toBe(true);
  expect(hit("emoji", 30, 4, 0)).toBe(false);
  expect(hit("emoji", 30, 2, 1)).toBe(false);
  expect(hit("image", 30, 4, 1)).toBe(true);
  expect(hit("none", 30, 2, 0)).toBe(false);
  expect(hit("pending", 30, 2, 0)).toBe(false);
  expect(hit("emoji", 0, 2, 0)).toBe(false);
});
test("an upload with a wrong acknowledgement ID is confirmed by placement", async () => {
  const s = new State();
  s.accept(reply("i=730031;OK"));
  await upload(s, 0);
  expect(s.accept(reply("i=0;OK"))).toBe(false);
  expect(s.status).toBe("uploading");
  const out = await upload(s, 3000);
  expect(s.status).toBe("confirming");
  expect(out.includes("a=p,i=730031,p=1,z=1,C=1,q=0")).toBe(true);
  expect(out.endsWith(hide)).toBe(true);
  s.accept(reply("p=1,i=730031;OK"));
  expect(s.mode()).toBe("image");
  expect(await upload(s, 10000)).toBe("");
  s.accept(reply("p=1,i=730031;ENOENT:missing"));
  expect((await upload(s, 10000)).length).toBeGreaterThan(100);
});
test("badge replies require exact image and placement IDs in any field order", () => {
  const s = new State();
  for (const body of [
    "i=0;OK",
    "i=7300319;OK",
    "p=1;OK",
    "i=730031,p=2;OK",
    "i=730031,i=0;OK",
    "i=0,i=730031;OK",
    "i=730031,p=1,p=2;OK",
  ])
    expect(s.accept(reply(body))).toBe(false);
  expect(s.supports_kitty_graphics).toBe(false);
  expect(s.accept(reply("p=1,i=730031;OK"))).toBe(true);
});
test("missing upload and placement acknowledgements fall back without losing capability", async () => {
  const s = new State();
  s.accept(reply("i=730031;OK"));
  for (let i = 0; i < 3; i++) {
    expect((await upload(s, i * 4500)).length).toBeGreaterThan(100);
    expect((await upload(s, i * 4500 + 3000)).length).toBeLessThan(200);
    expect(s.status).toBe("confirming");
  }
  expect(await upload(s, 13500)).toBe("");
  expect(s.mode()).toBe("emoji");
  expect(s.supports_kitty_graphics).toBe(true);
});
test("placement missing-image replies retry only a bounded number of uploads", async () => {
  const s = new State();
  s.accept(reply("i=730031;OK"));
  for (let i = 0; i < 3; i++) {
    expect((await upload(s, i * 3000)).length).toBeGreaterThan(100);
    await upload(s, i * 3000 + 3000);
    s.accept(reply("p=1,i=730031;ENOENT:missing"));
  }
  expect(await upload(s, 9000)).toBe("");
  expect(s.mode()).toBe("emoji");
  expect(s.supports_kitty_graphics).toBe(true);
});
test("successful uploads do not reset failed placement retries", async () => {
  const s = new State();
  s.accept(reply("i=730031;OK"));
  for (let i = 0; i < 3; i++) {
    expect((await upload(s, i * 100)).length).toBeGreaterThan(100);
    expect(s.mode()).toBe("pending");
    s.accept(reply("i=730031;OK"));
    expect(s.mode()).toBe("image");
    s.accept(reply("p=1,i=730031;ENOENT:missing"));
    expect(s.mode()).toBe(i < 2 ? "pending" : "emoji");
  }
  expect(await upload(s, 1000)).toBe("");
  expect(s.status).toBe("unavailable");
  expect(s.supports_kitty_graphics).toBe(true);
});
test("a hidden confirmation probe does not reset failed visible placements", async () => {
  const s = new State();
  s.accept(reply("i=730031;OK"));
  for (let i = 0; i < 3; i++) {
    expect((await upload(s, i * 3000)).length).toBeGreaterThan(100);
    expect(await upload(s, i * 3000 + 3000)).toContain(hide);
    s.accept(reply("p=1,i=730031;OK"));
    s.accept(reply("p=1,i=730031;ENOENT:missing"));
  }
  expect(await upload(s, 10000)).toBe("");
  expect(s.mode()).toBe("emoji");
});
test("successful visible placements restore the retry budget after image loss", async () => {
  const s = new State();
  s.accept(reply("i=730031;OK"));
  for (let i = 0; i < 8; i++) {
    expect((await upload(s, i * 100)).length).toBeGreaterThan(100);
    s.accept(reply("i=730031;OK"));
    expect(place()).toContain("q=0");
    s.accept(reply("p=1,i=730031;OK"));
    expect(s.mode()).toBe("image");
    s.accept(reply("p=1,i=730031;ENOENT:missing"));
  }
  expect(s.status).toBe("supported");
});

test("badge pixels fit their reserved cells without host scaling after font changes", async () => {
  const terminal = Terminal.create(20, 5);
  try {
    const state = new State();
    state.accept(reply("i=730031;OK"));
    for (const size of [
      { width: 9, height: 18 },
      { width: 8, height: 19 },
      { width: 7, height: 24 },
      { width: 18, height: 36 },
      { width: 16, height: 16 },
      { width: 20, height: 8 },
    ]) {
      terminal.native({ op: "pixels", start_x: size.width, start_y: size.height });
      const sent = await upload(state, 0, size);
      const data = [...sent.matchAll(/\x1b_G[^;]*;([^\x1b]*)\x1b\\/g)].map(m => m[1]).join("");
      const png = Buffer.from(data, "base64"),
        side = Math.min(3 * size.width, 2 * size.height);
      expect(png.readUInt32BE(16)).toBe(side);
      expect(png.readUInt32BE(20)).toBe(side);
      terminal.feed(sent + place());
      state.accept(reply("i=730031;OK"));
      const images = terminal.surface(1).surface.images!;
      expect(images).toHaveLength(1);
      const image = images[0];
      expect(image.width * size.width).toBeCloseTo(side);
      expect(image.height * size.height).toBeCloseTo(side);
      expect(image.x).toBe(2);
      expect(image.y).toBe(0);
      expect(image.x + image.width).toBeLessThanOrEqual(5);
      expect(image.y + image.height).toBeLessThanOrEqual(2);
      expect(await upload(state, 1, size)).toBe("");
    }
    expect(place()).not.toMatch(/[,;][cr]=/);
  } finally {
    terminal.destroy();
  }
});

test("unknown cell dimensions fall back after the probe deadline and hide an already displayed badge", async () => {
  const s = new State();
  s.accept(reply("i=730031;OK"));
  expect(await upload(s, 0, null)).toBe("");
  expect(s.mode()).toBe("pending");
  expect(await upload(s, 1500, null)).toBe("");
  expect(s.mode()).toBe("emoji");
  expect(s.loading).toBeNull();
  expect(await upload(s, 1501)).toContain("s=27,v=27");
  s.accept(reply("i=730031;OK"));
  expect(s.mode()).toBe("image");
  expect(s.upload(1502, null)).toBe(hide);
  expect(s.mode()).toBe("emoji");
  expect(s.upload(1503, null)).toBe("");
  expect(await upload(s, 1504)).toContain("s=27,v=27");
});

test("an obsolete resize cannot upload or restore the badge", async () => {
  const s = new State();
  s.accept(reply("i=730031;OK"));
  s.upload(0, cell);
  const old = s.loading;
  s.upload(1, { width: 18, height: 36 });
  await old;
  await s.loading;
  expect(s.upload(2, { width: 18, height: 36 })).toContain("s=54,v=54");
  s.upload(3, { width: 7, height: 14 });
  const pending = s.loading;
  s.upload(4, null);
  await pending;
  expect(s.upload(1500, null)).toBe("");
  expect(s.mode()).toBe("emoji");
});

test("startup stays pending through resize and upload, with emoji only on failure", async () => {
  const s = new State();
  expect(s.mode()).toBe("pending");
  s.upload(0, null);
  s.accept(reply("i=730031;OK"));
  s.upload(1, cell);
  expect(s.mode()).toBe("pending");
  await s.loading;
  expect(s.mode()).toBe("pending");
  expect(s.upload(2, cell)).toContain("s=27,v=27");
  expect(s.mode()).toBe("pending");
  s.accept(reply("i=730031;OK"));
  expect(s.mode()).toBe("image");
  s.accept(reply("i=730031;EINVAL:refused"));
  expect(s.mode()).toBe("emoji");
});
