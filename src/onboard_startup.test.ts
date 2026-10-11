import { transport } from "./fixtures/transport";
import { test, expect, spyOn } from "bun:test";
import { Controller } from "./controller";
import * as viewer from "./viewer";

/** One workspace with one pane, as `session.snapshot` sends it. */
const snapshot = () => ({
  workspaces: [
    {
      id: 1,
      name: "one",
      cwd: "/tmp",
      model: { nodes: [{ pane: 1 }], tabs: [{ id: 1, root: 0, title: "" }], revision: 0 },
    },
  ],
  panes: [
    {
      id: 1,
      workspace: 1,
      tab: 1,
      cols: 80,
      rows: 24,
      agent: { provider: null, attention: "none", observation: { completed: 0, read: 0 } },
    },
  ],
  conversations: [],
  native_sessions: [],
});
import { run } from "./main";
import * as rpc from "./rpc";
import * as preferences from "./preferences";

test("onboard inside a pane routes the viewer action without requiring a terminal", async () => {
  const previous = process.env.CORGI_PANE;
  process.env.CORGI_PANE = "7";
  const request = spyOn(rpc, "request").mockResolvedValue({ ok: true });
  const output = spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    await run(["onboard"]);
    expect(request.mock.calls[0]?.slice(1)).toEqual(["action", { name: "onboard", pane: 7 }]);
  } finally {
    request.mockRestore();
    output.mockRestore();
    if (previous === undefined) delete process.env.CORGI_PANE;
    else process.env.CORGI_PANE = previous;
  }
});

test("explicit onboarding opens again after preferences say it was completed", async () => {
  const prefs = new preferences.Preferences();
  prefs.onboarding_complete = true;
  const load = spyOn(preferences, "load").mockReturnValue(prefs);
  const calls: any[] = [];
  const view = new Controller({
    socket: "",
    request: transport(async (op, fields) => {
      calls.push({ op, fields });
      return { viewer_protocol: 3, workspace: 1, bell_seq: 0 };
    }).request,
  });
  view.receiveSnapshot(snapshot());
  const refresh = spyOn(view, "refresh").mockResolvedValue(undefined);
  try {
    await viewer.openMode(view, "/tmp", {}, "", true);
    expect(calls[0].fields.onboarding).toBe(true);
    expect(view.onboarding).not.toBeNull();
  } finally {
    refresh.mockRestore();
    load.mockRestore();
    viewer.close(view);
  }
});

test("a relaunch control exits sync with its executable before acknowledgement", async () => {
  const view = new Controller({
    socket: "",
    request: transport(async () => ({
      viewer_protocol: 3,
      session: null,
      session_hash: 0,
      resources: null,
      resources_hash: 0,
      viewer: 1,
      controls: [{ seq: 1, kind: "action", name: "relaunch", value: "/tmp/new-corgi" }],
      surfaces: [],
      bell_seq: 0,
      bell_kind: "none",
      detach: false,
    })).request,
  });
  view.receiveSnapshot(snapshot());
  try {
    expect(await viewer.sync(view, { seq: 0n }, false)).toBe(false);
    expect(view.executable).toBe("/tmp/new-corgi");
    expect(view.input_state.last_control).toBe(0n);
    expect(view.message).not.toBe("UnknownAction");
  } finally {
    viewer.close(view);
  }
});
