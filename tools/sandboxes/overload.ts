/**
 * The overload sandbox: the real Codex on a fake model that is at capacity a
 * few times before it answers, to watch Corgi start the failed turn again.
 *
 * - codex: the Codex TUI. Send it any prompt.
 * - model: the fake Responses API, logging each turn it fails or answers.
 *   `fails` in the sandbox folder says how many turns in a row it fails.
 * - server: Codex's app server for this world's Codex home, in the
 *   foreground, so it stops with the sandbox and nothing is installed.
 *
 * Needs Codex installed.
 */
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { table, type World } from "../sandbox";

/** The fake model: fails `fails` prompt turns in a row as overloaded, then answers one. */
const model = String.raw`
import { readFileSync } from "node:fs";
const fails = () => Number(readFileSync(new URL("fails", import.meta.url), "utf8")) || 0;
let failed = 0;
const stream = events => new Response(events.map(e => "event: " + e.type + "\ndata: " + JSON.stringify(e) + "\n\n").join(""), {
  headers: { "Content-Type": "text/event-stream" },
});
const reply = (id, text) => {
  const item = { type: "message", role: "assistant", id: "m" + id, content: [{ type: "output_text", text }] };
  return stream([
    { type: "response.created", response: { id } },
    { type: "response.output_item.added", item: { ...item, content: [] } },
    { type: "response.output_text.delta", delta: text },
    { type: "response.output_item.done", item },
    { type: "response.completed", response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ]);
};
Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.argv[2]),
  async fetch(req) {
    if (!new URL(req.url).pathname.endsWith("/responses")) return Response.json({ data: [] });
    const input = JSON.stringify((await req.json()).input ?? []), id = "r" + Date.now();
    // Codex also asks the model to title the thread.
    if (input.includes("task title")) return reply(id, "Overload demo");
    const at = new Date().toLocaleTimeString();
    if (failed < fails()) {
      console.log(at + "  turn failed: model at capacity (" + ++failed + " of " + fails() + ")");
      return stream([
        { type: "response.created", response: { id } },
        { type: "response.failed", response: { id, error: { code: "server_is_overloaded", message: "overloaded" } } },
      ]);
    }
    failed = 0;
    console.log(at + "  turn answered: TEST: PASS");
    return reply(id, "TEST: PASS");
  },
});
console.log("Fake model on port " + process.argv[2] + "; fails " + fails() + " turns in a row, then answers.");
`;

export const world: World = {
  seed(s) {
    const codex = Bun.which("codex");
    if (!codex) throw Error("the overload sandbox needs Codex installed");
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }),
      port = probe.port;
    probe.stop(true);
    const work = join(s.dir, "work");
    s.write(join(work, "README.md"), "Ask Codex anything; the model is at capacity first.\n");
    s.write(join(s.dir, "model.ts"), model);
    s.write(join(s.dir, "fails"), "3\n");
    s.write(join(s.dir, "port"), `${port}\n`);
    s.write(join(s.dir, "codex-bin"), `${codex}\n`);
    // The server runs under another name, so Corgi doesn't take it for an agent.
    symlinkSync(codex, join(s.dir, "app-server"));
    s.write(
      join(s.env.CODEX_HOME, "config.toml"),
      [
        'model = "gpt-5.4"',
        'model_provider = "fixture"',
        "check_for_update_on_startup = false",
        "[features]",
        "plugins = false",
        "apps = false",
        "hooks = false",
        "[tui]",
        'terminal_title = ["app-name", "thread-id", "activity", "project"]',
        "[model_providers.fixture]",
        'name = "fixture"',
        `base_url = "http://127.0.0.1:${port}/v1"`,
        'wire_api = "responses"',
        `[projects."${work}"]`,
        'trust_level = "trusted"',
        "",
      ].join("\n"),
    );
  },

  /** Codex first, then the model and the app server it runs on. */
  arrange(s) {
    const before: { id: number; model?: { tabs?: unknown[] } }[] = s.corgi(["workspace", "list"])?.workspaces ?? [];
    const work = join(s.dir, "work"),
      codex = `"$(cat ${JSON.stringify(join(s.dir, "codex-bin"))})"`,
      socket = '"$CODEX_HOME/app-server-control/app-server-control.sock"';
    const made: { workspace: number; tab: number } = s.corgi(["workspace", "new", "overload", "--cwd", work]);
    const tab = (name: string, command: string): { pane: number; tab: number } =>
      s.corgi([
        "tab",
        "new",
        "--workspace",
        String(made.workspace),
        "--name",
        name,
        "--cwd",
        work,
        "--command",
        command,
      ]);
    // Codex would start a server of its own without one to join.
    const tui = tab("codex", `while [ ! -S ${socket} ]; do sleep 0.2; done; exec ${codex}`);
    tab("model", `exec ${JSON.stringify(process.execPath)} ../model.ts "$(cat ../port)"`);
    tab("server", "exec ../app-server app-server --listen unix://");
    s.corgi(["tab", "close", String(made.tab)], false);
    s.corgi(["focus", String(tui.pane)], false);
    for (const w of before)
      if (w.id !== made.workspace && (w.model?.tabs?.length ?? 0) === 0)
        s.corgi(["workspace", "close", String(w.id)], false);
  },

  intro(s) {
    return [
      'Workspace "overload": tab "codex" runs the real Codex on a fake model.',
      ...table([
        ["prompt", "fails as at capacity 3 times, then answers TEST: PASS"],
        ["sidebar", "a yellow ‖ and “Retrying in …” while Corgi waits to retry"],
        ["fails", `${join(s.dir, "fails")}: turns it fails in a row, read each turn`],
        ["model", "tab model logs each turn it fails or answers"],
      ]),
    ];
  },
};
