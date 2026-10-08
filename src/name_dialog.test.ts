// Mirrors the tests in name_dialog.zig.
import { expect, test } from "bun:test";
import { Dialog, View, selection } from "./name_dialog";
import { Writer } from "./text";

const c = (s: string) => s.charCodeAt(0);

test("name editing supports selection, insertion, cursor movement and clear", () => {
  const d = Dialog.init({ rename: 1 }, "original");
  d.key(c("a"));
  d.key(c("c"));
  d.sequence("\x1b[D");
  d.key(c("b"));
  expect(d.name()).toBe("abc");
  d.sequence("\x1b[3~");
  expect(d.name()).toBe("ab");
  d.key(127);
  expect(d.name()).toBe("a");
  d.key(3);
  expect(d.len).toBe(0);
  expect(d.name()).toBe("");
});

test("agent command editor preserves long pasted shell source", () => {
  const d = Dialog.init({ agent_command: 0 }, "old");
  const source = "FOO='two words' \nmyagent --whatever 'quoted argument' ";
  for (const byte of Buffer.from(source)) d.pasteByte(byte);
  for (let i = 0; i < 100; i++) d.pasteByte(c("x"));
  expect(d.len).toBeGreaterThan(80);
  expect(d.name().startsWith(source)).toBe(true);
  const edited = Dialog.init({ agent_command: 0 }, d.name());
  expect(edited.name()).toBe(d.name());
  for (let i = 0; i < 2048; i++) d.pasteByte(c("x"));
  expect(d.overflow).toBe(true);
});

test("the fork card is roomy where it fits and plain where it doesn't", () => {
  const d = Dialog.init({ fork: 1 }, "refactor (fork)");
  // The name starts selected: typing replaces it.
  expect(d.selected).toBe(true);
  const v = View.init(120, 40, d);
  expect(v.card !== null && v.card.hero_y !== null).toBe(true);
  expect(v.width).toBe(72);
  const [create, clear, cancel] = v.cardButtons();
  // The buttons answer on all three of their rows.
  for (const y of [v.buttons_y - 1, v.buttons_y, v.buttons_y + 1]) {
    expect(v.hit(create.x, y)).toEqual({ tag: "save" });
    expect(v.hit(clear.x + clear.width - 1, y)).toEqual({ tag: "clear" });
    expect(v.hit(cancel.x, y)).toEqual({ tag: "cancel" });
  }
  expect(v.hit(v.text_x - 2, v.field_y - 1)).toEqual({ tag: "field", field: 0 });
  expect(v.hit(v.text_x, v.field_y - 3)).toEqual({ tag: "none" });
  expect(v.hit(0, 0)).toEqual({ tag: "cancel" });
  // Without room for the hero it goes; without room for the card, the
  // plain dialog takes over.
  expect(View.init(120, 18, d).card!.hero_y).toBeNull();
  expect(View.init(40, 40, d).card).toBeNull();
  expect(View.init(120, 12, d).card).toBeNull();
  const w = new Writer();
  v.draw(d, w, 0);
  for (const text of [
    "Fork this agent",
    "Create Fork",
    "^C",
    "Clear",
    "Cancel",
    "┤",
    "●",
    selection + "refactor (fork)",
  ])
    expect(w.s).toContain(text);
});
