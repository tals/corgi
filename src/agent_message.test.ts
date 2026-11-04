import { test, expect, spyOn } from "bun:test";
import { Runtime, Pane } from "./runtime";
import { Workspace } from "./workspace";
import { Terminal } from "./pane/terminal";
import { execute } from "./session";
import { Text, adapter } from "./providers";
import * as agentMessage from "./agent_message";
import type { Session } from "./headless";
const ctx = { socket: "/tmp/corgi-test", executable: "/bin/corgi", theme: {} };
function setup() {
  const r = new Runtime(),
    w = new Workspace(1, "/tmp");
  r.workspaces.items = [w];
  w.model.next_id = r.workspaces.next_pane_id;
  const id = w.model.newTab("");
  r.workspaces.next_pane_id = w.model.next_id;
  r.panes.push(new Pane(id, Terminal.create(20, 4), "/tmp"));
  const pane = r.pane(id)!;
  return { r, id, pane, pending: () => pane.terminal.native({ op: "takePending" }) };
}
const message = (target: { pane: number } | { headless: number }, text: string) => ({
  "agent.message": { target, text },
});
test("a message goes through the agent's own channel when it has one", async () => {
  const { r, id, pane, pending } = setup(),
    sent: string[] = [],
    channel = spyOn(adapter("claude").message!, "channel").mockImplementation(
      async () => async text => void sent.push(text),
    );
  try {
    pane.agent().provider = "claude";
    pane.agent().session = new Text("a-session");
    const result = await execute(r, ctx, message({ pane: id }, "review this"));
    expect(result).toMatchObject({ pane: id, workspace: 1, delivery: "message", queued: false });
    expect(channel.mock.calls[0][0]).toBe("a-session");
    expect(sent).toEqual(["review this"]);
    expect(pending()).toBe("");
    // A channel queues for an agent mid-turn, even one answering a prompt.
    for (const state of ["working", "blocked"] as const) {
      pane.agent().state = state;
      expect(await execute(r, ctx, message({ pane: id }, state))).toMatchObject({ delivery: "message", queued: true });
    }
    expect(sent).toEqual(["review this", "working", "blocked"]);
  } finally {
    channel.mockRestore();
    r.destroy();
  }
});
test("without a channel a message is typed and submitted", async () => {
  const { r, id, pane, pending } = setup(),
    channel = spyOn(adapter("claude").message!, "channel").mockResolvedValue(null);
  try {
    // Before it knows its conversation, the agent has no channel to try.
    pane.agent().provider = "claude";
    expect(await execute(r, ctx, message({ pane: id }, "ls"))).toMatchObject({ delivery: "typed", queued: false });
    expect(pending()).toBe("ls\r");
    expect(channel).not.toHaveBeenCalled();
    pane.agent().session = new Text("a-session");
    pane.agent().state = "working";
    pane.terminal.feed("\x1b[?2004h");
    expect(await execute(r, ctx, message({ pane: id }, "hi"))).toMatchObject({ delivery: "typed", queued: true });
    expect(channel).toHaveBeenCalled();
    expect(pending()).toBe("\x1b[200~hi\x1b[201~\r");
  } finally {
    channel.mockRestore();
    r.destroy();
  }
});
test("a channel that took nothing falls back to typing; other failures don't", async () => {
  const { r, id, pane, pending } = setup();
  let failure = "MessageUnavailable";
  const channel = spyOn(adapter("claude").message!, "channel").mockImplementation(async () => async () => {
    throw Error(failure);
  });
  try {
    pane.agent().provider = "claude";
    pane.agent().session = new Text("a-session");
    expect(await execute(r, ctx, message({ pane: id }, "go"))).toMatchObject({ delivery: "typed" });
    expect(pending()).toBe("go\r");
    failure = "DeliveryUnknown";
    await expect(execute(r, ctx, message({ pane: id }, "go"))).rejects.toThrow("DeliveryUnknown");
    expect(pending()).toBe("");
  } finally {
    channel.mockRestore();
    r.destroy();
  }
});
test("typing refuses an agent answering a prompt or holding a draft", async () => {
  const { r, id, pane, pending } = setup();
  let empty = true;
  const channel = spyOn(adapter("codex").message!, "channel").mockResolvedValue(null),
    composer = spyOn(adapter("codex").message!, "empty").mockImplementation(() => empty);
  try {
    pane.agent().provider = "codex";
    pane.agent().session = new Text("a-thread");
    pane.agent().state = "blocked";
    await expect(execute(r, ctx, message({ pane: id }, "y"))).rejects.toThrow("AgentBlocked");
    pane.agent().state = "idle";
    empty = false;
    await expect(execute(r, ctx, message({ pane: id }, "go"))).rejects.toThrow("AgentBusy");
    expect(pending()).toBe("");
    empty = true;
    expect(await execute(r, ctx, message({ pane: id }, "go"))).toMatchObject({ delivery: "typed" });
    expect(pending()).toBe("go\r");
  } finally {
    channel.mockRestore();
    composer.mockRestore();
    r.destroy();
  }
});
test("a headless agent gets a message as a prompt to its conversation", async () => {
  const { r } = setup(),
    inputs: unknown[] = [],
    session = {
      id: 4,
      session: "thread",
      exited: false,
      status: () => "idle",
      send: (input: unknown) => inputs.push(input),
    };
  r.sessions.push(session as unknown as Session);
  try {
    expect(await execute(r, ctx, message({ headless: 4 }, "go on"))).toMatchObject({
      pane: 0,
      delivery: "message",
      queued: false,
    });
    expect(inputs).toEqual([{ kind: "prompt", text: "go on", session: "thread" }]);
    session.status = () => "working";
    expect(await execute(r, ctx, message({ headless: 4 }, "then"))).toMatchObject({ queued: true });
    session.exited = true;
    await expect(execute(r, ctx, message({ headless: 4 }, "x"))).rejects.toThrow("HeadlessExited");
    await expect(execute(r, ctx, message({ headless: 5 }, "x"))).rejects.toThrow("NoHeadlessSession");
  } finally {
    r.sessions = [];
    r.destroy();
  }
});
test("a message needs text and a live agent, still there once its channel answers", async () => {
  const { r, id, pane, pending } = setup(),
    send = (target: number) => ({ "pane.send": { target, text: "x", enter: true } }),
    channel = spyOn(adapter("claude").message!, "channel").mockImplementation(async () => async () => {
      pane.dormant = true;
      throw Error("MessageUnavailable");
    });
  try {
    for (const text of ["", " \n\t"])
      await expect(execute(r, ctx, message({ pane: id }, text))).rejects.toThrow("InvalidMessage");
    await expect(execute(r, ctx, message({ pane: id + 1 }, "x"))).rejects.toThrow("NoPane");
    // A pane without an agent is a shell, which would run the message.
    await expect(execute(r, ctx, message({ pane: id }, "x"))).rejects.toThrow("NoAgent");
    pane.agent().provider = "claude";
    pane.agent().session = new Text("a-session");
    await expect(execute(r, ctx, message({ pane: id }, "x"))).rejects.toThrow("PaneAsleep");
    await expect(execute(r, ctx, send(id))).rejects.toThrow("PaneAsleep");
    pane.dormant = false;
    pane.terminal.exited = true;
    await expect(execute(r, ctx, message({ pane: id }, "x"))).rejects.toThrow("PaneExited");
    await expect(execute(r, ctx, send(id))).rejects.toThrow("PaneExited");
    expect(pending()).toBe("");
  } finally {
    channel.mockRestore();
    r.destroy();
  }
});
test("a paste can't be ended early by its text", async () => {
  const terminal = new Terminal(80, 24);
  try {
    terminal.feed("\x1b[?2004h");
    expect(agentMessage.paste(terminal, "a\x1b[201~y\r\x1b[20\x1b[201~1~b")).toBe("\x1b[200~ay\rb\x1b[201~");
  } finally {
    terminal.destroy();
  }
});
test("automated submissions use the agent's current keyboard protocol", async () => {
  const terminal = new Terminal(80, 24);
  try {
    for (const [mode, expected] of [
      ["", "\r"],
      ["\x1b[>9u", "\x1b[13u"],
      ["\x1b[<u", "\r"],
    ]) {
      terminal.feed(mode);
      expect(agentMessage.enter(terminal)).toBe(expected);
    }
  } finally {
    terminal.destroy();
  }
});
