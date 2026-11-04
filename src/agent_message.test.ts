import { test, expect, spyOn } from "bun:test";
import { Runtime, Pane } from "./runtime";
import { Workspace } from "./workspace";
import { Terminal } from "./pane/terminal";
import { execute } from "./session";
import { Text, adapter } from "./providers";
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
test("a message goes through the agent's own channel when it has one", async () => {
  const { r, id, pane, pending } = setup(),
    sent: string[] = [],
    message = spyOn(adapter("claude"), "message").mockImplementation(async () => async text => void sent.push(text));
  try {
    pane.agent().provider = "claude";
    pane.agent().session = new Text("a-session");
    const result = await execute(r, ctx, { "agent.message": { target: { pane: id }, text: "review this" } });
    expect(result).toMatchObject({ pane: id, workspace: 1, delivery: "message", queued: false });
    expect(message.mock.calls[0][0]).toBe("a-session");
    expect(sent).toEqual(["review this"]);
    expect(pending()).toBe("");
    pane.agent().state = "working";
    expect(await execute(r, ctx, { "agent.message": { target: { pane: id }, text: "and this" } })).toMatchObject({
      delivery: "message",
      queued: true,
    });
    expect(sent).toEqual(["review this", "and this"]);
  } finally {
    message.mockRestore();
    r.destroy();
  }
});
test("without a channel a message is typed and submitted", async () => {
  const { r, id, pane, pending } = setup(),
    message = spyOn(adapter("claude"), "message").mockResolvedValue(null);
  try {
    expect(await execute(r, ctx, { "agent.message": { target: { pane: id }, text: "ls" } })).toMatchObject({
      delivery: "typed",
      queued: false,
    });
    expect(pending()).toBe("ls\r");
    expect(message).not.toHaveBeenCalled();
    pane.agent().provider = "claude";
    pane.agent().session = new Text("a-session");
    pane.agent().state = "blocked";
    pane.terminal.feed("\x1b[?2004h");
    expect(await execute(r, ctx, { "agent.message": { target: { pane: id }, text: "hi" } })).toMatchObject({
      delivery: "typed",
      queued: true,
    });
    expect(message).toHaveBeenCalled();
    expect(pending()).toBe("\x1b[200~hi\x1b[201~\r");
  } finally {
    message.mockRestore();
    r.destroy();
  }
});
test("a headless agent gets a message as a prompt to its conversation", async () => {
  const { r } = setup(),
    inputs: unknown[] = [];
  let status = "idle";
  r.sessions.push({
    id: 4,
    session: "thread",
    status: () => status,
    send: (input: unknown) => inputs.push(input),
  } as unknown as Session);
  try {
    expect(await execute(r, ctx, { "agent.message": { target: { headless: 4 }, text: "go on" } })).toMatchObject({
      pane: 0,
      delivery: "message",
      queued: false,
    });
    expect(inputs).toEqual([{ kind: "prompt", text: "go on", session: "thread" }]);
    status = "working";
    expect(await execute(r, ctx, { "agent.message": { target: { headless: 4 }, text: "then" } })).toMatchObject({
      queued: true,
    });
    await expect(execute(r, ctx, { "agent.message": { target: { headless: 5 }, text: "x" } })).rejects.toThrow(
      "NoHeadlessSession",
    );
  } finally {
    r.sessions = [];
    r.destroy();
  }
});
test("a message needs text and a live target", async () => {
  const { r, id } = setup();
  try {
    await expect(execute(r, ctx, { "agent.message": { target: { pane: id }, text: "" } })).rejects.toThrow(
      "InvalidMessage",
    );
    await expect(execute(r, ctx, { "agent.message": { target: { pane: id + 1 }, text: "x" } })).rejects.toThrow(
      "NoPane",
    );
  } finally {
    r.destroy();
  }
});
