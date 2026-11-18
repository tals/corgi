import { expect, test } from "bun:test";
import { Slide, duration_ms } from "./card_transition";
import { Rect } from "./layout";
import { Style } from "./palette";
import * as screen from "./fixtures/screen";
import { Writer } from "./text";

function card(box: Rect, label: string): string {
  const w = new Writer();
  for (let y = 0; y < box.h; y++) {
    w.write(`\x1b[${box.y + y + 1};${box.x + 1}H` + new Style({ fg: "text", bg: "surface" }).sgr());
    w.write(y === 0 ? "╭" : y === box.h - 1 ? "╰" : "│");
    w.write((y === 0 || y === box.h - 1 ? "─" : " ").repeat(box.w - 2));
    w.write(y === 0 ? "╮" : y === box.h - 1 ? "╯" : "│");
  }
  w.write(`\x1b[${box.y + 2};${box.x + 3}H${label}`);
  return w.s;
}
function draw(slide: Slide, box: Rect, label: string, cols = 50): string {
  const w = new Writer();
  slide.draw(w, card(box, label), box, cols, 24);
  return w.s;
}
const shown = (raw: string) => screen.text(raw, 50, 24);

test("the slide preserves its first frame and settles on the destination without advancing during draws", () => {
  const slide = new Slide(),
    from = new Rect(4, 10, 40, 6),
    to = new Rect(4, 4, 40, 16);
  const initial = shown(draw(slide, from, "New tab 界"));
  slide.start(1, 0);
  expect(shown(draw(slide, to, "Manage 界"))).toBe(initial);
  slide.tick(85);
  const moving = draw(slide, to, "Manage 界");
  expect(draw(slide, to, "Manage 界")).toBe(moving);
  expect(shown(moving)).not.toBe(initial);
  expect(shown(moving)).not.toBe(shown(card(to, "Manage 界")));
  expect(slide.tick(duration_ms)).toBe(true);
  expect(slide.active).toBe(false);
  expect(shown(draw(slide, to, "Manage 界"))).toBe(shown(card(to, "Manage 界")));
  expect(slide.tick(duration_ms + 1)).toBe(false);
});

test("rapid reversals stay bounded and a resize settles at the new geometry", () => {
  const slide = new Slide(),
    from = new Rect(4, 10, 40, 6),
    to = new Rect(4, 4, 40, 16);
  draw(slide, from, "New tab 界");
  for (let i = 0; i < 80; i++) {
    const forward = i % 2 === 0,
      box = forward ? to : from,
      label = forward ? "Manage 界" : "New tab 界";
    slide.start(forward ? 1 : -1, i * 100);
    slide.tick(i * 100 + 80);
    const raw = draw(slide, box, label);
    expect(raw.length).toBeLessThan(15_000);
    const lines = shown(raw).split("\n");
    for (const line of lines) {
      expect(line.slice(0, 4).trim()).toBe("");
      expect(line.slice(44).trim()).toBe("");
    }
  }
  const small = new Rect(0, 0, 30, 16);
  expect(draw(slide, small, "Resized", 30)).toBe(card(small, "Resized"));
  expect(slide.active).toBe(false);
});

test("an embedded settings slide clips to its area without adding a card border", () => {
  const slide = new Slide(),
    box = new Rect(8, 4, 36, 16),
    text = (label: string) => `\x1b[5;9H${new Style({ fg: "text", bg: "surface" }).sgr()}${label}`;
  slide.draw(new Writer(), text("Before"), box, 50, 24, false);
  slide.start(1, 0);
  slide.tick(100);
  const w = new Writer();
  slide.draw(w, text("After"), box, 50, 24, false);
  const lines = shown(w.s).split("\n");
  expect(w.s).not.toMatch(/[╭╰│━]/);
  for (let y = 0; y < lines.length; y++) {
    if (y < box.y || y >= box.y + box.h) expect(lines[y].trim()).toBe("");
    else {
      expect(lines[y].slice(0, box.x).trim()).toBe("");
      expect(lines[y].slice(box.x + box.w).trim()).toBe("");
    }
  }
  slide.tick(duration_ms);
  const settled = new Writer();
  slide.draw(settled, text("After"), box, 50, 24, false);
  expect(settled.s).toBe(text("After"));
});
