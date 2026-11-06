import { processPath } from "../src/os";
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { Runtime, EXE, screen_text } from "./runtime";
import { Viewer } from "./viewer_client";
import { quote, registerCase, writeExecutable } from "./support";
/** OpenCode's background service, answering over HTTP and announcing each
 * change on its event stream as the real one does. */
class Service {
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
    writeFileSync(join(state, "model.json"), JSON.stringify({ recent: [{ providerID: "test", modelID: "model" }] }));
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
  slowStartup() {
    const file = join(this.env.XDG_STATE_HOME!, "opencode/service.json"),
      release = join(this.temp.name, "release-startup"),
      helper = join(this.temp.name, "startup-helper.pid"),
      ready = join(this.temp.name, "startup-ready"),
      endpoint = { url: `http://127.0.0.1:${this.service.server.port}`, password: "fixture" };
    rmSync(file);
    writeExecutable(
      this.env.CORGI_OPENCODE2_BIN!,
      `
import { existsSync, watch } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) console.log('opencode v2.1.2');
else if (args[0] === 'api') {
  await Bun.write(${JSON.stringify(helper)}, String(process.pid));
  await new Promise(resolve => {
    const ready = () => {
      if (!existsSync(${JSON.stringify(release)})) return;
      watcher.close();
      resolve();
    };
    const watcher = watch(${JSON.stringify(this.temp.name)}, ready);
    console.error('mise opencode@2.1.2 downloading');
    ready();
  });
  await Bun.write(${JSON.stringify(file)}, JSON.stringify(${JSON.stringify(endpoint)}));
} else if (args.includes('--session')) {
  await Bun.write(${JSON.stringify(ready)}, 'ready');
  setInterval(() => {}, 60000);
}
`,
    );
    writeFileSync(this.path + ".viewer.json", JSON.stringify({ onboarding_complete: true }));
    return { release, helper, ready };
  }
  async test_startup_wait_is_shared_and_can_finish_after_installation() {
    const files = this.slowStartup();
    await this.command("agent.create", { workspace: 1, provider: "opencode2", account: "" });
    await this.until(async () => (await this.session()).startup_waits?.[0]?.phase === "installing");
    const first = await Viewer.create(this, 120, 30),
      second = await Viewer.create(this, 120, 30);
    for (const view of [first, second]) {
      await view.action("startup-waits");
      const text = screen_text((await view.poll()).data, 120, 30).join("\n");
      this.assertIn("Installing OpenCode", text);
      this.assertIn("mise opencode@2.1.2 downloading", text);
    }
    writeFileSync(files.release, "go");
    await this.until(() => existsSync(files.ready));
    await this.until(async () => (await this.session()).startup_waits.length === 0);
    this.assertIn("Nothing is waiting", screen_text((await second.poll()).data, 120, 30).join("\n"));
  }
  async test_startup_kill_from_another_viewer_stops_the_helper() {
    const files = this.slowStartup();
    await this.command("agent.create", { workspace: 1, provider: "opencode2", account: "" });
    await this.until(async () => (await this.session()).startup_waits?.[0]?.phase === "installing");
    const helper = Number(await Bun.file(files.helper).text()),
      view = await Viewer.create(this, 120, 30);
    await view.action("startup-waits");
    await view.input("x");
    await this.until(async () => (await this.session()).startup_waits.length === 0);
    await this.until(() => processPath(helper) === null);
    this.assertFalse(existsSync(files.ready));
  }
  async test_closing_a_pane_stops_its_startup_helper() {
    const files = this.slowStartup();
    const { pane } = await this.command("agent.create", { workspace: 1, provider: "opencode2", account: "" });
    await this.until(() => existsSync(files.helper));
    const helper = Number(await Bun.file(files.helper).text());
    await this.command("pane.close", { target: pane });
    await this.until(() => processPath(helper) === null);
    await this.until(async () => (await this.session()).startup_waits.length === 0);
  }
  async test_mise_after_exec_is_reported_and_can_be_killed() {
    // A real executable named mise remains in the pane, as an installing shim does.
    const mise = join(this.temp.name, "mise");
    copyFileSync("/bin/sleep", mise);
    const command = `/bin/bash -c ${quote(`exec -a pi ${quote(mise)} 60`)}`;
    const { pane } = await this.command("pane.create", { workspace: 1, command });
    await this.until(async () => (await this.session()).startup_waits?.some((w: any) => w.pane === pane));
    const wait = (await this.session()).startup_waits.find((w: any) => w.pane === pane);
    this.assertEqual(wait.phase, "agent");
    this.assertEqual(wait.provider, "pi");
    await this.rpc({ op: "startup.kill", id: wait.id });
    await this.until(async () => !(await this.session()).startup_waits.some((w: any) => w.id === wait.id));
  }
  async test_manager_keeps_configured_opencode_visible_without_account_creation() {
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
