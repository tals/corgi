import { test, expect } from "bun:test";
import { State, WorkspacePreview } from "./onboarding";
import { Worker, workspace, pane } from "./import/catalog";
const conn: any = {
  call: () => {
    throw Error("UnexpectedRpc");
  },
};
function attach(
  state: State,
  source: "tmux" | "herdr",
  items: any[],
  message = "",
) {
  const worker = new Worker(source);
  worker.done = true;
  worker.catalog.workspaces = items;
  worker.catalog.message = message;
  state.workers.set(source, worker);
  return worker;
}
test("onboarding offers only platform-supported presets and import sources", async () => {
  const state = new State();
  expect(state.frame(100, 34).includes("cmux")).toBe(
    process.platform === "darwin",
  );
  await state.key("k", conn);
  expect(state.preset).toBe(process.platform === "darwin" ? "cmux" : "herdr");
  await state.key("j", conn);
  expect(state.preset).toBe("corgi");
  await state.key("4", conn);
  expect(state.preset).toBe(process.platform === "darwin" ? "cmux" : "corgi");
  state.step = "import";
  expect(state.frame(100, 34).includes("cmux")).toBe(
    process.platform === "darwin",
  );
  if (process.platform !== "darwin") {
    await state.key("3", conn);
    expect(state.source).toBe("tmux");
    expect(() => Worker.start("cmux")).toThrow("CmuxRequiresMacOS");
  }
  state.deinit();
});
test("tmux selects at most three recent groups once per discovery", () => {
  const state = new State();
  state.step = "import";
  attach(
    state,
    "tmux",
    ["first", "second", "third", "fourth"].map((name, i) =>
      workspace({ id: String(i), name, tabs: [] }),
    ),
  );
  state.selectDefaults();
  expect(state.selected.slice(0, 4)).toEqual([true, true, true, false]);
  state.selected[0] = false;
  state.scan();
  state.selectDefaults();
  expect(state.selected[0]).toBe(false);
  state.deinit();
});
test("failed discovery does not claim the source has no sessions", () => {
  const state = new State();
  state.step = "import";
  attach(state, "tmux", [], "FileNotFound");
  const output = state.frame(76, 26);
  expect(output.includes("Couldn't read this source.")).toBe(true);
  expect(output.includes("No available sessions found")).toBe(false);
  state.deinit();
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
      panes: ["two", "three", "four", "five"].map((name, i) =>
        pane({ id: String(i + 2), name }),
      ),
    },
    {
      id: "t3",
      name: "hidden-tab",
      nodes: [],
      panes: ["six", "seven", "eight"].map((name, i) =>
        pane({ id: String(i + 6), name }),
      ),
    },
  ];
  const state = new State();
  state.step = "import";
  state.source = "herdr";
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
  expect(state.expanded[1]).toBe(true);
  expect(state.expanded[0]).toBe(false);
  expect(state.cursor).toBe(0);
  expect(state.chosen(0)).toBe(true);
  expect(state.chosen(1)).toBe(false);
  const expanded = state.frame(76, 26);
  expect(expanded.includes("Show less")).toBe(true);
  expect(expanded.includes("hidden-tab")).toBe(true);
  await state.click(76, 26, 8, 12, conn);
  expect(state.expanded[1]).toBe(false);
  state.frame(76, 26);
  await state.click(76, 26, 8, 14, conn);
  expect(state.cursor).toBe(1);
  state.deinit();
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
  keyboard.deinit();
  escape.deinit();
  welcome.deinit();
});
