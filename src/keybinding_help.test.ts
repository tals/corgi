import { expect, test } from "bun:test";
import { State } from "./keybinding_help";
import { Terminal } from "./pane/terminal";
import * as model from "./keybindings";
import * as keys from "./keys";
import * as bindings from "./bindings";
import * as terminalCells from "../site/terminal";
import * as text from "./text";

function screen(s: State, cols = 148, rows = 48): string[] {
  const terminal = new Terminal(cols, rows);
  try {
    terminal.feed(s.frame(cols, rows, "corgi", "ctrl_b", 0));
    return terminal.text().split("\n");
  } finally {
    terminal.destroy();
  }
}
function click(s: State, text: string, cols = 148, rows = 48) {
  const lines = screen(s, cols, rows),
    y = s.edit ? lines.findLastIndex(line => line.includes(text)) : lines.findIndex(line => line.includes(text));
  expect(y).toBeGreaterThanOrEqual(0);
  return s.click(lines[y].indexOf(text), y);
}
function editor(id = "new") {
  const s = new State();
  s.customizing = true;
  s.selected = { id, index: 0 };
  screen(s);
  s.key(13);
  return s;
}

test.each([100, 48])("action labels remain clickable when help wraps at %i columns", cols => {
  const s = new State();
  expect(click(s, "New tab", cols)).toEqual({ name: "action", action: { name: "new" } });
  s.customizing = true;
  expect(click(s, "New tab", cols)).toBeNull();
  expect(s.edit?.id).toBe("new");
});

test.each([
  [41, 24],
  [80, 17],
])("an editor hidden at %i by %i cannot change or save its draft", (cols, rows) => {
  const s = editor();
  s.key(13);
  s.key(121);
  expect(s.edit?.focus.name).toBe("save");
  const draft = structuredClone(s.edit);
  expect(screen(s, cols, rows).join("\n")).toContain("Shortcuts need");
  for (const key of ["enter", "tab", "backspace", "ctrl+z", "left", "space", "a"]) {
    expect(s.event(keys.parseChord(key)!)).toBeNull();
    expect(s.edit).toEqual(draft);
  }
  expect(s.click(0, 0)).toBeNull();
  expect(s.edit).toEqual(draft);
  screen(s);
  const saved = s.key(13);
  expect(saved?.name).toBe("save");
  if (saved?.name === "save") expect(saved.config.new).toEqual(["prefix+y", "ctrl+t"]);
  screen(s, cols, rows);
  s.key(27);
  expect(s.edit).toBeNull();
});

test("Customize works while searching and keeps the filter", () => {
  const s = new State();
  screen(s);
  s.key(47);
  for (const char of "new tab") s.key(char.charCodeAt(0));
  s.event(keys.parseChord("ctrl+e")!);
  expect(s.customizing).toBe(true);
  expect(s.searching).toBe(false);
  expect(s.query).toBe("new tab");
  s.key(13);
  expect(s.edit?.id).toBe("new");
});

test("adaptive layouts keep keycaps intact and spatial without overlapping", () => {
  const configs: model.Config[] = [{}, { "focus:up": ["prefix+ctrl+alt+shift+up"], tab: ["ctrl+alt+shift+1..9"] }];
  for (const config of configs)
    for (const cols of [112, 100, 98, 97, 96, 80, 64, 63, 60, 50, 48, 42])
      for (const alts of [true, false]) {
        const s = new State();
        s.configure("corgi", "ctrl_b", config);
        s.show_alts = alts;
        screen(s, cols, 24);
        const { cells } = s["content"](cols - 6);
        const occupied = new Set<string>();
        for (const cell of cells) {
          expect(text.displayWidth(cell.text)).toBeLessThanOrEqual(cell.width);
          expect(cell.x + text.displayWidth(cell.text)).toBeLessThanOrEqual(cols - 6);
          for (let x = cell.x; x < cell.x + text.displayWidth(cell.text); x++) {
            const position = `${x},${cell.y}`;
            expect(occupied.has(position)).toBe(false);
            occupied.add(position);
          }
        }
        for (const name of ["focus", "swap"]) {
          const first = (dir: string) =>
            cells.find(c => c.target?.name === "binding" && c.target.id === name + ":" + dir)!;
          expect(first("up").y).toBeLessThan(first("left").y);
          expect(first("left").y).toBe(first("down").y);
          expect(first("down").y).toBe(first("right").y);
          expect(first("left").x).toBeLessThan(first("down").x);
          expect(first("down").x).toBeLessThan(first("right").x);
        }
        expect(cells.some(c => c.text === "┌──┬──┐")).toBe(true);
        expect(cells.some(c => c.text === "┌─────┐")).toBe(true);
      }
});

