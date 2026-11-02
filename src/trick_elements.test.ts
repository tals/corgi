import { expect, test } from "bun:test";
import * as elements from "./trick_elements";
import * as tricks from "./tricks";
import * as trickUi from "./trick_ui";
import { Rect } from "./layout";
import { Writer } from "./text";
import { Terminal } from "./pane/terminal";

test("rich drawing bounds reject deep, cyclic and broad trees before crossing the pipe", () => {
  const ui = elements.ui;
  expect(() => elements.encode(ui.row(...Array(129).fill("x")))).toThrow("DrawingTooLarge");
  let node: elements.Content = "x";
  for (let i = 0; i < 10; i++) node = ui.column(node);
  expect(() => elements.encode(node)).toThrow("DrawingTooLarge");
  const cycle: elements.Element = { kind: "row", children: [] };
  cycle.children.push(cycle);
  expect(() => elements.encode(cycle)).toThrow("DrawingTooLarge");
  expect(() => tricks.element(cycle)).toThrow("DrawingTooLarge");
  expect(() => tricks.element({ kind: "button", spans: [{ text: "\x1b[2J" }], action: "one" })).toThrow(
    "ControlCharacter",
  );
  expect(() => ui.icon("https://example.com/logo.png")).toThrow("InvalidIcon");
  const button = { kind: "button", spans: [{ text: "Open" }], action: "a".repeat(81) };
  expect(() => tricks.command({ op: "ui.set", key: "panel", view: { kind: "overlay", content: button } })).toThrow(
    "InvalidString",
  );
  expect(tricks.element({ ...button, action: crypto.randomUUID() + "." + "a".repeat(80) }).kind).toBe("button");
});

test("rows and columns share layout with button hit boxes and hide clipped controls", () => {
  const ui = elements.ui;
  const { content } = elements.encode(
    ui.column(
      "**Waiting**",
      ui.row(
        ui.icon("brand:claude"),
        ui.button("猫", () => {}),
      ),
      ui.button("Too wide to fit", () => {}),
    ),
  );
  const controls: trickUi.Controls = { hits: [], focus: "0" },
    w = new Writer(),
    terminal = new Terminal(40, 12);
  try {
    trickUi.draw(w, content, new Rect(4, 3, 10, 3), null, 2, controls);
    terminal.feed(w.s);
    expect(terminal.text()).toContain("Waiting");
    expect(terminal.text()).toContain("[ 猫 ]");
    expect(terminal.text()).not.toContain("Too wide");
    expect(controls.hits).toEqual([{ action: "0", slot: "0", rect: new Rect(7, 4, 6, 1), covered: 2 }]);
    expect(w.s).toContain("\x1b[7m");
    expect(w.s).toContain("\x1b[27m");
  } finally {
    terminal.destroy();
  }
});
