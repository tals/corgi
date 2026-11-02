import { expect, test } from "bun:test";
import * as footerCorgi from "./footer_corgi";
import * as terminal from "./terminal";

const glyphs = (ansi: string) =>
  terminal
    .row(ansi, footerCorgi.width)
    .map(cell => cell[0])
    .join("");

test("every frame of the wake-up fits the footer row", () => {
  for (const frame of footerCorgi.frames) {
    const x = footerCorgi.sway + frame.x;
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x + [...frame.pose].length).toBeLessThanOrEqual(footerCorgi.width);
  }
});

test("a tap wakes him, and he is asleep again when the routine ends", () => {
  const wake = new footerCorgi.Wake();
  expect(glyphs(wake.write(0)).trim()).toStartWith("~ᐯ◡ᴥ◡ᐯ");
  wake.tap(1000);
  expect(wake.awake(1000)).toBe(true);
  expect(glyphs(wake.write(1000 + 400))).toContain("ᐯ-ᴥ•ᐯ");
  const end = 1000 + footerCorgi.duration_ms;
  expect(wake.awake(end)).toBe(false);
  expect(glyphs(wake.write(end)).trim()).toBe("~ᐯ◡ᴥ◡ᐯ");
  // His first dream after the nap comes within a second.
  expect(glyphs(wake.write(end + 1000))).toContain("ᶻ");
});

test("tapping while he's up starts another spin without waking him again", () => {
  const wake = new footerCorgi.Wake();
  wake.tap(0);
  wake.tap(200);
  expect(wake.started_ms).toBe(0);
  const late = footerCorgi.duration_ms - 100;
  wake.tap(late);
  // The wag's squint with both ears up, not the ear twitch he wakes with.
  expect(glyphs(wake.write(late))).toContain("ᐱ◡ᴥ◡ᐱ");
});

test("he blows a heart after the spin", () => {
  const wake = new footerCorgi.Wake();
  wake.tap(0);
  const rows = Array.from({ length: footerCorgi.duration_ms / 20 }, (_, i) => glyphs(wake.write(i * 20)));
  const spun = rows.findIndex(row => row.includes("‹o["));
  const heart = rows.findIndex(row => row.includes("♥"));
  expect(spun).toBeGreaterThan(0);
  expect(heart).toBeGreaterThan(spun);
});