test.each([80, 64, 42])("Down reaches Swap when directional pads stack at %i columns", cols => {
  const s = new State();
  s.customizing = true;
  s.selected = { id: "focus:down", index: 1 };
  screen(s, cols, 24);
  s.event(keys.parseChord("down")!);
  expect(s.selected.id).toBe("swap:up");
});

test("spatial help keeps focus and swap alongside each other with stacked keycaps", () => {
  const s = new State(),
    lines = screen(s);
  const heading = lines.find(line => line.includes("Focus"))!;
  expect(heading).toContain("Swap");
  const y = lines.findIndex(line => line.includes("[◇ ↑]"));
  expect(lines[y + 1].indexOf("[◇ k]")).toBe(lines[y].indexOf("[◇ ↑]"));
  expect(lines[y].slice(heading.indexOf("Focus"))).not.toContain("/");
  const x = lines.findIndex(line => line.includes("[◇ ←]"));
  expect(lines[x + 1].indexOf("[◇ h]")).toBe(lines[x].indexOf("[◇ ←]"));
  s.event(keys.parseChord("ctrl+l")!);
  const hidden = screen(s).join("\n");
  expect(hidden).toContain("[◇ ←]");
  expect(hidden).not.toContain("[◇ h]");
});

test("editing an alternate preserves the primary and its direct scope", () => {
  const s = editor();
  click(s, "Ctrl+T");
  expect(s.edit?.index).toBe(1);
  expect(s.edit?.prefixed).toBe(false);
  s.key(13);
  s.event(keys.parseChord("ctrl+alt+y")!);
  const saved = s.key(13);
  expect(saved?.name).toBe("save");
  if (saved?.name !== "save") throw Error("Expected save");
  expect(saved.config.new).toEqual(["prefix+c", "ctrl+alt+y"]);
  expect(bindings.lookup(model.resolve("corgi", saved.config), false, 20)).toBeNull();
});

test("recording an ordered set keeps logical keys and maps them in order", () => {
  const s = editor("tab");
  s.key(13);
  click(s, "Record a sequence");
  for (const key of ["f13", "é", "f15"]) s.event(keys.parseChord(key)!);
  s.key(127);
  s.event(keys.parseChord("f14")!);
  expect(s.key(13)).toBeNull();
  const saved = s.key(13);
  if (saved?.name !== "save") throw Error("Expected save");
  expect(saved.config.tab).toEqual([{ keys: ["prefix+f13", "prefix+é", "prefix+f14"] }]);
  expect(bindings.lookup(model.resolve("corgi", saved.config), true, 233)).toEqual({ name: "tab", value: 2 });
});

test("filtering and keyboard navigation choose the current result and its alternate", () => {
  const s = new State();
  s.customizing = true;
  screen(s);
  s.key(47);
  for (const char of "new tab") s.key(char.charCodeAt(0));
  s.key(13);
  expect(s.selected.id).toBe("new");
  s.event(keys.parseChord("right")!);
  expect(s.selected).toEqual({ id: "new", index: 1 });
  s.key(13);
  expect(s.edit?.index).toBe(1);
  expect(s.edit?.listening).toBe(false);
  s.key(9);
  expect(keys.chordName(s.edit!.recorded[0])).toBe("ctrl+t");
  s.key(27);
  expect(s.edit).toBeNull();
  s.key(27);
  expect(s.query).toBe("");
  expect(s.customizing).toBe(true);
});

