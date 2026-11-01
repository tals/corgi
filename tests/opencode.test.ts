import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { Runtime, EXE, screen_text } from "./runtime";
import { Viewer } from "./viewer_client";
import { quote, registerCase, writeExecutable } from "./support";
/** OpenCode's background service, answering over HTTP and announcing each
 * change on its event stream as the real one does. */
class Service {
  credential = "work";
  turn = 0;
  text = "";
  done = false;
  interrupted = false;
  answered = false;
  compacting = false;
  streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  server = Bun.serve({ port: 0, fetch: request => this.answer(request) });
  constructor(readonly root: string) {}
  get finished() {
    return this.done || this.interrupted || this.answered;
  }
  emit(type: string, data: Record<string, unknown> = {}) {
    const line = new TextEncoder().encode(
      `data: ${JSON.stringify({ type, data: { sessionID: "ses_fixture", ...data } })}\n\n`,
    );
    for (const stream of this.streams) stream.enqueue(line);
  }
  prompt(text: string) {
    this.turn++;
    this.text = text;
    this.answered = false;
    this.interrupted = false;
    this.emit("session.execution.started");
    if (text === "approval") this.emit("permission.asked", { id: "per_fixture" });
  }
  reply() {
    this.answered = true;
    this.emit("permission.replied", { requestID: "per_fixture" });
    this.emit("session.execution.succeeded");
  }
  finish() {
    this.done = true;
    this.emit("session.execution.succeeded");
  }
  events() {
    let controller: ReadableStreamDefaultController<Uint8Array>;
    return new Response(
      new ReadableStream<Uint8Array>({
        start: c => {
          controller = c;
          this.streams.add(c);
          c.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
        },
        cancel: () => void this.streams.delete(controller),
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  }
  async answer(request: Request) {
    if (request.headers.get("authorization") !== "Basic " + btoa("opencode:fixture"))
      return new Response("", { status: 401 });
    const url = new URL(request.url),
      path = url.pathname + url.search,
      method = request.method,
      body = request.body ? await request.json() : {},
      done = this.finished,
      info = {
        id: "ses_fixture",
        title: "Fixture",
        location: { directory: this.root },
        time: { created: 1, updated: 2 },
        tokens: {
          input: done ? 100 : 0,
          output: done ? 20 : 0,
          reasoning: done ? 3 : 0,
          cache: { read: done ? 40 : 0, write: 0 },
        },
      };
    if (path === "/api/event") return this.events();
    if (method === "POST" && path === "/api/session") {
      Object.assign(this, { turn: 0, text: "", done: false, interrupted: false, answered: false });
      return Response.json({ data: info });
    }
    if (path.startsWith("/api/session?")) return Response.json({ data: [] });
    if (path === "/api/session/active")
      return Response.json({ data: this.turn && !done ? { ses_fixture: { type: "running" } } : {} });
    if (path === "/api/session/ses_fixture") return Response.json({ data: info });
    if (path.endsWith("/prompt")) {
      this.prompt(body.text);
      return Response.json({ data: { id: "msg_u" + this.turn } });
    }
    if (path.includes("/interrupt")) {
      this.interrupted = true;
      this.emit("session.execution.interrupted");
      return Response.json({ interrupted: true });
    }
    if (path.endsWith("/permission/per_fixture/reply")) {
      this.reply();
      return new Response("");
    }
    if (path.endsWith("/permission"))
      return Response.json({
        data:
          this.text === "approval" && !done
            ? [{ id: "per_fixture", sessionID: "ses_fixture", action: "shell", resources: ["echo fixture"] }]
            : [],
      });
    if (path.endsWith("/form")) return Response.json({ data: [] });
    if (path.endsWith("/context"))
      return Response.json({
        data: this.turn
          ? [
              { id: "msg_u" + this.turn, type: "user", text: this.text },
              {
                id: "msg_a" + this.turn,
                type: "assistant",
                time: done ? { completed: 2 } : {},
                content: [{ type: "tool", id: "tool" + this.turn, time: done ? { completed: 2 } : {} }].concat(
                  done ? [{ type: "text", text: "Finished" } as any] : [],
                ),
              },
              ...(this.compacting
                ? [
                    {
                      id: "msg_c" + this.turn,
                      type: "compaction",
                      status: done ? "completed" : "running",
                      reason: "manual",
                      summary: "",
                    },
                  ]
                : []),
              ...(done
                ? [{ id: "msg_i" + this.turn, type: "idle", outcome: this.interrupted ? "interrupted" : "succeeded" }]
                : []),
            ]
          : [],
      });
    if (path.startsWith("/api/model/default")) return Response.json({ data: { providerID: "test", id: "model" } });
    if (path.startsWith("/api/provider?")) return Response.json({ data: [{ id: "test", integrationID: "fixture" }] });
    if (path === "/api/credential")
      return Response.json({
        data: [
          { id: "unrelated", integrationID: "other", active: true, label: "Other" },
          {
            id: this.credential,
            integrationID: "fixture",
            active: true,
            label: this.credential,
            value: { access: "secret-token" },
          },
        ],
      });
    return new Response("", { status: 404 });
  }
  stop() {
    this.server.stop(true);
  }
}
class OpenCode extends Runtime {
  service!: Service;
  async configure() {
    delete this.env.OPENCODE_CLI_CONFIG_CONTENT;
    this.service = new Service(this.temp.name);
    const state = join(this.env.XDG_STATE_HOME!, "opencode");
    mkdirSync(state, { recursive: true });
    writeFileSync(
      join(state, "service.json"),
      JSON.stringify({ url: `http://127.0.0.1:${this.service.server.port}`, password: "fixture" }),
    );
    // The CLI: its terminal UI waits on a session; `api` finds the service running.
    this.env.CORGI_OPENCODE2_BIN = writeExecutable(
      join(this.temp.name, "opencode"),
      `
const args=process.argv.slice(2);
if(args.includes('--version'))console.log('opencode v2.1.2');
else if(args.includes('--session')){
  await Bun.write(${JSON.stringify(join(this.temp.name, "cli-config.json"))},process.env.OPENCODE_CLI_CONFIG_CONTENT ?? '{}');
  setInterval(()=>{},60000);
}
else console.log('{}');
`,
    );
  }
  async tearDown() {
    try {
      await super.tearDown();
    } finally {
      this.service?.stop();
    }
  }
  async headless() {
    const result = await this.rpc({ op: "headless.list" });
    return result.sessions[0];
  }
  async test_native_headless_account_tracks_opencode_switches() {
    await this.create("wait");
    const identity = async () => (await this.session()).headless_sessions[0]?.agent.account;
    await this.until(async () => (await identity())?.id === '["opencode2","work"]');
    this.service.credential = "personal";
    this.service.emit("credential.switched");
    await this.until(async () => (await identity())?.id === '["opencode2","personal"]');
    this.assertEqual(await identity(), { id: '["opencode2","personal"]', name: "personal", directory: null });
  }
  async test_native_pane_account_tracks_opencode_switches() {
    await this.command("agent.create", { workspace: 1, provider: "opencode2", account: "" });
    const identity = async () =>
      (await this.session()).panes.find((p: any) => p.agent.provider === "opencode2")?.agent.account;
    await this.until(async () => (await identity())?.id === '["opencode2","work"]');
    this.service.credential = "personal";
    this.service.emit("credential.switched");
    await this.until(async () => (await identity())?.id === '["opencode2","personal"]');
    this.assertEqual(await identity(), { id: '["opencode2","personal"]', name: "personal", directory: null });
  }
  async test_manager_keeps_opencode_visible_without_account_creation() {
    writeFileSync(this.path + ".viewer.json", JSON.stringify({ onboarding_complete: true }));
    const workspace = (await this.session()).workspaces[0].id,
      view = await Viewer.create(this, 180, 40);
    await view.input("\x02A");
    await this.until(async () => (await view.poll()).data.includes("OpenCode"));
    const rows = screen_text((await view.poll()).data, 180, 40),
      y = rows.findIndex(row => row.includes("Manage agents")),
      x = rows[y].indexOf("Manage agents");
    await view.input(`\x1b[<0;${x + 1};${y + 1}M\x1b[<0;${x + 1};${y + 1}m`);
    await view.advance(0.3);
    await this.until(async () => (await view.poll()).data.includes("Add agent"));
    const managed = screen_text((await view.poll()).data, 180, 40).join("\n");
    this.assertIn("OpenCode", managed);
    this.assertFalse(managed.split("\n").some(row => row.includes("New ") && row.includes("OpenCode")));
    await this.command("agent.workspace_visibility", { workspace, row: "opencode2", shown: false });
    await view.input("\x1b[D");
    await view.advance(0.3);
    await this.until(async () => !(await view.poll()).data.includes("OpenCode"));
    await this.command("agent.workspace_visibility", { workspace, row: "opencode2", shown: true });
    await this.until(async () => (await view.poll()).data.includes("OpenCode"));
  }
  async create(prompt: string) {
    const result = await this.rpc({
      op: "headless.start",
      provider: "opencode2",
      prompt,
      workspace: 1,
      cwd: this.temp.name,
    });
    await this.until(async () => (await this.headless())?.ready === true);
    return result.session;
  }
  async test_active_session_survives_reload_without_replaying_prompt() {
    const session = await this.create("wait");
    await this.until(async () => (await this.headless()).active_tools === 1);
    const before = await this.headless();
    await this.rpc({ op: "server.reload", executable: EXE });
    this.assertEqual((await this.headless()).pid, before.pid);
    this.service.finish();
    await this.until(async () => (await this.headless()).state === "idle");
    const events = (await this.rpc({ op: "headless.events", provider: "opencode2", session, after: 0 })).events.map(
      (e: any) => e.event,
    );
    this.assertEqual(events.filter((e: any) => e.kind === "turn" && e.phase === "started").length, 1);
    this.assertEqual(events.filter((e: any) => e.kind === "turn" && e.phase === "ended").length, 1);
    const usage = events.findLast((e: any) => e.kind === "usage");
    this.assertEqual(usage.total.total.input, 140);
    this.assertEqual(usage.total.total.output, 23);
    this.assertEqual((await this.headless()).active_tools, 0);
  }
  async test_approval_round_trip_and_interrupt() {
    const session = await this.create("approval");
    await this.until(async () => (await this.headless()).state === "blocked");
    const pending = await this.rpc({ op: "headless.events", provider: "opencode2", session, after: 0 });
    this.assertEqual(pending.pending_requests[0].id, "per_fixture");
    await this.rpc({
      op: "headless.send",
      provider: "opencode2",
      session,
      input: { kind: "answer", request: "per_fixture", allow: true },
    });
    await this.until(async () => (await this.headless()).state === "idle");
    await this.rpc({
      op: "headless.send",
      provider: "opencode2",
      session,
      input: { kind: "prompt", text: "wait" },
    });
    await this.until(async () => (await this.headless()).state === "working");
    await this.rpc({ op: "headless.send", provider: "opencode2", session, input: { kind: "interrupt" } });
    await this.until(async () => (await this.headless()).state === "idle");
    const events = (await this.rpc({ op: "headless.events", provider: "opencode2", session, after: 0 })).events;
    this.assertTrue(events.some((e: any) => e.event.kind === "turn" && e.event.outcome === "interrupted"));
  }
  async test_terminal_pane_leaves_needs_input_once_the_prompt_is_answered() {
    const pane = (await this.command("pane.create", { workspace: 1, command: `${quote(EXE)} agent opencode2` })).pane,
      shown = async () => (await this.panes()).find((p: any) => p.id === pane);
    await this.until(async () => (await shown())?.session === "ses_fixture", 10);
    await this.until(() => this.service.streams.size > 0);
    this.service.prompt("approval");
    await this.until(async () => (await shown())?.state === "blocked");
    // Answered in OpenCode's UI: only the event stream says so before the sweep.
    this.service.reply();
    await this.until(async () => (await shown())?.state === "idle");
  }
  async test_terminal_compaction_is_observed_until_execution_finishes() {
    const pane = (await this.command("pane.create", { workspace: 1, command: `${quote(EXE)} agent opencode2` })).pane,
      shown = async () => (await this.panes()).find((p: any) => p.id === pane);
    await this.until(async () => (await shown())?.session === "ses_fixture", 10);
    await this.until(() => this.service.streams.size > 0);
    this.service.compacting = true;
    this.service.prompt("compact");
    await this.until(async () => (await shown())?.compacting === true);
    this.service.finish();
    await this.until(async () => (await shown())?.state === "idle" && (await shown())?.compacting === false);
  }
  async test_launcher_hides_opencode_tabs_and_details_sidebar() {
    await this.command("agent.create", { workspace: 1, provider: "opencode2", account: "" });
    const config = join(this.temp.name, "cli-config.json");
    await this.until(() => existsSync(config));
    this.assertEqual(await Bun.file(config).json(), { session: { sidebar: "hide" }, tabs: { mode: "off" } });
  }
}
registerCase("OpenCode", OpenCode);
