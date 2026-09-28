import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Runtime } from "./runtime";
import { Viewer } from "./viewer_client";
import { registerCase, shellJoin, sleep, tempDir } from "./support";
import { A, B, Titles } from "./codex_titles";
import { Summaries, inferenceProgram, lines } from "./activity_summary";
import {
  CodexObserver,
  TerminalAttachment,
  write_codex_terminal,
} from "./provider_sim";

class Files extends Runtime {
  backend_dir!: ReturnType<typeof tempDir>;
  log!: string;
  control!: string;
  sim: CodexObserver | null = null;
  attachments: TerminalAttachment[] = [];
  attachment!: TerminalAttachment;
  pane!: number;
  transcript!: string;
  index!: string;
  tool_index = 0;
  async configure() {
    Object.assign(this.env, {
      CORGI_INFERENCE_PROVIDER: "codex",
      CORGI_INFERENCE_BIN: inferenceProgram,
      CORGI_INFERENCE_TEST_LOG: this.log,
      CORGI_INFERENCE_TEST_CONTROL: this.control,
    });
  }
  async setUp() {
    this.backend_dir = tempDir("corgi-files-");
    this.log = join(this.backend_dir.name, "calls.jsonl");
    this.control = join(this.backend_dir.name, "control.json");
    writeFileSync(
      this.control,
      JSON.stringify({ label: "Tracing pane focus" }),
    );
    await super.setUp();
    this.sim = null;
    this.attachments = [];
    this.attachment = await this.create_attachment(A);
    this.pane = this.attachment.pane;
    this.transcript = join(this.backend_dir.name, "rollout.jsonl");
    writeFileSync(
      this.transcript,
      JSON.stringify({ type: "session_meta", payload: { id: A } }) + "\n",
    );
    this.index = join(this.env.CODEX_HOME!, "session_index.jsonl");
    mkdirSync(dirname(this.index), { recursive: true });
    this.rename("Investigate missing session details");
    this.tool_index = 0;
    await this.hook("SessionStart");
    await this.until(
      async () =>
        (await this.state()).name === "Investigate missing session details",
    );
  }
  async tearDown() {
    if (this.sim) await this.sim.close();
    try {
      await super.tearDown();
    } finally {
      this.backend_dir?.cleanup();
    }
  }
  async create_attachment(session: string) {
    return Titles.prototype.create_attachment.call(this, session);
  }
  append_record(type: string, payload: any) {
    return Summaries.prototype.append_record.call(this, type, payload);
  }
  tools(n: number, command = "rg focus src", complete = true) {
    return Summaries.prototype.tools.call(this, n, command, complete);
  }
  finish_tool(id: string) {
    return Summaries.prototype.finish_tool.call(this, id);
  }
  calls() {
    return lines(this.log);
  }
  async state() {
    const pane = (await this.panes()).find((p: any) => p.id === this.pane);
    return { ...pane, name: pane.agent.name };
  }
  rename(name: string, session = A) {
    appendFileSync(
      this.index,
      JSON.stringify({ id: session, thread_name: name }) + "\n",
    );
  }
  hook(event: string, turn = "current", session = A) {
    return this.rpc({
      op: "hook",
      pane: this.pane,
      provider: "codex",
      seq: Math.floor(performance.timeOrigin * 1000 + performance.now() * 1000),
      event: {
        hook_event_name: event,
        session_id: session,
        turn_id: turn,
        transcript_path: this.transcript,
      },
    });
  }
  async start() {
    await this.hook("UserPromptSubmit");
    this.append_record("event_msg", {
      type: "task_started",
      turn_id: "current",
    });
    this.append_record("response_item", {
      type: "message",
      role: "assistant",
      phase: "commentary",
      content: [
        { type: "output_text", text: "Tracing focus from the transcript." },
      ],
    });
    this.tools(3);
    await this.until(
      async () => (await this.state()).activity === "Tracing pane focus",
    );
  }
  async test_no_socket_name_summary_rename_and_completion() {
    this.assertFalse(
      existsSync(
        join(
          this.env.CODEX_HOME!,
          "app-server-control/app-server-control.sock",
        ),
      ),
    );
    await this.start();
    this.assertIn(
      "Tracing focus from the transcript",
      JSON.parse(this.calls()[0]).evidence,
    );
    this.assertIn("rg focus src", JSON.parse(this.calls()[0]).evidence);
    this.rename("Renamed session");
    await this.until(
      async () => (await this.state()).name === "Renamed session",
    );
    this.assertEqual((await this.state()).completed, 0);
    await this.hook("Stop");
    this.append_record("event_msg", {
      type: "task_complete",
      turn_id: "current",
    });
    await this.until(async () => (await this.state()).completed === 1);
    await this.settle();
    this.assertEqual((await this.state()).completed, 1);
  }
  async test_app_server_preferred_then_files_resume() {
    await this.start();
    this.sim = new CodexObserver(this.env.CODEX_HOME!, [A]);
    this.sim.paths[A] = this.transcript;
    this.sim.names[A] = "App server name";
    this.sim.set_turn(A, "current", "inProgress");
    await this.until(async () => (await this.state()).source === "protocol");
    await this.until(
      async () =>
        (await this.state()).name !== "Investigate missing session details",
    );
    const protocolName = (await this.state()).name;
    this.assertEqual((await this.state()).activity, "Tracing pane focus");
    this.rename("File rename while connected");
    await this.settle();
    this.assertEqual((await this.state()).name, protocolName);
    await this.sim.close();
    this.sim = null;
    await this.hook("PreToolUse");
    // Protocol metadata keeps its name for five seconds.
    await this.advance(5);
    await this.until(
      async () => (await this.state()).name === "File rename while connected",
    );
    this.assertEqual((await this.state()).activity, "Tracing pane focus");
    this.assertEqual((await this.state()).completed, 0);
  }
  async test_missing_or_wrong_transcript_still_supplies_name() {
    const replacement = this.transcript + ".replacement";
    writeFileSync(
      replacement,
      JSON.stringify({ type: "session_meta", payload: { id: B } }) + "\n",
    );
    renameSync(replacement, this.transcript);
    await this.hook("UserPromptSubmit");
    this.append_record("event_msg", {
      type: "task_started",
      turn_id: "current",
    });
    this.tools(3);
    this.rename("Metadata survives invalid transcript");
    await this.until(
      async () =>
        (await this.state()).name === "Metadata survives invalid transcript",
    );
    this.assertEqual(this.calls(), []);
    unlinkSync(this.transcript);
    this.rename("Metadata survives missing transcript");
    await this.until(
      async () =>
        (await this.state()).name === "Metadata survives missing transcript",
    );
    this.assertEqual((await this.state()).completed, 0);
  }
  async test_session_switch_keeps_names_and_evidence_separate() {
    await this.start();
    this.rename("Second conversation", B);
    await this.hook("SessionStart", "second", B);
    await this.until(async () => {
      const s = await this.state();
      return s.session === B && s.name === "Second conversation";
    });
    await this.hook("UserPromptSubmit", "second", B);
    this.tools(3);
    await this.settle();
    this.assertEqual((await this.state()).activity, "");
    this.assertEqual((await this.state()).completed, 0);
    await this.hook("SessionStart");
    await this.until(async () => (await this.state()).session === A);
    this.assertEqual(
      (await this.state()).name,
      "Investigate missing session details",
    );
    this.assertEqual((await this.state()).activity, "Tracing pane focus");
  }
  async test_exit_and_resume_restores_sidebar_name_before_any_hook() {
    await this.command("pane.close", { target: this.pane });
    this.pane = (
      await this.command("pane.create", { workspace: 1, command: "/bin/sh" })
    ).pane;
    const fake = write_codex_terminal(
      join(this.temp.name, "resume", "codex"),
      A,
    );
    const viewer = await Viewer.create(this);
    try {
      for (let i = 0; i < 2; i++) {
        await this.command("pane.input", {
          target: this.pane,
          data: shellJoin([fake, "resume", A]) + "\r",
        });
        await this.until(
          async () =>
            (await this.state()).name === "Investigate missing session details",
        );
        this.assertEqual((await this.state()).session, A);
        this.assertEqual((await this.state()).completed, 0);
        await this.until(async () =>
          (await viewer.poll()).data.includes("Investigate missing"),
        );
        await this.command("pane.input", { target: this.pane, data: "exit\r" });
        await this.until(async () => (await this.state()).session === "");
      }
    } finally {
      await viewer.close();
    }
  }
}
registerCase("Files", Files, { inherited: false });