test("short terminals retain cancel, scope and recording controls", () => {
  const s = editor();
  const lines = screen(s, 42, 18);
  for (const label of ["New tab", "Use prefix", "Record Enter", "Cancel", "Save"])
    expect(lines.join("\n")).toContain(label);
  click(s, "Use prefix", 42, 18);
  expect(s.edit?.prefixed).toBe(false);
  click(s, "Cancel", 42, 18);
  expect(s.edit).toBeNull();
});

test("removing one alternate and restoring defaults are separate actions", () => {
  const s = editor();
  click(s, "Ctrl+T");
  expect(click(s, "Remove")).toBeNull();
  expect(s.edit!.shortcuts).toHaveLength(1);
  const saved = click(s, "Save");
  if (saved?.name !== "save") throw Error("Expected save");
  expect(saved.config.new).toEqual(["prefix+c"]);
  s.accept(saved.config);
  s.key(13);
  expect(click(s, "Use defaults")).toBeNull();
  const restored = click(s, "Save");
  if (restored?.name !== "save") throw Error("Expected restore");
  expect(restored.config).toEqual({});
});

test("moving a conflicting key requires choosing the labelled Move control", () => {
  const s = editor();
  s.key(13);
  s.key(110);
  expect(screen(s).join("\n")).toContain("Used by Next tab");
  const moved = click(s, "Move");
  if (moved?.name !== "save") throw Error("Expected move");
  expect(moved.config.next).toEqual([]);
  expect(bindings.lookup(model.resolve("corgi", moved.config), true, 110)).toEqual({ name: "new" });
});

test("an empty search cannot edit the previously selected action", () => {
  const s = new State();
  s.customizing = true;
  screen(s);
  s.key(47);
  for (const char of "no such shortcut") s.key(char.charCodeAt(0));
  s.key(13);
  expect(screen(s).join("\n")).toContain("No matching actions");
  s.key(13);
  s.key(43);
  expect(s.edit).toBeNull();
});

test.each([148, 100, 60])("vertical navigation visits adjacent rows at %i columns", cols => {
  for (const alternatives of [true, false]) {
    const s = new State();
    s.customizing = true;
    s.show_alts = alternatives;
    screen(s, cols, 30);
    const actions = [
      "new",
      "next",
      "tab",
      "rename-tab",
      "close-tab",
      ...(cols >= 64 ? ["new-workspace", "edit-workspace", "workspace-next", "choose-workspace", "attention"] : []),
    ];
    for (const id of actions.slice(1)) {
      s.event(keys.parseChord("down")!);
      expect(s.selected).toEqual({ id, index: 0 });
    }
    for (const id of actions.slice(0, -1).reverse()) {
      s.event(keys.parseChord("up")!);
      expect(s.selected).toEqual({ id, index: 0 });
    }
  }
});

test("moving down from an alternate still visits rows that only have a primary", () => {
  const s = new State();
  s.customizing = true;
  screen(s);
  s.event(keys.parseChord("right")!);
  expect(s.selected).toEqual({ id: "new", index: 1 });
  for (const id of ["prev", "tab", "rename-tab", "close-tab"]) {
    s.event(keys.parseChord("down")!);
    expect(s.selected).toEqual({ id, index: 0 });
  }
});

test("vertical navigation still follows the stacked spatial keycaps", () => {
  const s = new State();
  s.customizing = true;
  s.selected = { id: "focus:up", index: 0 };
  screen(s);
  for (const [id, index] of [
    ["focus:up", 1],
    ["focus:down", 0],
    ["focus:down", 1],
  ] as const) {
    s.event(keys.parseChord("down")!);
    expect(s.selected).toEqual({ id, index });
  }
});

