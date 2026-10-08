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
  backend_dir!: ReturnType<typeof tempDir>;
  log!: string;
  control!: string;
  transcript!: string;
  tool_index = 0;
  async configure() {
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
    return lines(join(this.temp.name, "server.log"))
      .filter(line => line.startsWith("info(activity_summary): "))
      .map(line => JSON.parse(line.slice("info(activity_summary): ".length)));
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
