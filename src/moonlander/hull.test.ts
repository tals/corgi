import { afterEach, expect, test } from "bun:test";
import { flight } from "../fixtures/moonlander";
import * as faces from "./faces";
import * as hull from "./hull";
import * as palette from "../palette";
import * as terminal from "./terminal";
import { options } from "../../tools/moonlander";
import { Differ } from "../frame_diff";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

const key = (dots: hull.Dot[]) => dots.map(d => `${d.x},${d.y},${d.level}`).sort();

test("every braille style draws the upright ship the same, and solid", () => {
  const engine = flight(),
    upright = key(hull.dots(engine, "fixed", 0));
  for (const style of ["turned", "turned-gray"] as const) expect(key(hull.dots(engine, style, 0))).toEqual(upright);
});

test("turned styles turn the upright dots, the gray one with partly lit edges", () => {
  const engine = flight();
  for (let k = 1; k <= hull.turns; k++) {
    const turned = hull.dots(engine, "turned", k * hull.step),
      gray = hull.dots(engine, "turned-gray", k * hull.step);
    expect(turned.every(d => d.level === 1)).toBe(true);
    expect(gray.some(d => d.level < 1)).toBe(true);
    expect(gray.every(d => d.level >= 0.3 && d.level <= 1)).toBe(true);
  }
  // Between tilts, as while landing, the nearest tilt's dots stand.
  expect(hull.dots(engine, "turned-gray", 0.05)).toBe(hull.dots(engine, "turned-gray", 0));
});

test("each tilt's tile is the upright dots turned, crisp upright and antialiased turned", () => {
  const engine = flight(),
    upright = hull.sprite(engine, 10, 22, hull.tile(0)),
    dots = engine.shipDots(0).length;
  // Braille-sized squares a braille dot apart, every pixel solid or empty.
  expect(upright.alpha.every(a => a === 0 || a === 255)).toBe(true);
  expect(upright.alpha.reduce((n, a) => n + (a ? 1 : 0), 0)).toBe(dots * 2 * 2);
  const turned = hull.sprite(engine, 10, 22, hull.tile(3 * hull.step));
  expect(turned.alpha.some(a => a > 0 && a < 255)).toBe(true);
  expect(hull.tile(-Math.PI / 2)).toBe(0);
  expect(hull.tile(Math.PI / 2)).toBe(hull.tiles - 1);
});

test("the hull's crops move with the ship to the pixel and wrap at the edges", () => {
  const engine = flight(),
    L = engine.lander!,
    tile = hull.sprite(engine, 10, 22, hull.tile(0));
  Object.assign(L, { x: 70, a: 0 });
  const [at] = hull.placements(engine, tile, 10, 22);
  Object.assign(L, { x: 70.3 });
  expect(hull.placements(engine, tile, 10, 22)[0].x).toBe(at.x + 2);
  Object.assign(L, { x: 1 });
  const wrapped = hull.placements(engine, tile, 10, 22);
  expect(wrapped.length).toBe(2);
  expect(wrapped.reduce((n, p) => n + p.w, 0)).toBe(tile.w);
});

test("--hull and --levels choose the hull, and bad values are usage errors", () => {
  expect(options([])).toEqual({});
  expect(options(["--hull", "turned"])).toEqual({ hull: "turned" });
  expect(options(["--hull=fixed", "--levels=4"])).toEqual({ hull: "fixed", bits: 2 });
  expect(options(["--levels", "16"])).toEqual({ bits: 4 });
  expect(options(["--hull", "sideways"])).toEqual({ error: "unknown hull style: sideways" });
  expect(options(["--levels", "8"])).toEqual({ error: "--levels takes 4 or 16, not 8" });
  expect(options(["--help"])).toEqual({ error: "" });
});