test.each([148, 100])("navigation remembers which Close row is focused at %i columns", cols => {
  const s = new State();
  s.customizing = true;
  screen(s, cols, 48);
  let closes = 0;
  for (let i = 0; i < 100 && closes < 2; i++) {
    s.key(9);
    if (s.selected.id === "close") closes++;
  }
  expect(closes).toBe(2);
  // Close under Panes must keep its position, including after an edit is canceled.
  s.key(13);
  expect(s.edit?.id).toBe("close");
  s.key(27);
  s.event(keys.parseChord("up")!);
  expect(s.selected.id).toStartWith("swap:");
  s.event(keys.parseChord("down")!);
  expect(s.selected.id).toBe("close");
  s.event(keys.parseChord("down")!);
  expect(s.selected.id).toBe("split:down");
});

test("uneven alternate counts do not move focus into the neighboring diagram", () => {
  const s = new State();
  s.configure("corgi", "ctrl_b", { "focus:up": "prefix+up", "split:right": "prefix+v" });
  s.customizing = true;
  s.selected = { id: "focus:up", index: 0 };
  screen(s);
  s.event(keys.parseChord("down")!);
  expect(s.selected).toEqual({ id: "focus:down", index: 0 });
  s.selected = { id: "split:right", index: 0 };
  s.event(keys.parseChord("down")!);
  expect(s.selected).toEqual({ id: "resize-mode", index: 0 });
});

test("compact editor arrows visit scope, recording and the save footer", () => {
  const s = editor();
  for (const [direction, target] of [
    ["up", "toggle-prefix"],
    ["down", "record"],
    ["down", "cancel"],
    ["right", "save"],
  ] as const) {
    s.event(keys.parseChord(direction)!);
    expect(s.edit?.focus.name).toBe(target);
  }
  expect(screen(s).join("\n")).not.toContain("Modifiers");
});

test("repeated deletion empties the list, undo restores each binding, and cancel discards edits", () => {
  const s = editor();
  s.key(127);
  expect(s.edit!.shortcuts.map(model.display)).toEqual(["Ctrl+T"]);
  s.key(127);
  s.key(127);
  expect(s.edit!.shortcuts).toEqual([]);
  expect(screen(s).join("\n")).toContain("No shortcuts");
  s.event(keys.parseChord("ctrl+z")!);
  expect(s.edit!.shortcuts.map(model.display)).toEqual(["Ctrl+T"]);
  s.event(keys.parseChord("cmd+z")!);
  expect(s.edit!.shortcuts.map(model.display)).toEqual(["◇ c", "Ctrl+T"]);
  s.key(127);
  s.key(27);
  s.key(13);
  expect(s.edit!.shortcuts).toHaveLength(2);
  s.key(127);
  s.key(127);
  const saved = click(s, "Save");
  if (saved?.name !== "save") throw Error("Expected save");
  expect(saved.config.new).toEqual([]);
  s.accept(saved.config);
  s.key(13);
  expect(screen(s).join("\n")).toContain("No shortcuts");
});

test("recorded edits survive changing alternatives and undoing a removal", () => {
  const s = editor();
  s.key(13);
  s.event(keys.parseChord("ctrl+shift+right")!);
  click(s, "Ctrl+T");
  s.key(127);
  s.event(keys.parseChord("ctrl+z")!);
  const saved = click(s, "Save");
  if (saved?.name !== "save") throw Error("Expected save");
  expect(saved.config.new).toEqual(["prefix+ctrl+shift+right", "ctrl+t"]);
});

