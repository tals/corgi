import { test, expect } from "bun:test";
import { State, bounds, presetLayout } from "./onboarding";
import * as palette from "./palette";
import * as i18n from "./i18n";
import * as screen from "./fixtures/screen";
import { Worker, workspace, pane, available_sources, type Source } from "./import/catalog";
const conn: any = {
  call: () => {
    throw Error("UnexpectedRpc");
  },
};
test.each(["ctrl+b", "control+b", "Ctrl+B"])("prefix toggles compare the logical key for %s", async prefix => {
  for (const key of ["p", " ", "\r"]) {
    const state = State.start("keyboard", "corgi", prefix);
    try {
      state.focus = 1;
      await state.key(key, conn);
      expect(state.prefix).toBe("ctrl+a");
      await state.key(key, conn);
      expect(state.prefix).toBe("ctrl+b");
    } finally {
      state.close();
    }
  }
});
test("translated welcome hints leave room before the continue button", () => {
  const previous = i18n.language();
  try {
    for (const language of i18n.locales) {
      i18n.setLanguage(language);
      for (const cols of [76, 80, 112]) {
        const state = new State();
        try {
          const label = i18n.t`[ Enter Continue → ]`,
            row = screen.lines(state.frame(cols, 26), cols, 26).find(row => row.includes(label))!;
          expect(row).toBeDefined();
          expect(row.slice(0, row.indexOf(label))).toEndWith("  ");
          expect(row.slice(row.indexOf(label) + label.length)).toMatch(/^\s*│\s*$/);
        } finally {
          state.close();
        }
      }
    }
  } finally {
    i18n.setLanguage(previous);
  }
});
function attach(state: State, source: Source, items: any[], message = "") {
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
const session = (name: string) =>
  workspace({ id: name, name, tabs: [{ id: name, name, nodes: [], panes: [pane({ id: name, name })] }] });
test("import leaves out sources with nothing to copy", async () => {
  const state = new State();
  try {
    for (const source of available_sources) attach(state, source, [], source === "tmux" ? "NoTmuxSessions" : "");
    attach(state, "herdr", [session("work")]);
    state.preset = "tmux";
    expect(await state.key(13, conn)).toBe(false);
    expect(state.step).toBe("import");
    expect(state.sources()).toEqual(["herdr"]);
    expect(state.picker.source).toBe("herdr");
    const output = state.frame(100, 34);
    expect(output).toContain("[ 1 herdr ]");
    expect(output).not.toContain("tmux");
    expect(output).not.toContain("Couldn't read this source.");
    await state.key("1", conn);
    expect(state.picker.source).toBe("herdr");
  } finally {
    state.close();
  }
});
test("import is skipped when no source has anything to copy", async () => {
  const found = new State(),
    scanning = new State();
  try {
    for (const source of available_sources) attach(found, source, []);
    expect(await found.key(13, conn)).toBe(true);
    // Scans that finish after the step opens end it from the poll.
    const workers = available_sources.map(source => attach(scanning, source, []));
    for (const worker of workers) worker.done = false;
    expect(await scanning.key(13, conn)).toBe(false);
    expect(await scanning.poll(conn)).toBe(false);
    expect(scanning.done).toBe(false);
    for (const worker of workers) worker.done = true;
    expect(await scanning.poll(conn)).toBe(true);
    expect(scanning.done).toBe(true);
    // A failed finish doesn't retry on every poll.
    scanning.fail("ReadOnlyFileSystem");
    await scanning.poll(conn);
    expect(scanning.done).toBe(false);
  } finally {
    found.close();
    scanning.close();
  }
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
  const keyboard = State.start("keyboard", "tmux", "ctrl+b");
  expect(await keyboard.key(13, conn)).toBe(true);
  expect(keyboard.step).toBe("presets");
  const escape = State.start("keyboard", "corgi", "ctrl+b");
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
    keyboard = State.start("keyboard", "corgi", "ctrl+b");
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
