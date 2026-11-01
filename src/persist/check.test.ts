import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as check from "./check";
import * as cp from "./checkpoint";
import * as json from "../json";
import { Runtime, Pane } from "../runtime";
import { Terminal } from "../pane/terminal";
import { Workspace } from "../workspace";
import { Session } from "../headless";
import { Claude } from "../providers/claude/headless";
import { Stdio } from "../providers/stdio";

function saved() {
  using r = new Runtime();
  const ws = new Workspace(1, "/home/someone/secret-project");
  r.workspaces.items.push(ws);
  r.workspaces.next_id = 2;
  const pane = new Pane(ws.model.newTab(""), Terminal.create(20, 4), "/home/someone/secret-project");
  pane.terminal.exited = true;
  pane.attachment.select(r.conversations.get("codex", "0199a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b"));
  r.panes.push(pane);
  r.workspaces.next_pane_id = ws.model.next_id;
  return json.parse(json.stringify(cp.capture(r, false)));
}
const write = (state: unknown) => {
  const path = join(mkdtempSync(join(tmpdir(), "corgi-check-")), "recovery.json");
  writeFileSync(path, json.stringify(state));
  return path;
};
test("a checkpoint the release loads passes, even with a pane bound to a forgotten conversation", async () => {
  const state = saved();
  state.conversations = [];
  expect(await check.run(write(state), "/tmp/unused.sock", "/tmp/corgi")).toEqual({ ok: true });
});
test("a checkpoint the release turns down names the check, without paths or sessions", async () => {
  const state = saved();
  state.next_workspace = 1;
  const result = await check.run(write(state), "/tmp/unused.sock", "/tmp/corgi");
  if (result.ok) throw Error("expected a failure");
  expect(result.error).toBe("InvalidCheckpoint");
  expect(result.why).toBe("workspace 1 isn't between 1 and next_workspace 1");
  expect(result.state.summary).toBe(
    "cold checkpoint v7: 1 workspace, 1 pane, 0 closed tabs, 0 native sessions, 1 conversation (codex 1)",
  );
  expect(result.state.items).toEqual([
    "pane 1: codex, shows conversation 1, has shown 1, can resume 1",
    "known conversation ids: {1: codex}",
  ]);
  expect(result.state.repairs).toEqual([]);
  const all = JSON.stringify(result);
  expect(all).not.toContain("someone");
  expect(all).not.toContain("0199a2b3");
});
test("nothing saved passes", async () => {
  expect(await check.run("/nonexistent/recovery.json", "/tmp/unused.sock", "/tmp/corgi")).toEqual({ ok: true });
});
test("the anonymized state keeps shape, numbers and the schema's own values, and nothing else a user wrote", () => {
  const state = saved();
  state.workspaces[0].name = "acme-merger";
  state.panes[0].label = "lawyers";
  state.panes[0].binding.provisional.recent = "the merger closes friday";
  state.panes[0].binding.provisional.state = "working";
  state.breadcrumbs = [{ at: state.saved_at * 1000 - 5200, kind: "bound", pane: 1, session: 0, actors: [1] }];
  const out = check.describe(state).anonymized;
  for (const secret of ["acme", "lawyers", "merger", "someone", "secret-project", "0199a2b3"])
    expect(out).not.toContain(secret);
  const back = json.parse(out);
  expect(back.workspaces[0].name).toBe("<text 1, 11 chars>");
  expect(back.panes[0].binding.provisional.state).toBe("working");
  expect(back.panes[0].binding.actor).toBe(state.panes[0].binding.actor);
  expect(back.conversations[0].agent.provider).toBe("codex");
  // The same private value gets the same stand-in wherever it appears.
  expect(back.panes[0].resume_hint.session).toBe("<session 1>");
  expect(back.conversations[0].agent.session).toBe("<session 1>");
  expect(back.panes[0].cwd).toBe(back.workspaces[0].cwd);
  // Times read as seconds before the save; defaults and settings are left out.
  expect(back.breadcrumbs[0].at).toBe(-5.2);
  expect(back.saved_at).toBeUndefined();
  expect(back.agent_commands).toBeUndefined();
  expect(back.panes[0].dormant).toBeUndefined();
});
test.each([false, true])("provider payloads are private in reports, live=%s", live => {
  using r = new Runtime();
  const client = new Claude(new Stdio(), null, true),
    session = new Session(1, "claude", "/tmp", client);
  client.inputs.set("private-request", { customer_account: 123456789, acme_merger: true });
  session.events.push({ seq: 7n, event: { kind: "message", session: "private-session", text: "private-message" } });
  r.sessions.push(session);
  const out = check.describe(cp.capture(r, live)).anonymized;
  for (const secret of ["customer_account", "123456789", "acme_merger", "private-"]) expect(out).not.toContain(secret);
  const back = json.parse(out).sessions[0];
  expect(back.id).toBe(1);
  expect(back.provider).toBe("claude");
  expect(back.client.state).toMatch(/^<payload \d+>$/);
  expect(back.events[0].seq).toBe(7);
  expect(back.events[0].event).toMatch(/^<payload \d+>$/);
});