test.each([148, 42])("range menus open downward and Escape returns to their field at %i columns", cols => {
  const s = editor("tab");
  screen(s, cols, 18);
  s.key(13);
  let lines = screen(s, cols, 18);
  const field = lines.findIndex(line => line.includes("Modifiers"));
  expect(lines.findIndex(line => line.includes("[F1..F9]"))).toBeGreaterThan(field);
  expect(lines.join("\n")).toContain("Use prefix");
  s.key(27);
  expect(s.edit?.focus.name).toBe("key-set");
  s.event(keys.parseChord("right")!);
  expect(s.edit?.focus.name).toBe("modifiers");
  s.key(13);
  s.key(32);
  expect(s.edit!.recorded.every(key => key.mods.ctrl)).toBe(true);
  expect(s.edit?.menu).toBe("mods");
  s.key(27);
  s.event(keys.parseChord("left")!);
  s.key(13);
  s.event(keys.parseChord("down")!);
  s.key(13);
  const saved = click(s, "Save", cols, 18);
  if (saved?.name !== "save") throw Error("Expected save");
  expect(saved.config.tab).toEqual(["prefix+ctrl+f1..f9"]);
});

test("Backspace is recorded as a key outside a range, and Escape cancels recording", () => {
  const s = editor();
  s.key(13);
  s.key(127);
  const saved = s.key(13);
  if (saved?.name !== "save") throw Error("Expected save");
  expect(saved.config.new).toEqual(["prefix+backspace", "ctrl+t"]);
  s.key(27);
  s.key(13);
  s.key(13);
  s.key(27);
  expect(s.edit).toBeNull();
});

test("help uses aligned prefix, chord and alternative columns", () => {
  const s = new State(),
    lines = screen(s);
  const names = ["Find", "Choose", "Last visited"];
  const columns = names.map(
    name => lines.find(line => line.trimStart().startsWith("│   " + name)) ?? lines.find(line => line.includes(name))!,
  );
  expect(new Set(columns.map(line => line.indexOf("◇"))).size).toBe(1);
  const tab = lines.find(line => line.includes("◇ Tab"))!;
  const find = lines.find(line => line.includes("◇ g"))!;
  expect(tab.indexOf("◇ Tab")).toBe(find.indexOf("◇ g"));
});

test("range modifiers toggle independently and stay open", () => {
  const s = editor("tab");
  s.event(keys.parseChord("right")!);
  s.key(13);
  let lines = screen(s).join("\n");
  for (const modifier of ["Ctrl", "Alt", "Shift"]) expect(lines).toContain("[ ] " + modifier);
  expect(lines).not.toContain("[ ] Cmd");
  s.key(32);
  s.event(keys.parseChord("down")!);
  s.key(13);
  s.event(keys.parseChord("down")!);
  s.key(32);
  expect(s.edit?.menu).toBe("mods");
  expect(s.edit!.recorded.every(key => key.mods.ctrl && key.mods.alt && key.mods.shift)).toBe(true);
  expect(s.edit!.recorded).toHaveLength(9);
  expect(screen(s).join("\n")).toContain("◇ Ctrl+Alt+⇧+[1..9]");
  click(s, "[x] Alt");
  expect(s.edit!.recorded.every(key => key.mods.ctrl && !key.mods.alt && key.mods.shift)).toBe(true);
  s.key(27);
  const saved = click(s, "Save");
  if (saved?.name !== "save") throw Error("Expected save");
  expect(saved.config.tab).toEqual(["prefix+ctrl+shift+1..9"]);
});

test("mixed modifiers preserve other modifiers and Command bindings", () => {
  const s = new State();
  s.configure("corgi", "ctrl_b", { tab: { keys: ["prefix+cmd+ctrl+f13", "prefix+cmd+f14"] } });
  s.customizing = true;
  s.selected = { id: "tab", index: 0 };
  screen(s);
  s.key(13);
  s.event(keys.parseChord("right")!);
  s.key(13);
  expect(screen(s).join("\n")).toContain("[-] Ctrl");
  expect(screen(s).join("\n")).toContain("[x] Cmd");
  s.key(32);
  expect(s.edit!.recorded.every(key => key.mods.ctrl && key.mods.super)).toBe(true);
  s.key(32);
  expect(s.edit!.recorded.every(key => !key.mods.ctrl && key.mods.super)).toBe(true);
  click(s, "[x] Cmd");
  expect(s.edit!.recorded.every(key => !key.mods.super)).toBe(true);
  expect(screen(s).join("\n")).toContain("[ ] Cmd");
});

