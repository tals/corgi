import { expect, test } from "bun:test";
import { Column, State, bounds, navigation, panes, spelling } from "./shortcut_help";
import type { Preset } from "./keymap";
const available_presets: Preset[] = ["corgi", "tmux", "herdr", "cmux"];
import * as bindings from "./bindings";
import { displayWidth } from "./text";
import type { Action } from "./action";

const act = (name: string, value?: string) => (value === undefined ? { name } : { name, value }) as Action;
const same = (a: Action | null, b: Action) => JSON.stringify(a) === JSON.stringify(b);

test("the help screen spells each preset's keys from its bindings", () => {
  for (const [preset, action, text] of [
    ["corgi", act("new"), "c"],
    ["corgi", act("last-agent"), "Tab"],
    ["corgi", act("paste"), null],
    ["tmux", act("paste"), "]"],
    ["corgi", act("choose-workspace"), "w"],
    ["corgi", act("choose-agent"), "a"],
    ["herdr", act("choose-workspace"), "w"],
    ["herdr", act("prev-pane"), "Shift+Tab"],
    ["cmux", act("new"), "Cmd+T · P c"],
    ["cmux", act("close-workspace"), "Cmd+Shift+W"],
    ["cmux", act("new-agent"), "P A"],
  ] as [Preset, Action, string | null][])
    expect(spelling(preset, action)).toBe(text);
});

test("agents lead with the attention jump, its key a keycap that fits", () => {
  for (const [preset, keycap] of [
    ["corgi", "[ f ]"],
    ["tmux", "[ F ]"],
    ["herdr", "[ o ]"],
    ["cmux", "[ Cmd+Shift+U · P f ]"],
  ] as [Preset, string][])
    for (const width of [47, 21]) {
      const column = new Column(width, preset);
      navigation(column);
      let found = false;
      for (const row of column.rows)
        for (const part of row) {
          expect(part.style !== "keycap" || same(part.action, act("attention"))).toBe(true);
          if (part.style !== "keycap") continue;
          expect(part.text).toBe(keycap);
          expect(part.x + displayWidth(part.text) <= width).toBe(true);
          found = true;
        }
      expect(found).toBe(true);
    }
});

test("agents list closing and reopening; panes list closing only", () => {
  const shows = (c: Column, action: Action) =>
    c.rows.some(row => row.some(part => part.action !== null && same(part.action, action)));
  for (const preset of available_presets) {
    const agents = new Column(47, preset);
    navigation(agents);
    const panesColumn = new Column(47, preset);
    panes(panesColumn);
    expect(shows(agents, act("close")) && shows(agents, act("undo-close"))).toBe(true);
    expect(shows(panesColumn, act("close")) && !shows(panesColumn, act("undo-close"))).toBe(true);
  }
});

test("the footer corgi wags until a click or the secret t throws it a ball", () => {
  const help = Object.assign(new State(), { command_mode: true });
  const idle = help.frame(120, 40, "corgi", "ctrl_b", 0, "default");
  expect(idle).toContain("~ᐯ•.•ᐯ");
  const b = bounds(120, 40);
  const footer = b.y + b.h - 2;
  expect(help.hit(120, 40, b.x + 36, footer, "corgi")).toEqual({ name: "play" });
  expect(help.hit(120, 40, b.x + b.w - 18, footer, "corgi")).toEqual({ name: "play" });
  expect(help.hit(120, 40, b.x + 35, footer, "corgi")).toEqual({ name: "none" });
  expect(help.hit(120, 40, b.x + b.w - 16, footer, "corgi")).toEqual({ name: "close" });

  // `t` keeps help open, and a second throw waits for the corgi to come back.
  expect(help.key(0x74)).toBe(false);
  const thrown = help.corgi.thrown_ms!;
  help.play(thrown + 100);
  expect(help.corgi.thrown_ms).toBe(thrown);
  const fetching = help.frame(120, 40, "corgi", "ctrl_b", thrown + 300, "default");
  // A smash lands at once, so the corgi may already be up.
  expect(fetching.includes("•ᴥ•") || fetching.includes("]o>")).toBe(true);
  expect(fetching).not.toContain("•.•");
  const back = help.frame(120, 40, "corgi", "ctrl_b", thrown + 9_600, "default");
  expect(back).not.toContain("ᴥ");
  help.play(thrown + 9_600);
  expect(help.corgi.thrown_ms).toBe(thrown + 9_600);

  // Too narrow for a fetch, the corgi stays put.
  const narrow = Object.assign(new State(), { command_mode: true });
  narrow.frame(60, 40, "corgi", "ctrl_b", 0, "default");
  narrow.play(0);
  expect(narrow.corgi.thrown_ms).toBeNull();
});

test("the pointer is a hand over what a click acts on", () => {
  const help = Object.assign(new State(), { command_mode: true });
  const b = bounds(120, 40);
  const footer = b.y + b.h - 2;
  expect(help.pointsAt(120, 40, b.x + 40, footer, "corgi")).toBe(true);
  expect(help.pointsAt(120, 40, b.x + b.w - 10, footer, "corgi")).toBe(true);
  expect(help.pointsAt(120, 40, b.x + 3, footer, "corgi")).toBe(false);
  expect(help.pointsAt(120, 40, 0, 0, "corgi")).toBe(false);
  let keys_at: number | null = null;
  for (let y = b.y + 5; y < b.y + b.h - 3; y++)
    if (help.pointsAt(120, 40, b.x + Math.floor(b.w / 2) - 6, y, "corgi")) {
      keys_at = y;
      break;
    }
  expect(keys_at).not.toBeNull();
  const shown = Object.assign(new State(), { command_mode: true });
  expect(shown.frame(120, 40, "corgi", "ctrl_b", 0, "pointer").endsWith("\x1b]22;pointer\x1b\\\x1b[?2026l")).toBe(true);
});

test("the corgi's secret key shadows no shortcut", () => {
  for (const preset of available_presets) expect(bindings.lookup(preset, true, 0x74, {})).toBeNull();
});
