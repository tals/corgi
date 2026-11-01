import { expect, test } from "bun:test";
import * as navigation from "./navigation";
import * as mirror from "./mirror";
import * as layout from "./layout";
import { transport } from "./fixtures/transport";

function world() {
  const runtime = new mirror.Runtime();
  runtime.receive(
    transport(async () => {
      throw Error("UnexpectedRequest");
    }),
    {
      workspaces: [1, 2, 3].map(id => ({
        id,
        model: {
          nodes: [1, 2, 3].map(n => ({ pane: id * 10 + n })),
          tabs: [1, 2, 3].map((n, root) => ({ id: id * 10 + n, root, title: "" })),
          revision: 0,
        },
      })),
    },
  );
  return runtime.workspaces;
}

test("last tab toggles by identity and keeps the last focused pane in a split", () => {
  const store = world(),
    state = new navigation.State(),
    model = store.items[0].model;
  expect(state.lastTab(store)).toBeNull();
  state.focus(store, 13);
  const split = model.split(13, "horizontal");
  state.focus(store, split);
  expect(state.lastTab(store)).toBe(11);
  state.focus(store, state.lastTab(store)!);
  expect(state.lastTab(store)).toBe(split);
  model.moveTab(model.tabs[2].id, 0);
  expect(state.lastTab(store)).toBe(split);
  model.close(split);
  expect(state.lastTab(store)).toBe(13);
  state.focus(store, state.lastTab(store)!);
  expect(state.lastTab(store)).toBe(11);
});

test("tab history belongs to each viewer and workspace, and previews leave it alone", () => {
  const store = world(),
    a = new navigation.State(),
    b = new navigation.State();
  a.focus(store, 13);
  a.entering(store, store.items[0], 12);
  b.focus(store, 12);
  a.switchWorkspace(store, 2);
  a.focus(store, 23);
  a.switchWorkspace(store, 1);
  expect(a.lastTab(store)).toBe(11);
  expect(b.lastTab(store)).toBe(11);
  a.focus(store, a.lastTab(store)!);
  expect(a.lastTab(store)).toBe(13);
  expect(b.tabs(store).tab().focus).toBe(12);
  a.switchWorkspace(store, 2);
  expect(a.lastTab(store)).toBe(21);
  expect(b.lastWorkspace(store)).toBeNull();
});

test("closed previous tabs do not fall back to older visits or replacement tabs", () => {
  const store = world(),
    state = new navigation.State(),
    model = store.items[0].model;
  state.focus(store, 13);
  state.focus(store, 12);
  model.close(13);
  model.newTab("replacement");
  expect(state.lastTab(store)).toBeNull();
  expect(state.tabs(store).tab().focus).toBe(12);
  state.focus(store, 11);
  model.close(11);
  expect(state.tabs(store).tab().focus).toBe(12);
  expect(state.lastTab(store)).toBeNull();
  model.close(12);
  model.close(model.firstPane(model.tabs[0].root));
  expect(state.lastTab(store)).toBeNull();
});

test("last workspace ignores reselecting and reordering, and rejects a closed target", () => {
  const store = world(),
    state = new navigation.State();
  expect(state.lastWorkspace(store)).toBeNull();
  state.switchWorkspace(store, 3);
  state.switchWorkspace(store, 3);
  store.items.reverse();
  expect(state.lastWorkspace(store)).toBe(1);
  state.switchWorkspace(store, state.lastWorkspace(store)!);
  expect(state.lastWorkspace(store)).toBe(3);
  state.switchWorkspace(store, 2);
  store.items = store.items.filter(ws => ws.id !== 1);
  expect(state.lastWorkspace(store)).toBeNull();
  expect(state.current(store).id).toBe(2);
  expect(() => state.switchWorkspace(store, 99)).toThrow("NoWorkspace");
  expect(state.lastWorkspace(store)).toBeNull();
});

test("initial focus and a reused workspace slot start without tab history", () => {
  const store = world(),
    state = new navigation.State();
  state.focus(store, 13, false);
  expect(state.lastTab(store)).toBeNull();
  state.focus(store, 12);
  expect(state.lastTab(store)).toBe(13);
  state.switchWorkspace(store, 2);
  store.items = store.items.filter(ws => ws.id !== 1);
  state.switchWorkspace(store, 3);
  expect(state.lastTab(store)).toBeNull();
  expect(state.tabs(store).tab().focus).toBe(31);
  expect(state.command(store, { name: "prev" }, new layout.Rect()).focus).toBe(33);
});