test("new key sets retain modifier toggles chosen before the keys", () => {
  const s = editor("tab");
  const lines = screen(s),
    y = lines.findLastIndex(line => line.includes("Remove Backspace"));
  s.click(lines[y].indexOf("+"), y);
  s.event(keys.parseChord("right")!);
  s.key(13);
  s.key(32);
  s.key(27);
  s.event(keys.parseChord("left")!);
  s.key(13);
  s.event(keys.parseChord("down")!);
  s.key(13);
  const saved = click(s, "Save");
  if (saved?.name !== "save") throw Error("Expected save");
  expect(saved.config.tab).toEqual(["prefix+1..9", "prefix+ctrl+f1..f9"]);
});

test("recording forwarded Super exposes its modifier without assuming support", () => {
  const s = editor("tab");
  s.key(13);
  click(s, "Record a sequence");
  s.sequence("\x1b[57376;9u");
  s.key(13);
  click(s, "Cmd");
  expect(screen(s).join("\n")).toContain("[x] Cmd");
});

test("outlined controls have full mouse targets and a visible focus marker", () => {
  const s = editor(),
    lines = screen(s);
  const recordY = lines.findLastIndex(line => line.includes("Record Enter"));
  const x = lines[recordY - 1].lastIndexOf("┌");
  expect(x).toBeGreaterThan(0);
  expect(lines[recordY][x]).toBe("│");
  expect(lines[recordY + 1][x]).toBe("└");
  expect(lines[recordY][x - 1]).toBe("›");
  s.click(x + 4, recordY - 1);
  expect(s.edit?.listening).toBe(true);
  s.key(27);
  expect(s.edit).toBeNull();
});

test("dropdown borders do not activate the controls underneath", () => {
  const s = editor("tab");
  s.event(keys.parseChord("right")!);
  s.key(13);
  const lines = screen(s),
    row = lines.findLastIndex(line => line.includes("[ ] Shift")),
    x = lines[row].indexOf("[ ] Shift") - 1;
  expect(s.pointsAt(x, row)).toBe(false);
  expect(s.click(x, row)).toBeNull();
  expect(s.edit?.menu).toBe("mods");
  s.key(27);
  expect(click(s, "Save")?.name).toBe("save");
});

test("editor outlines, fields and buttons share the dialog background", () => {
  const s = editor(),
    terminal = new Terminal(148, 48);
  try {
    terminal.feed(s.frame(148, 48, "corgi", "ctrl_b", 0));
    const cells = terminal.surface(0).surface.lines.map(line => terminalCells.row(line, 148));
    const lines = cells.map(row => row.map(cell => cell[0]).join(""));
    const top = lines.findIndex(line => line.includes("┌" + "─".repeat(58) + "┐"));
    const left = lines[top].indexOf("┌");
    expect(top).toBeGreaterThan(0);
    for (let y = top; y < top + 21; y++)
      expect(cells[y].slice(left, left + 60).every(cell => cell[2] === "surface")).toBe(true);
    const recordY = lines.findLastIndex(line => line.includes("Record Enter"));
    const recordX = lines[recordY - 1].lastIndexOf("┌");
    expect(cells[recordY - 1][recordX][1]).toBe("accent");
    expect(lines.join("\n")).not.toContain("Arrows move");
    expect(lines.join("\n")).not.toContain("⇧ Shift");
    expect(lines.join("\n")).not.toContain("Hide alts");
  } finally {
    terminal.destroy();
  }
});

