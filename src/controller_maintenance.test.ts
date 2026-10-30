import { expect, spyOn, test } from "bun:test";
import { Controller } from "./controller";
import { transport } from "./fixtures/transport";

function fixture() {
  const view = new Controller(
    transport(async () => {
      throw Error("UnexpectedRequest");
    }),
  );
  view.receiveSnapshot({
    workspaces: [1, 2].map(id => ({
      id,
      name: `workspace ${id}`,
      cwd: "",
      model: { nodes: [{ pane: id }], tabs: [{ id, root: 0, title: "" }], revision: 0 },
    })),
    panes: [1, 2].map(id => ({ id, workspace: id, tab: id, cols: 72, rows: 29, agent: {} })),
    conversations: [],
    headless_sessions: [],
  });
  const previews = spyOn(view.launch_previews, "poll").mockReturnValue(false);
  return {
    view,
    previews,
    close() {
      previews.mockRestore();
      view.runtime.destroy();
    },
  };
}

test("ordinary maintenance keeps preview polling without opening asynchronous jobs", async () => {
  const f = fixture();
  const removals = spyOn(f.view as unknown as { finishAccountRemovals(): Promise<void> }, "finishAccountRemovals");
  try {
    expect(f.view["wakeFocused"]()).toBeUndefined();
    expect(f.view["pollLauncher"](false)).toBeUndefined();
    expect(f.previews).toHaveBeenCalledTimes(1);
    await f.view.expireInput();
    expect(f.previews).toHaveBeenCalledTimes(2);
    expect(removals).not.toHaveBeenCalled();
  } finally {
    removals.mockRestore();
    f.close();
  }
});

test("dormant wake failure is awaited and retried only after focus leaves the pane", async () => {
  const f = fixture();
  const edit = spyOn(f.view as unknown as { edit(command: unknown): Promise<void> }, "edit").mockRejectedValue(
    Error("WakeFailed"),
  );
  try {
    const pane = f.view.focused()!;
    pane.dormant = true;
    const waking = f.view["wakeFocused"]();
    expect(waking).toBeInstanceOf(Promise);
    await waking;
    expect(f.view.message).toContain("Could not resume this agent");
    expect(f.view["wakeFocused"]()).toBeUndefined();
    expect(edit).toHaveBeenCalledTimes(1);
    f.view.focusPane(2);
    expect(f.view["wakeFocused"]()).toBeUndefined();
    f.view.focusPane(pane.id);
    await f.view["wakeFocused"]();
    expect(edit).toHaveBeenCalledTimes(2);
  } finally {
    edit.mockRestore();
    f.close();
  }
});
