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

test("every field edits as a text box: words, lines, selection, cut and select all", () => {
  const d = Dialog.init({ agent: 1 }, "fix the sidebar flicker");
  d.selected = false;
  d.sequence("\x1b\x7f");
  expect(d.raw()).toBe("fix the sidebar ");
  d.key(23);
  expect(d.raw()).toBe("fix the ");
  d.sequence("\x1bb");
  d.sequence("\x1b[1;2C");
  d.sequence("\x1b[1;2C");
  expect(d.selection()).toEqual([4, 6]);
  d.key(c("a"));
  expect(d.raw()).toBe("fix ae ");
  d.sequence("\x1b[97;9u");
  expect(d.selected).toBe(true);
  d.sequence("\x1b[120;9u");
  expect(d.len).toBe(0);
  // Typed characters outside ASCII arrive a byte at a time.
  for (const byte of Buffer.from("é")) d.key(byte);
  expect(d.raw()).toBe("é");
  d.key(21);
  expect(d.len).toBe(0);
});

test("a press in the field places the caret, and a drag selects from it", () => {
  const d = Dialog.init({ rename: 1 }, "branch name");
  const v = View.init(60, 20, d);
  d.press(v, v.text_x, v.field_y, 0);
  expect([d.cursor, d.selection()]).toEqual([0, null]);
  d.drag(v, v.text_x + 6);
  expect(d.selection()).toEqual([0, 6]);
  d.release();
  d.drag(v, v.text_x + 9);
  expect(d.selection()).toEqual([0, 6]);
});

test("a workspace name keeps its spaces until it is edited", () => {
  const d = Dialog.init({ workspace_name: 1 }, "foo ");
  expect(d.name()).toBe("foo ");
  d.sequence("\x1b[F");
  expect(d.name()).toBe("foo ");
  d.key(c(" "));
  expect(d.name()).toBe("foo");
  expect(Dialog.init({ workspace_name: 1 }, "  ").name()).toBe("  ");
  expect(Dialog.init({ rename: 1 }, "tab ").name()).toBe("tab");
});