test("with autoland the game skips the title, and its first flight waits for the terminal", () => {
  const state = new terminal.State(100, 30, () => {}, undefined, { autoland: true }),
    cell = { width: 10, height: 25 };
  expect(state.engine.game.state).toBe("flying");
  expect(state.frame(100, 30, null, false, 0)).not.toContain("space / enter to launch");
  // The cell size rebuilds the moon for it, as it would the title's.
  state.frame(100, 30, cell, false, 100);
  expect(state.engine.world.K).toBe(1.25);
  expect(state.engine.game.since).toBe(0);
  let now = 300;
  state.frame(100, 30, cell, false, now);
  while (state.engine.game.state === "flying" && now < 3000) state.frame(100, 30, cell, false, (now += 1000 / 30));
  expect(state.engine.game.result?.soft).toBe(true);
  expect(now - 300).toBeGreaterThan(900);
  expect(now - 300).toBeLessThan(1100);
});

test("--autoland lands every flight by itself, beside the other switches", () => {
  expect(options(["--autoland"])).toEqual({ autoland: true });
  expect(options(["--autoland", "--hull", "fixed"])).toEqual({ autoland: true, hull: "fixed" });
  expect(options(["--autoland=yes"])).toEqual({ error: "unknown option: --autoland" });
});

// A terminal that answers every upload, so frames can be read for what they send.
function playing(style: hull.Style = "image") {
  const state = new terminal.State(100, 30, () => {}, undefined, { hull: style }),
    cell = { width: 10, height: 22 },
    host = Differ.create(100, 30);
  cleanup.push(() => {
    host.destroy();
    state.close();
  });
  let now = 0;
  const frame = async () => {
    now += 1000 / 30;
    const out = host.diff(state.frame(100, 30, cell, true, now)).toString();
    await Bun.sleep(1);
    const writes = state.takeWrites().join("");
    if (writes) host.invalidateImages();
    for (const id of writes.matchAll(/a=t,t=d,f=100,i=(\d+)/g)) state.reply(`\x1b_Gi=${id[1]};OK\x1b\\`, 100, 30);
    return out + writes;
  };
  return { state, frame };
}
const hull_image = /i=7302[123]\d/;
const uploads = (out: string) => [...out.matchAll(/\x1b_Ga=t,[^;\x1b]*?i=(7302[123]\d)/g)].map(m => Number(m[1]));

test("the image hull sends each tilt's tile once, with the tilts either side ahead of a turn", async () => {
  const { state, frame } = playing();
  state.engine.press("advance");
  let sent = "";
  for (let i = 0; i < 6; i++) sent += await frame();
  // Upright and its neighbours, each sent once; upright placed.
  expect(uploads(sent)).toEqual([730223, 730222, 730224]);
  expect(sent).toContain("a=p,i=730223,p=1");
  state.engine.press("right");
  let turned = await frame();
  // The turn's tile was waiting, so it shows at once and the old one's placement goes.
  expect(turned).toContain("a=p,i=730224,p=1");
  expect(turned).toContain("\x1b_Ga=d,d=r,x=730210,y=730236,q=2\x1b\\");
  expect(turned).not.toContain("a=p,i=730223");
  for (let i = 0; i < 5; i++) turned += await frame();
  expect(uploads(turned)).toEqual([730225]);
  state.engine.press("left");
  let back = "";
  for (let i = 0; i < 6; i++) back += await frame();
  expect(uploads(back)).toEqual([]);
  expect(state.close()).toContain("a=d,d=R,x=730210,y=730236");
});

test("while a tilt's tile is on its way, the face turns with the tile still shown", async () => {
  const { state, frame } = playing();
  state.engine.press("advance");
  for (let i = 0; i < 4; i++) await frame();
  // Two quick turns: the second tilt's tile is sent but not yet answered.
  state.engine.press("right");
  state.engine.press("right");
  const out = state.frame(100, 30, { width: 10, height: 22 }, true, 10_000),
    atlas = faces.layout(10, 22),
    crop = (a: number) => {
      const [p] = faces.placements(state.engine, atlas, [], false, a);
      return `x=${p.sx},y=${p.sy},`;
    };
  expect(out).toContain("a=p,i=730224,p=1");
  expect(out).not.toContain("a=p,i=730225");
  expect(out).toContain(`a=p,i=730202,p=1,${crop(hull.angle(14))}`);
  expect(out).not.toContain(`a=p,i=730202,p=1,${crop(hull.angle(15))}`);
});