test.each([
  [112, 40],
  [80, 24],
  [42, 18],
])("prefix toggle and defaults keep stable geometry at %ix%i", (cols, rows) => {
  const s = editor();
  const geometry = () => {
    screen(s, cols, rows);
    return s["controls"]
      .filter(c => ["toggle-prefix", "record", "cancel", "save"].includes(c.target.name))
      .map(c => ({ target: c.target, rect: c.rect }));
  };
  const initial = geometry();
  expect(screen(s, cols, rows).join("\n")).not.toContain("Use defaults");
  click(s, "Use prefix", cols, rows);
  expect(s.edit?.prefixed).toBe(false);
  expect(screen(s, cols, rows).join("\n")).toContain("[ ] Use prefix");
  expect(screen(s, cols, rows).join("\n")).toContain("Use defaults");
  expect(geometry()).toEqual(initial);
  click(s, "Use defaults", cols, rows);
  expect(s.edit?.prefixed).toBe(true);
  expect(geometry()).toEqual(initial);
  expect(screen(s, cols, rows).join("\n")).not.toContain("Use defaults");
  s.event(keys.parseChord("up")!);
  expect(s.edit?.focus.name).not.toBe("restore");
});

test("Space and Enter toggle prefix without changing the recorded chord", () => {
  const s = editor();
  const before = structuredClone(s.edit!.recorded);
  s.event(keys.parseChord("up")!);
  s.key(32);
  expect(s.edit?.prefixed).toBe(false);
  expect(s.edit?.recorded).toEqual(before);
  s.key(13);
  expect(s.edit?.prefixed).toBe(true);
  s.key(32);
  const saved = click(s, "Save");
  if (saved?.name !== "save") throw Error("Expected save");
  expect(saved.config.new).toEqual(["c", "ctrl+t"]);
});

test.each([
  [112, 40],
  [80, 24],
  [60, 24],
  [42, 18],
])("deletion and undo controls stay separate at %ix%i", (cols, rows) => {
  const s = editor();
  const check = () => {
    screen(s, cols, rows);
    const occupied = new Set<string>();
    for (const { rect } of s["controls"]) {
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.w).toBeLessThanOrEqual(cols);
      expect(rect.y + rect.h).toBeLessThanOrEqual(rows);
      for (let y = rect.y; y < rect.y + rect.h; y++)
        for (let x = rect.x; x < rect.x + rect.w; x++) {
          const position = `${x},${y}`;
          expect(occupied.has(position)).toBe(false);
          occupied.add(position);
        }
    }
  };
  check();
  s.key(127);
  check();
  expect(screen(s, cols, rows).join("\n")).toContain("Undo");
  s.key(127);
  check();
  click(s, "Undo", cols, rows);
  check();
  expect(s.edit!.shortcuts).toHaveLength(1);
  s.event(keys.parseChord("ctrl+z")!);
  check();
  expect(s.edit!.shortcuts).toHaveLength(2);
});

test("range delimiters are dim while the range and shared modifiers stay readable", () => {
  const s = editor("tab");
  click(s, "None");
  click(s, "[ ] Ctrl");
  click(s, "[ ] Alt");
  click(s, "[ ] Shift");
  s.key(27);
  const terminal = new Terminal(112, 40);
  try {
    terminal.feed(s.frame(112, 40, "corgi", "ctrl_b", 0));
    const cells = terminal.surface(0).surface.lines.map(line => terminalCells.row(line, 112));
    const row = cells.find(row =>
      row
        .map(c => c[0])
        .join("")
        .includes("Ctrl+Alt+⇧+[1..9]"),
    )!;
    const x = row
      .map(c => c[0])
      .join("")
      .indexOf("[1..9]");
    expect(row[x][1]).toBe("faint");
    expect(row[x + 1][1]).toBe("strong");
    expect(row[x + 5][1]).toBe("faint");
  } finally {
    terminal.destroy();
  }
});
