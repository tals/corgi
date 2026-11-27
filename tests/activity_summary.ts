/** Read-only provider observation to replaceable inference and activity timeline. */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Titles, A } from "./codex_titles";
import { Runtime } from "./runtime";
import { sleep, tempDir } from "./support";

export const inferenceProgram = join(import.meta.dir, "inference_harness.ts");
export const lines = (path: string) =>
  existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean) : [];
export const now = () => new Date().toISOString();
export class Summaries extends Titles {
  legacy_summaries = true;
  backend_dir!: ReturnType<typeof tempDir>;
  log!: string;
  control!: string;
  transcript!: string;
  tool_index = 0;
  async configure() {
    if (this.legacy_summaries) this.env.CORGI_TEST_LEGACY_SUMMARIES = "1";
    this.env.CORGI_INFERENCE_PROVIDER = "codex";
    this.env.CORGI_INFERENCE_BIN = inferenceProgram;
    this.env.CORGI_INFERENCE_TEST_LOG = this.log;
    this.env.CORGI_INFERENCE_TEST_CONTROL = this.control;
  }
  async setUp() {
    this.backend_dir = tempDir("corgi-summary-");
    this.log = join(this.backend_dir.name, "calls.jsonl");
    this.control = join(this.backend_dir.name, "control.json");
    writeFileSync(this.control, JSON.stringify({ delay: 0, label: "Tracing pane focus" }));
    this.transcript = join(this.backend_dir.name, "activity.jsonl");
    writeFileSync(this.transcript, JSON.stringify({ type: "session_meta", payload: { id: A } }) + "\n");
    this.tool_index = 0;
    await super.setUp();
    this.paths[A] = this.transcript;
    await sleep(0.8);
  }
  async tearDown() {
    try {
      await super.tearDown();
    } finally {
      this.backend_dir?.cleanup();
    }
  }
  async start_turn(tid = "active", wave = true) {
    this.items[A] = [
      {
        type: "userMessage",
        content: [{ type: "text", text: "Fix terminal focus" }],
      },
      { type: "agentMessage", text: "I am tracing pane focus changes." },
    ];
    this.states[A] = "active";
    this.turns[A] = [tid, "inProgress"];
    this.append_record("event_msg", { type: "task_started", turn_id: tid });
    await this.until(async () => (await this.state()).state === "working");
    if (wave) this.tools(3);
  }
  append_record(type: string, payload: any) {
    appendFileSync(this.transcript, JSON.stringify({ type, timestamp: now(), payload }) + "\n");
  }
  tools(n: number, command = "rg focus src", complete = true) {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = "call-" + ++this.tool_index;
      ids.push(id);
      this.append_record("response_item", {
        type: "function_call",
        call_id: id,
        name: "exec_command",
        arguments: JSON.stringify({ cmd: command }),
      });
      if (complete) this.finish_tool(id);
    }
    return ids;
  }
  finish_tool(id: string) {
    this.append_record("response_item", {
      type: "function_call_output",
      call_id: id,
      output: "result",
    });
  }
  calls() {
    return lines(this.log);
  }
  summary_logs() {
    const path = join(this.temp.name, "server.log"),
      text = existsSync(path) ? readFileSync(path, "utf8") : "";
    // The daemon may be mid-way through writing the last line.
    return text
      .slice(0, text.lastIndexOf("\n") + 1)
      .split("\n")
      .filter(line => line.startsWith("info(activity_summary): "))
      .map(line => JSON.parse(line.slice("info(activity_summary): ".length)));
  }
}
export class PiSummaries extends Runtime {
  backend_dir!: ReturnType<typeof tempDir>;
  log!: string;
  control!: string;
  transcript!: string;
  pane!: number;
  seq = 0;
  async configure() {
    this.env.CORGI_TEST_LEGACY_SUMMARIES = "1";
    this.env.CORGI_INFERENCE_PROVIDER = "codex";
    this.env.CORGI_INFERENCE_BIN = inferenceProgram;
    this.env.CORGI_INFERENCE_TEST_LOG = this.log;
    this.env.CORGI_INFERENCE_TEST_CONTROL = this.control;
  }
  async setUp() {
    this.backend_dir = tempDir("corgi-pi-summary-");
    this.log = join(this.backend_dir.name, "calls.jsonl");
    this.control = join(this.backend_dir.name, "control.json");
    this.transcript = join(this.backend_dir.name, "pi.jsonl");
    writeFileSync(this.control, JSON.stringify({ label: "Investigating parser behavior" }));
    writeFileSync(this.transcript, JSON.stringify({ type: "session", id: "pi-s" }) + "\n");
    await super.setUp();
    this.pane = (await this.command("pane.create", { workspace: 1, command: "sleep 60" })).pane;
  }
  async tearDown() {
    try {
      await super.tearDown();
    } finally {
      this.backend_dir?.cleanup();
    }
  }
  async hook(event: string, turn: string, extra: object = {}) {
    return this.rpc({
      op: "hook",
      provider: "pi",
      pane: this.pane,
      seq: ++this.seq,
      event: { event, session: "pi-s", turn, transcript: this.transcript, ...extra },
    });
  }
  record(id: string, content: object[]) {
    appendFileSync(
      this.transcript,
      JSON.stringify({ type: "message", id, timestamp: now(), message: { role: "assistant", content } }) + "\n",
    );
  }
  async agent() {
    return (await this.session()).panes.find((p: any) => p.id === this.pane).agent;
  }
  async test_pi_conversation_names_follow_opening_and_user_rename() {
    writeFileSync(this.control, JSON.stringify({ name: "Pi parser fixes" }));
    appendFileSync(
      this.transcript,
      JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "Fix Pi parser failures" }] },
      }) + "\n",
    );
    await this.hook("SessionStart", "");
    await this.until(async () => (await this.agent()).name === "Pi parser fixes");
    this.assertEqual(JSON.parse(lines(this.log)[0]).initial_request, "Fix Pi parser failures");
    appendFileSync(this.transcript, JSON.stringify({ type: "session_info", name: "My own /name" }) + "\n");
    await this.settle();
    await this.until(async () => (await this.agent()).name === "My own /name");
    await this.advance(65);
    this.assertEqual((await this.agent()).name, "My own /name");
    this.assertEqual(lines(this.log).length, 1);
  }
  async test_pi_existing_name_never_requests_automatic_naming() {
    appendFileSync(
      this.transcript,
      [
        { type: "session_info", name: "Already named" },
        { type: "message", message: { role: "user", content: "Fix Pi parser failures" } },
      ]
        .map(v => JSON.stringify(v))
        .join("\n") + "\n",
    );
    await this.hook("SessionStart", "");
    await this.settle();
    await this.until(async () => (await this.agent()).name === "Already named");
    await this.advance(65);
    this.assertEqual(lines(this.log).length, 0);
  }
  async test_pi_hooks_do_not_block_summaries_or_the_next_turn_timeline() {
    await this.hook("SessionStart", "");
    await this.settle();
    await this.hook("UserPromptSubmit", "turn-1");
    await this.settle();
    this.record("m1", [
      { type: "text", text: "Tracing how the parser reads model names." },
      { type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/providers/model.ts" } },
    ]);
    await this.hook("PreToolUse", "turn-1", { tool: "read", input: { path: "src/providers/model.ts" } });
    await this.until(async () => (await this.agent()).activity === "Investigating parser behavior");
    this.assertIn("Latest agent update: Tracing how the parser", JSON.parse(lines(this.log)[0]).evidence);
    await this.hook("Stop", "turn-1", { outcome: "completed" });
    await this.settle();
    this.assertEqual((await this.agent()).state, "idle");

    writeFileSync(this.control, JSON.stringify({ label: "Running parser tests" }));
    await this.advance(1.1);
    await this.hook("UserPromptSubmit", "turn-2");
    await this.settle();
    this.record("m2", [
      { type: "toolCall", id: "bash-2", name: "bash", arguments: { command: "bun test src/providers/model.test.ts" } },
    ]);
    await this.hook("PreToolUse", "turn-2", {
      tool: "bash",
      input: { command: "bun test src/providers/model.test.ts" },
    });
    await this.until(async () => (await this.agent()).activity === "Running parser tests");
    const input = JSON.parse(lines(this.log).at(-1)!);
    this.assertEqual(input.provider, "pi");
    this.assertIn("Currently running tools", input.evidence);
    this.assertIn("bun test src/providers/model.test.ts", input.evidence);
    this.assertNotIn("Latest agent update", input.evidence);
    const conversation = (await this.session()).conversations.find((c: any) => c.agent.session === "pi-s");
    this.assertEqual(
      conversation.timeline.points.map((p: any) => p.activity),
      ["Investigating parser behavior", "Running parser tests"],
    );
    await this.settle();
    const calls = lines(this.log).length;
    await this.advance(9);
    this.assertEqual(lines(this.log).length, calls);
  }
}
export class ClaudeSummaries extends Runtime {
  backend_dir!: ReturnType<typeof tempDir>;
  log!: string;
  control!: string;
  transcript!: string;
  pane!: number;
  seq = 0;
  async configure() {
    this.env.CORGI_TEST_LEGACY_SUMMARIES = "1";
    this.env.CORGI_INFERENCE_PROVIDER = "codex";
    this.env.CORGI_INFERENCE_BIN = inferenceProgram;
    this.env.CORGI_INFERENCE_TEST_LOG = this.log;
    this.env.CORGI_INFERENCE_TEST_CONTROL = this.control;
  }
  async setUp() {
    this.backend_dir = tempDir("corgi-summary-");
    this.log = join(this.backend_dir.name, "calls.jsonl");
    this.control = join(this.backend_dir.name, "control.json");
    writeFileSync(this.control, JSON.stringify({ delay: 0, label: "Tracing hook routing" }));
    await super.setUp();
    this.pane = (await this.command("pane.create", { workspace: 1, command: "sleep 60" })).pane;
    this.transcript = join(this.backend_dir.name, "claude.jsonl");
    writeFileSync(this.transcript, "");
    this.seq = Date.now() * 1000;
  }
  async tearDown() {
    try {
      await super.tearDown();
    } finally {
      this.backend_dir?.cleanup();
    }
  }
  async hook(event: string, extra: any = {}) {
    this.seq = Math.max(this.seq + 1, Date.now() * 1000);
    return this.rpc({
      op: "hook",
      pane: this.pane,
      provider: "claude",
      seq: this.seq,
      event: {
        hook_event_name: event,
        session_id: "claude-s",
        prompt_id: "prompt-1",
        transcript_path: this.transcript,
        ...extra,
      },
    });
  }
  record(fields: any) {
    appendFileSync(this.transcript, JSON.stringify({ sessionId: "claude-s", timestamp: now(), ...fields }) + "\n");
  }
  async agent() {
    return (await this.session()).panes.find((p: any) => p.id === this.pane).agent;
  }
  async conversation() {
    return (await this.session()).conversations.find((c: any) => c.agent.session === "claude-s");
  }
  async test_displayed_thinking_refreshes_activity_after_abstention() {
    writeFileSync(this.control, JSON.stringify({ delay: 0, label: null }));
    await this.hook("SessionStart");
    await this.advance(0.6);
    await this.hook("UserPromptSubmit");
    this.record({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "artifact", name: "Artifact", input: { action: "quickstart", intent: "other" } },
        ],
      },
    });
    this.record({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "artifact", content: "Page guidance" }] },
    });
    await this.until(() => lines(this.log).length > 0);
    await this.settle();
    this.assertEqual((await this.agent()).activity, "");

    writeFileSync(this.control, JSON.stringify({ delay: 0, label: "Building launcher prototype" }));
    await this.advance(8.5);
    const update = "Building an interactive prototype of Corgi's launcher on a character grid.";
    this.record({
      type: "assistant",
      thinkingDisplay: "updates",
      message: { content: [{ type: "thinking", thinking: update }] },
    });
    await this.until(async () => (await this.agent()).activity === "Building launcher prototype");
    const evidence = JSON.parse(lines(this.log).at(-1)!).evidence;
    this.assertIn("Latest agent update: " + update, evidence);
    this.assertIn("Artifact: quickstart other", evidence);
    this.assertEqual((await this.agent()).state, "working");
    this.assertEqual(
      (await this.conversation()).timeline.points.map((p: any) => p.activity),
      ["Building launcher prototype"],
    );
  }
  async test_running_command_alone_gets_summary_without_completion_or_commentary() {
    writeFileSync(this.control, JSON.stringify({ delay: 0, label: "Running smoke tests" }));
    await this.hook("SessionStart");
    await sleep(0.6);
    await this.hook("UserPromptSubmit");
    await this.hook("PreToolUse", {
      tool_name: "Bash",
      tool_input: { command: "bun test tests/smoke.test.ts" },
    });
    this.record({
      type: "assistant",
      message: {
        id: "m1",
        content: [
          {
            type: "tool_use",
            id: "smoke",
            name: "Bash",
            input: { command: "bun test tests/smoke.test.ts" },
          },
        ],
      },
    });
    await this.until(async () => (await this.agent()).activity === "Running smoke tests");
    this.assertEqual(lines(this.log).length, 1);
    this.assertIn("Currently running tools", JSON.parse(lines(this.log)[0]).evidence);
    await this.advance(8.5);
    this.assertEqual(lines(this.log).length, 1);
  }
  async test_claude_labels_timeline_and_cached_usage_match_codex() {
    await this.hook("SessionStart");
    await sleep(0.6);
    await this.hook("UserPromptSubmit");
    await this.hook("PreToolUse", {
      tool_name: "Read",
      tool_input: { file_path: "/repo/src/server.zig" },
    });
    this.assertEqual((await this.agent()).activity, "Reading server.zig");
    this.record({
      type: "assistant",
      message: {
        id: "m1",
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 50,
          output_tokens: 40,
        },
        content: [
          { type: "text", text: "Tracing how hooks reach panes" },
          {
            type: "tool_use",
            id: "t1",
            name: "Bash",
            input: {
              command: "rg routeHook",
              description: "Find hook routing",
            },
          },
        ],
      },
    });
    await this.until(async () => (await this.agent()).activity === "Tracing hook routing");
    this.record({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
      },
    });
    await this.advance(8);
    await this.until(() => JSON.parse(lines(this.log).at(-1)!).evidence.includes("Find hook routing"));
    const call = JSON.parse(lines(this.log).at(-1)!);
    this.assertIn("Tracing how hooks reach panes", JSON.stringify(call));
    this.assertIn("Find hook routing", JSON.stringify(call));
    await this.hook("PreToolUse", {
      tool_name: "Read",
      tool_input: { file_path: "/repo/src/agents.zig" },
    });
    this.assertEqual((await this.agent()).activity, "Tracing hook routing");
    const conversation = await this.conversation();
    this.assertEqual(conversation.usage.tokens, {
      input: 1050,
      cached_input: 900,
      output: 40,
    });
    this.assertEqual(
      conversation.timeline.points.map((p: any) => p.activity),
      ["Tracing hook routing"],
    );
    await this.hook("Stop");
    this.record({ type: "system", subtype: "turn_duration" });
    await this.until(async () => (await this.agent()).state === "idle");
  }
  async test_claude_label_survives_text_written_during_inference() {
    writeFileSync(this.control, JSON.stringify({ delay: 1.5, label: "Tracing hook routing" }));
    await this.hook("SessionStart");
    await sleep(0.6);
    await this.hook("UserPromptSubmit");
    this.record({
      type: "assistant",
      message: {
        id: "m1",
        content: [{ type: "text", text: "Tracing how hooks reach panes" }],
      },
    });
    await this.until(() => existsSync(this.log));
    this.record({
      type: "assistant",
      message: {
        id: "m2",
        content: [{ type: "text", text: "Checking the attachment router next" }],
      },
    });
    await this.until(async () => (await this.agent()).activity === "Tracing hook routing", 6);
    this.assertEqual(
      (await this.conversation()).timeline.points.map((p: any) => p.activity),
      ["Tracing hook routing"],
    );
  }
}
