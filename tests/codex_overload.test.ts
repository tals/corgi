//! Real Codex on a fake model that is at capacity a few times before it
//! answers: Corgi starts the failed turn again until it gets through.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Runtime } from "./runtime";
import { registerCase, run, shellJoin } from "./support";
import { delays_ms } from "../src/agent_retry";

const codex = process.env.CODEX_TEST_BIN || Bun.which("codex") || "codex";
const prompt = "Say the magic words";
const answer = "TEST: PASS";
const capacity = "Selected model is at capacity";
/** Turns the model fails before it answers. */
const failures = 3;
const encoder = new TextEncoder();
type Event = { type: string; [field: string]: unknown };
/** A Responses API stream of `events`. */
function stream(events: Event[]) {
  const body = events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(encoder.encode(body), { headers: { "Content-Type": "text/event-stream" } });
}
function reply(id: string, text: string) {
  const item = { type: "message", role: "assistant", id: "m" + id, content: [{ type: "output_text", text }] };
  return stream([
    { type: "response.created", response: { id } },
    { type: "response.output_item.added", item: { ...item, content: [] } },
    { type: "response.output_text.delta", delta: text },
    { type: "response.output_item.done", item },
    { type: "response.completed", response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ]);
}
class Overload extends Runtime {
  model!: ReturnType<typeof Bun.serve>;
  /** The prompt's turns the model failed, and those it answered. */
  overloaded = 0;
  answered = 0;
  work = "";
  async configure() {
    this.model = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async req => {
        if (!new URL(req.url).pathname.endsWith("/responses")) return Response.json({ data: [] });
        const input = JSON.stringify((await req.json()).input ?? []),
          id = "r" + (this.overloaded + this.answered);
        // Codex also asks the model to title the thread.
        if (!input.includes(prompt) || input.includes("task title")) return reply(id + "-other", "Magic words");
        if (this.overloaded === failures) {
          this.answered++;
          return reply(id, answer);
        }
        this.overloaded++;
        return stream([
          { type: "response.created", response: { id } },
          { type: "response.failed", response: { id, error: { code: "server_is_overloaded", message: "overloaded" } } },
        ]);
      },
    });
    this.work = join(this.temp.name, "work");
    mkdirSync(this.work);
    mkdirSync(this.env.CODEX_HOME!, { recursive: true });
    writeFileSync(
      join(this.env.CODEX_HOME!, "config.toml"),
      [
        'model = "gpt-5.4"',
        'model_provider = "fixture"',
        "check_for_update_on_startup = false",
        // Nothing else reaches the network: its plugins sync from GitHub.
        "[features]",
        "plugins = false",
        "apps = false",
        "[tui]",
        'terminal_title = ["app-name", "thread-id", "activity", "project"]',
        "[model_providers.fixture]",
        'name = "fixture"',
        `base_url = "${this.model.url}v1"`,
        'wire_api = "responses"',
        `[projects."${this.work}"]`,
        'trust_level = "trusted"',
        "",
      ].join("\n"),
    );
  }
  async tearDown() {
    // The pane's Codex started its shared server, which outlives it.
    if (this.env)
      try {
        await run([codex, "app-server", "daemon", "stop"], { env: this.env, cwd: this.temp.name, check: false });
      } finally {
        Bun.spawnSync(["pkill", "-f", join(this.env.CODEX_HOME!, "packages")]);
      }
    try {
      await super.tearDown();
    } finally {
      this.model?.stop(true);
    }
  }
  async screen(pane: number) {
    return (await this.command("pane.read", { target: pane, view: "screen" })).text as string;
  }
  async history(pane: number) {
    return (await this.command("pane.read", { target: pane, view: "history", lines: 400 })).text as string;
  }
  agent(pane: number) {
    return this.panes().then(panes => panes.find((p: any) => p.id === pane));
  }
  /** Codex in a focused pane, its first turn failed and waiting on Corgi's retry. */
  async failed() {
    const pane = (await this.open_pane({ cwd: this.work })).pane;
    await this.command("pane.input", { target: pane, data: shellJoin([codex]) + "\r" });
    // Corgi's hooks are new to this Codex home: trust them, as one would.
    await this.until(async () => {
      const shown = await this.screen(pane);
      if (shown.includes("› 1. Review hooks")) await this.command("pane.input", { target: pane, data: "2" });
      else if (shown.includes("› 2. Trust all")) await this.command("pane.input", { target: pane, data: "\r" });
      // Its footer offers its agents only on the shared server.
      return shown.includes("for agents");
    }, 30);
    await this.command("pane.send", { target: pane, text: prompt, enter: true });
    await this.until(async () => (await this.history(pane)).includes(capacity), 20);
    // Codex leaves the turn failed: one attempt, until Corgi's wait is over.
    // Meanwhile the agent counts as at work, waiting on its retry.
    await this.until(async () => (await this.agent(pane)).retry_at > 0, 10);
    await this.frame_with("Retrying in");
    this.assertEqual((await this.agent(pane)).state, "working");
    this.assertNotEqual((await this.agent(pane)).observation.outcome, "failed");
    this.assertEqual(this.overloaded, 1);
    this.assertEqual(this.answered, 0);
    return pane;
  }
  async test_codex_turn_failed_at_capacity_is_retried_until_it_passes() {
    const pane = await this.failed();
    await this.untilAdvancing(15, async () => (await this.history(pane)).includes(answer), 60);
    this.assertEqual(this.overloaded, failures);
    this.assertEqual(this.answered, 1);
    await this.until(async () => (await this.agent(pane)).state === "idle" && (await this.agent(pane)).retry_at === 0);
    this.assertEqual((await this.agent(pane)).observation.outcome, "completed");
    const shown = await this.history(pane);
    this.assertEqual(shown.split(capacity).length - 1, failures);
    this.assertEqual(shown.split(prompt).length - 1, 1);
  }
  async test_escape_in_the_pane_calls_off_the_retry() {
    const pane = await this.failed();
    // Esc as a terminal speaking the Kitty keyboard protocol sends it.
    await this.client!.input("\x1b[27u");
    await this.until(async () => (await this.agent(pane)).state === "idle");
    this.assertEqual((await this.agent(pane)).retry_at, 0);
    this.assertEqual((await this.agent(pane)).observation.outcome, "failed");
    await this.advance(delays_ms[0] / 1000 + 30);
    this.assertEqual(this.overloaded, 1);
    // Codex never saw the key: its composer is as it was.
    this.assertNotIn("Esc again", await this.screen(pane));
  }
}
registerCase("CodexOverload", Overload, { timeout: 180_000 });