test("a moving image hull costs one placement a frame, and nothing at rest", async () => {
  const { state, frame } = playing();
  for (let i = 0; i < 4; i++) await frame();
  state.engine.game.paused = true;
  expect(await frame()).not.toMatch(/a=p,i=7302[123]\d/);
  state.engine.lander!.x += 1;
  const pieces = [...(await frame()).matchAll(/\x1b\[\d+;\d+H\x1b_Ga=p,i=7302[123]\d,[^\x1b]*\x1b\\/g)];
  expect(pieces.length).toBe(1);
  expect(pieces[0][0].length).toBeLessThan(100);
});

test("without Kitty graphics, or when asked, the hull is braille and no image is sent", async () => {
  const state = new terminal.State(100, 30);
  expect(state.frame(100, 30, { width: 10, height: 22 }, false, 0)).not.toMatch(hull_image);
  for (const style of ["turned-gray", "turned", "fixed"] as const) {
    const { frame } = playing(style);
    expect(await frame()).not.toMatch(hull_image);
  }
});

test("a gray hull mixes its dim cells into the background", () => {
  const state = new terminal.State(100, 30, () => {}, undefined, { hull: "turned-gray" });
  state.engine.press("advance");
  Object.assign(state.engine.lander!, { a: 4 * hull.step });
  const tokens = new Set(Object.values(palette.colors).map(rgb => rgb.join(";"))),
    braille = /\x1b\[38;2;(\d+;\d+;\d+)m\x1b\[[\d;]+m[\u2800-\u28ff]/g,
    first = state.frame(100, 30, null, false, 0),
    shades = [...state.frame(100, 30, null, false, 300).matchAll(braille)].map(m => m[1]);
  expect([...first.matchAll(braille)].some(m => !tokens.has(m[1]))).toBe(false);
  expect(shades.some(rgb => !tokens.has(rgb))).toBe(true);
});

test("the face and the hull image move as one piece at any tilt", () => {
  const engine = flight(),
    atlas = faces.layout(20, 44);
  for (const k of [3, 6, 9, 13]) {
    const a = k * hull.step,
      tile = hull.sprite(engine, 20, 44, hull.tile(a)),
      offsets = new Set<string>();
    for (let i = 0; i < 40; i++) {
      Object.assign(engine.lander!, { x: 70 + i * 0.07, y: 40 + i * 0.05, a });
      const [at] = hull.placements(engine, tile, 20, 44),
        glyphs = faces.placements(engine, atlas, [], false, hull.drawn("image", a));
      offsets.add(glyphs.map(g => `${g.x - at.x},${g.y - at.y}`).join(" "));
    }
    expect(offsets.size).toBe(1);
  }
});

test("at the start the ship waits for its images instead of snapping from text to them", async () => {
  const { state, frame } = playing(),
    face = "ᐯ◡ᴥ◡ᐯ";
  const first = await frame();
  expect(first).not.toContain(face);
  expect(first).not.toMatch(/a=p,i=7302/);
  let later = "";
  for (let i = 0; i < 4; i++) later += await frame();
  expect(later).toMatch(/a=p,i=730202,/);
  expect(later).toMatch(/a=p,i=7302[123]\d,/);
  expect(later).not.toContain(face);
  // Without Kitty graphics, the text passenger shows once the terminal has had a moment to say so.
  const plain = new terminal.State(100, 30);
  expect(plain.frame(100, 30, null, false, 0)).not.toContain(face);
  expect(plain.frame(100, 30, null, false, 300)).toMatch(/ᐯ.ᴥ.ᐯ/);
  expect(state.close()).toContain("a=d,d=R");
});
