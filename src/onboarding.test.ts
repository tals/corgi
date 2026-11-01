import { test, expect } from "bun:test";
import { State, bounds, presetLayout } from "./onboarding";
import * as palette from "./palette";
import * as i18n from "./i18n";
import { Terminal } from "./pane/terminal";
import { Worker, workspace, pane, available_sources } from "./import/catalog";
const conn: any = {
  call: () => {
    throw Error("UnexpectedRpc");
  },
};
test("translated welcome hints leave room before the continue button", () => {
  const previous = i18n.language();
  try {
    for (const language of i18n.locales) {
      i18n.setLanguage(language);
      for (const cols of [76, 80, 112]) {
        const state = new State(),
          terminal = new Terminal(cols, 26);
        try {
          terminal.feed(state.frame(cols, 26));
          const label = i18n.t`[ Enter Continue → ]`,
            row = terminal
              .text()
              .split("\n")
              .find(row => row.includes(label))!;
          expect(row).toBeDefined();
          expect(row.slice(0, row.indexOf(label))).toEndWith("  ");
          expect(row.slice(row.indexOf(label) + label.length)).toMatch(/^\s*│\s*$/);
        } finally {
          terminal.destroy();
          state.close();
        }
      }
    }
  } finally {
    i18n.setLanguage(previous);
  }
});
function attach(state: State, source: "tmux" | "herdr", items: any[], message = "") {
  const worker = new Worker(source);
  worker.done = true;
  worker.catalog.workspaces = items;
  worker.catalog.message = message;
  state.picker.workers.set(source, worker);
  return worker;
}
test("onboarding offers only platform-supported presets and import sources", async () => {
  const state = new State();
  expect(state.frame(100, 34).includes("cmux")).toBe(process.platform === "darwin");
  await state.key("k", conn);
  expect(state.preset).toBe(process.platform === "darwin" ? "cmux" : "herdr");
  await state.key("j", conn);
  expect(state.preset).toBe("corgi");
  await state.key("4", conn);
  expect(state.preset).toBe(process.platform === "darwin" ? "cmux" : "corgi");
  state.step = "import";
  expect(state.frame(100, 34).includes("cmux")).toBe(available_sources.includes("cmux"));
  if (process.platform !== "darwin") {
    await state.key("3", conn);
    expect(state.picker.source).toBe("tmux");
    expect(() => Worker.start("cmux")).toThrow("CmuxRequiresMacOS");
  }
  state.close();
});
test("failed discovery does not claim the source has no sessions", () => {
  const state = new State();
  state.step = "import";
  attach(state, "tmux", [], "FileNotFound");
  const output = state.frame(76, 26);
  expect(output.includes("Couldn't read this source.")).toBe(true);
  expect(output.includes("No available sessions found")).toBe(false);
  state.close();
});
test("workspace previews keep recovery rows and handoff selection aligned while expanding", async () => {
  const tabs = [
    {
      id: "t1",
      name: "shell",
      nodes: [],
      panes: [pane({ id: "1", name: "one" })],
    },
    {
      id: "t2",
      name: "split",
      nodes: [],
      panes: ["two", "three", "four", "five"].map((name, i) => pane({ id: String(i + 2), name })),
    },
    {
      id: "t3",
      name: "hidden-tab",
      nodes: [],
      panes: ["six", "seven", "eight"].map((name, i) => pane({ id: String(i + 6), name })),
    },
  ];
  const state = new State();
  state.step = "import";
  state.picker.source = "herdr";
  attach(state, "herdr", [
    workspace({
      id: "a",
      name: "first",
      tabs,
      handoff: true,
      session: 0,
      recovery: "workspace",
      recovery_note: "Recovery note",
    }),
    workspace({ id: "b", name: "second", tabs, handoff: true, session: 1 }),
  ]);
  const initial = state.frame(76, 26);
  expect(initial.includes("…5 more")).toBe(true);
  expect(initial.includes("hidden-tab")).toBe(false);
  expect(initial.includes("[ ] second")).toBe(true);
  await state.sequence("\x1b[6~", conn);
  state.frame(76, 26);
  await state.click(76, 26, 8, 20, conn);
  expect(state.picker.expanded[1]).toBe(true);
  expect(state.picker.expanded[0]).toBe(false);
  expect(state.picker.cursor).toBe(0);
  expect(state.picker.chosen(0)).toBe(true);
  expect(state.picker.chosen(1)).toBe(false);
  const expanded = state.frame(76, 26);
  expect(expanded.includes("Show less")).toBe(true);
  expect(expanded.includes("hidden-tab")).toBe(true);
  await state.click(76, 26, 8, 12, conn);
  expect(state.picker.expanded[1]).toBe(false);
  state.frame(76, 26);
  await state.click(76, 26, 8, 14, conn);
  expect(state.picker.cursor).toBe(1);
  state.close();
});
test("keyboard setup saves without chaining and Esc closes it; first run cannot be dismissed", async () => {
  const keyboard = State.start("keyboard", "tmux", "ctrl_b");
  expect(await keyboard.key(13, conn)).toBe(true);
  expect(keyboard.step).toBe("presets");
  const escape = State.start("keyboard", "corgi", "ctrl_b");
  expect(await escape.key(27, conn)).toBe(true);
  expect(escape.cancelled).toBe(true);
  const welcome = new State();
  expect(await welcome.key(27, conn)).toBe(false);
  expect(welcome.cancelled).toBe(false);
  keyboard.close();
  escape.close();
  welcome.close();
});
test("welcome's arrows move between the presets and the themes beside them", async () => {
  // 3024 Day: dark text on a light background.
  palette.use(undefined, { foreground: [74, 69, 67], background: [247, 247, 247], ansi: Array(16).fill(null) });
  const welcome = new State(),
    keyboard = State.start("keyboard", "corgi", "ctrl_b");
  try {
    expect(welcome.frame(112, 36)).toContain(" Theme ");
    expect(palette.chosen(welcome.theme)).toBe("animal_style");
    await welcome.sequence("\x1b[C", conn);
    expect(welcome.column).toBe("theme");
    await welcome.sequence("\x1b[B", conn);
    expect(welcome.theme).toBe("corgi");
    expect(welcome.preset).toBe("corgi");
    await welcome.sequence("\x1b[D", conn);
    await welcome.sequence("\x1b[B", conn);
    expect(welcome.theme).toBe("corgi");
    expect(welcome.preset).toBe("tmux");
    const animal = presetLayout(bounds(76, 26)).themes[1];
    await welcome.click(76, 26, animal.x + 20, animal.y, conn);
    expect(welcome.theme).toBe("animal_style");
    expect(welcome.column).toBe("theme");
    // The keyboard screen keeps to keys.
    expect(keyboard.frame(112, 36)).not.toContain(" Theme ");
    await keyboard.sequence("\x1b[C", conn);
    expect(keyboard.column).toBe("presets");
  } finally {
    welcome.close();
    keyboard.close();
    palette.use(undefined, null);
  }
});
