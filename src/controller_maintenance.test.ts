import { expect, spyOn, test } from "bun:test";
import { Controller } from "./controller";
import { transport } from "./fixtures/transport";
import { Dialog } from "./workspace_archive";

function fixture(
  dormant = false,
  request: Parameters<typeof transport>[0] = async () => {
    throw Error("UnexpectedRequest");
  },
) {
  const view = new Controller(transport(request));
  view.receiveSnapshot({
    workspaces: [1, 2].map(id => ({
      id,
      name: `workspace ${id}`,
      cwd: "",
      model: { nodes: [{ pane: id }], tabs: [{ id, root: 0, title: "" }], revision: 0 },
    })),
    panes: [1, 2].map(id => ({ id, workspace: id, tab: id, cols: 72, rows: 29, dormant, agent: {} })),
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

test("archive selection previews without focusing, acknowledging, or waking; Enter opens the agent", async () => {
  const f = fixture();
  const edit = spyOn(f.view as unknown as { edit(command: unknown): Promise<void> }, "edit").mockResolvedValue();
  try {
    f.view.width = 100;
    f.view.height = 30;
    f.view.input_state.attached = true;
    const p = f.view.runtime.pane(2)!;
    p.dormant = true;
    p.agent.provider = "claude";
    p.agent.name = "Review migration";
    p.agent.observation.completed = 1n;
    const d = new Dialog(2, "workspace 2");
    d.preview = {
      workspace: 2,
      name: "workspace 2",
      agents: [
        {
          target: { pane: 2 },
          name: "Review migration",
          provider: "claude",
          activity: "",
          state: "idle",
          running: false,
          attention: "finished",
          unread: true,
          paused: false,
        },
      ],
      processes: [],
      links: [],
      processes_available: true,
      processes_partial: false,
      links_available: true,
    };
    d.preview.agents.push({ ...d.preview.agents[0], target: { pane: 1 }, name: "Other agent" });
    f.view.archive_dialog = d;
    expect(f.view.previewGhost()).toBeNull();
    await f.view.input(Buffer.from("\x1b[B"));
    expect(d.selected).toBe(0);
    expect(f.view.previewGhost()?.pane.id).toBe(2);
    expect(f.view.focused()?.id).toBe(1);
    const v = d.view(f.view.width, f.view.height, f.view.area());
    const hover = (y: number) => f.view.input(Buffer.from(`\x1b[<35;${v.box.x + 5};${y + 1}M`));
    await hover(v.body_y + 2);
    expect(f.view.previewGhost()?.pane.id).toBe(1);
    expect(d.selected).toBe(0);
    expect(d.view(f.view.width, f.view.height, f.view.area()).box).toEqual(v.box);
    await hover(v.buttons_y);
    expect(f.view.previewGhost()?.pane.id).toBe(2);
    await hover(v.body_y + 2);
    expect(f.view.previewGhost()?.pane.id).toBe(1);
    // Keyboard navigation takes over until the mouse moves again.
    await f.view.input(Buffer.from("\x1b[A"));
    expect(f.view.pointer).toBeNull();
    expect(d.selected).toBe(1);
    expect(f.view.previewGhost()?.pane.id).toBe(1);
    await f.view.input(Buffer.from("\x1b[B"));
    expect(d.selected).toBe(0);
    expect(f.view.previewGhost()?.pane.id).toBe(2);
    await f.view.expireInput();
    expect(edit).not.toHaveBeenCalled();
    expect(p.agent.observation.read).toBe(0n);
    expect(p.dormant).toBe(true);
    await f.view.input(Buffer.from("\r"));
    expect(f.view.archive_dialog).toBeNull();
    expect(f.view.focused()?.id).toBe(2);
    await f.view.expireInput();
    expect(edit).toHaveBeenCalledWith({ "pane.wake": { target: 2 } });
    expect(edit).toHaveBeenCalledTimes(1);
    f.view.archive_dialog = d;
    expect(f.view.previewGhost()?.pane.id).toBe(2);
    await f.view.perform({ name: "archive-cancel" });
    expect(f.view.previewGhost()).toBeNull();
  } finally {
    edit.mockRestore();
    f.close();
  }
});

test("dormant wake failure is awaited and retried only after focus leaves the pane", async () => {
  const f = fixture(true);
  const edit = spyOn(f.view as unknown as { edit(command: unknown): Promise<void> }, "edit").mockRejectedValue(
    Error("WakeFailed"),
  );
  try {
    const pane = f.view.focused()!;
    pane.dormant = true;
    const waking = f.view["wakeFocused"]();
    expect(waking).toBeInstanceOf(Promise);
    await waking;
    expect(f.view.message).toContain("Could not change pane or workspace state");
    expect(f.view["wakeFocused"]()).toBeUndefined();
    expect(edit).toHaveBeenCalledTimes(1);
    f.view.focusPane(2);
    await f.view["wakeFocused"]();
    f.view.focusPane(pane.id);
    await f.view["wakeFocused"]();
    expect(edit).toHaveBeenCalledTimes(3);
  } finally {
    edit.mockRestore();
    f.close();
  }
});

test("hibernating the selected awake pane does not create a focus entry", async () => {
  const f = fixture();
  const edit = spyOn(f.view as unknown as { edit(command: unknown): Promise<void> }, "edit").mockResolvedValue();
  try {
    const snapshot = structuredClone(f.view.runtime.snapshot);
    snapshot.panes[0].dormant = true;
    f.view.receiveSnapshot(snapshot);
    await f.view.expireInput();
    f.view.receiveSnapshot(snapshot);
    await f.view.expireInput();
    expect(edit).not.toHaveBeenCalled();
    expect(f.view.focused()?.id).toBe(1);
    // Both moves may happen before the maintenance pass.
    f.view.focusPane(2);
    f.view.focusPane(1);
    await f.view.expireInput();
    expect(edit).toHaveBeenCalledWith({ "pane.wake": { target: 1 } });
    await f.view.expireInput();
    expect(edit).toHaveBeenCalledTimes(1);
  } finally {
    edit.mockRestore();
    f.close();
  }
});

test("initial recovery and reconciled selection wake once, while explicit Resume can retry", async () => {
  const f = fixture(true);
  const edit = spyOn(f.view as unknown as { edit(command: unknown): Promise<void> }, "edit").mockResolvedValue();
  try {
    await f.view.expireInput();
    await f.view.expireInput();
    expect(edit).toHaveBeenCalledTimes(1);
    const snapshot = structuredClone(f.view.runtime.snapshot);
    snapshot.workspaces.shift();
    snapshot.panes.shift();
    f.view.receiveSnapshot(snapshot);
    await f.view.expireInput();
    expect(edit).toHaveBeenLastCalledWith({ "pane.wake": { target: 2 } });
    await f.view.perform({ name: "wake" });
    expect(edit).toHaveBeenCalledTimes(3);
  } finally {
    edit.mockRestore();
    f.close();
  }
});

test("archived workspaces expand from the sidebar header without waking until opened", async () => {
  const f = fixture();
  const edit = spyOn(f.view as unknown as { edit(command: unknown): Promise<void> }, "edit").mockResolvedValue();
  try {
    const snapshot = structuredClone(f.view.runtime.snapshot);
    snapshot.workspaces[0].archived = true;
    snapshot.panes[0].dormant = true;
    f.view.receiveSnapshot(snapshot);
    expect(f.view.current().id).toBe(2);
    expect(f.view.workspaceEntries().map(w => w.id)).toEqual([2]);
    expect(f.view.archivedWorkspaceEntries().map(w => w.id)).toEqual([1]);
    expect(f.view.archived_expanded).toBe(false);
    await f.view.perform({ name: "choose-workspace" });
    f.view.input_state.attached = true;
    await f.view.input(Buffer.from("\x1b[B"));
    expect(f.view.sidebar_focus?.cursor).toEqual({ archived: true });
    await f.view.input(Buffer.from("\r"));
    expect(f.view.archived_expanded).toBe(true);
    await f.view.expireInput();
    expect(edit).not.toHaveBeenCalled();
    expect(f.view.runtime.pane(1)?.dormant).toBe(true);
    await f.view.input(Buffer.from("\x1b[B"));
    expect(f.view.sidebar_focus?.cursor).toEqual({ workspace: 1 });
    await f.view.input(Buffer.from("\r"));
    expect(f.view.current().id).toBe(1);
  } finally {
    edit.mockRestore();
    f.close();
  }
});

test("archive preview never mutates until confirmed, and cancellation ignores a late reply", async () => {
  let resolve: ((value: unknown) => void) | null = null;
  const f = fixture(false, async op => {
    expect(op).toBe("workspace.archive.preview");
    return new Promise(done => {
      resolve = done;
    });
  });
  const edit = spyOn(f.view as unknown as { edit(command: unknown): Promise<void> }, "edit").mockResolvedValue();
  const response = {
    preview: {
      workspace: 1,
      name: "one",
      agents: [],
      processes: [],
      links: [],
      processes_available: true,
      processes_partial: false,
      links_available: true,
    },
  };
  try {
    await f.view.perform({ name: "archive-workspace" });
    expect(f.view.archive_dialog).not.toBeNull();
    f.view.input_state.attached = true;
    await f.view.input(Buffer.from("a"));
    expect(edit).not.toHaveBeenCalled();
    f.view.input_state.attached = true;
    await f.view.input(Buffer.from("\r"));
    expect(f.view.archive_dialog).toBeNull();
    resolve!(response);
    await Promise.resolve();
    expect(f.view.archive_dialog).toBeNull();
    await f.view.perform({ name: "archive-workspace" });
    resolve!(response);
    await new Promise(done => setTimeout(done, 0));
    expect(f.view.archive_dialog?.preview).not.toBeNull();
    expect(edit).not.toHaveBeenCalled();
    await f.view.input(Buffer.from("a"));
    expect(edit).toHaveBeenCalledWith({ "workspace.archive": { target: 1 } });
    expect(f.view.archive_dialog).toBeNull();
  } finally {
    edit.mockRestore();
    f.close();
  }
});
