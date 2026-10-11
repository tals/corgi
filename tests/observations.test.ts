import { appendFileSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Runtime } from "./runtime";
import { Viewer } from "./viewer_client";
import { EXE, registerCase, sleep, shellJoin } from "./support";

import { CodexObserver, write_codex_terminal } from "./provider_sim";
const SESSION = "01901234-1234-1234-1234-123456789abc";

class Observations extends Runtime {
  pane!: number;
  log!: string;
  seq = 0;
  turn = 0;
  async setUp() {
    await super.setUp();
    const terminal = write_codex_terminal(join(this.temp.name, "codex"), SESSION);
    this.pane = (await this.command("pane.create", { workspace: 1, command: shellJoin([terminal]) })).pane;
    this.log = join(this.temp.name, "transcript.jsonl");
    writeFileSync(this.log, JSON.stringify({ type: "session_meta", payload: { id: SESSION } }) + "\n");
    this.seq = Math.floor(Date.now() * 1000);
    this.turn = 0;
    const observer = new CodexObserver(this.env.CODEX_HOME!, [SESSION]);
    try {
      await this.until(async () => (await this.state()).agent.session === SESSION);
    } finally {
      await observer.close();
    }
    await this.advance(5);
    await this.hook("SessionStart", "codex", { turn_id: "" });
  }
  async hook(event: string, provider = "codex", extra: Record<string, any> = {}, pane = this.pane) {
    this.seq = Math.max(this.seq + 1, Math.floor(Date.now() * 1000));
    return this.rpc({
      op: "hook",
      pane,
      provider,
      seq: this.seq,
      event: {
        hook_event_name: event,
        session_id: SESSION,
        ...(provider === "codex" ? { turn_id: String(this.turn) } : {}),
        transcript_path: this.log,
        ...extra,
      },
    });
  }
  async state() {
    return (await this.panes()).find((p: any) => p.id === this.pane);
  }
  append(
    kind = "task_complete",
    turn: number | string | null = null,
    partial = false,
    extra: Record<string, any> = {},
  ) {
    appendFileSync(
      this.log,
      JSON.stringify({
        type: "event_msg",
        timestamp: new Date().toISOString(),
        payload: { type: kind, turn_id: String(turn ?? this.turn), ...extra },
      }) + (partial ? "" : "\n"),
    );
  }
  async finish() {
    this.turn++;
    await this.hook("UserPromptSubmit");
    await this.hook("Stop");
    this.append();
    await this.until(async () => (await this.state()).completed === this.turn);
  }
  /** Settles after a write to a transcript the daemon may already have read. */
  async settleTranscript() {
    // A tail re-reads its transcript at most every 250 ms of real time, and a
    // settle pass skips a tail inside that wait.
    await sleep(0.3);
    await this.settle();
  }

  async test_provisional_stop_partial_record_and_unread_survives_new_work() {
    this.turn = 1;
    await this.hook("UserPromptSubmit");
    await this.hook("Stop");
    await this.settle();
    this.assertEqual([(await this.state()).state, (await this.state()).unread], ["working", false]);
    this.append("task_complete", "old");
    await this.settleTranscript();
    this.assertFalse((await this.state()).unread);
    this.append("task_complete", null, true);
    await this.settleTranscript();
    this.assertFalse((await this.state()).unread);
    appendFileSync(this.log, "\n");
    await this.until(async () => (await this.state()).unread);
    this.assertEqual((await this.state()).state, "idle");
    this.turn++;
    await this.hook("UserPromptSubmit");
    await this.hook("PreToolUse", "codex", { tool_name: "Bash" });
    this.assertTrue((await this.state()).unread);
    this.assertEqual((await this.state()).activity, "");
    await this.hook("PostToolUse", "codex", { tool_name: "Bash" });
    this.assertEqual((await this.state()).recent_activity, "used: Bash");
  }
  async test_duplicate_stop_does_not_revive_finished_or_replace_newer_turn() {
    await this.finish();
    await this.hook("Stop");
    await this.settle();
    this.assertEqual([(await this.state()).state, (await this.state()).completed], ["idle", 1]);
    this.turn = 2;
    await this.hook("UserPromptSubmit");
    await this.hook("Stop", "codex", { turn_id: "1" });
    await this.settle();
    this.assertEqual((await this.state()).state, "working");
    this.assertFalse((await this.state()).pending_stop);
    this.assertEqual((await this.state()).completed, 1);
  }
  async test_interrupt_retains_unread_outcome_without_stop() {
    this.turn = 1;
    await this.hook("UserPromptSubmit");
    await this.hook("Interrupt");
    this.assertTrue((await this.state()).unread);
    const agent = (await this.session()).panes.find((p: any) => p.id === this.pane).agent;
    this.assertEqual(agent.observation.outcome, "interrupted");
    this.assertEqual(agent.state, "idle");
    await this.hook("Interrupt");
    this.assertEqual((await this.state()).completed, 1);
  }
  async test_automatic_permission_review_does_not_request_human_input() {
    await this.hook("UserPromptSubmit");
    await this.hook("PreToolUse", "codex", { tool_name: "Bash" });
    await this.hook("PermissionRequest", "codex", { tool_name: "Bash" });
    await this.settle();
    this.assertEqual([(await this.state()).state, (await this.state()).attention], ["working", "none"]);
    await this.hook("PostToolUse", "codex", { tool_name: "Bash" });
    this.assertEqual([(await this.state()).state, (await this.state()).attention], ["working", "none"]);
  }
  async test_codex_hooks_follow_their_session_not_the_sending_pane() {
    // Codex's shared app-server daemon sends every thread's hooks with the
    // pane of whichever Codex started it.
    const other = (await this.command("pane.create", { workspace: 1, command: "/bin/sh" })).pane;
    await this.hook("UserPromptSubmit", "codex", {}, other);
    await this.hook("PreCompact", "codex", {}, other);
    this.assertEqual([(await this.state()).state, (await this.state()).compacting], ["working", true]);
  }
  async test_read_receipt_does_not_clear_a_newer_permission_prompt() {
    await this.finish();
    const stamp = (await this.session()).panes.find((p: any) => p.id === this.pane).agent.changed_at;
    this.turn = 2;
    await this.hook("UserPromptSubmit");
    await this.hook("PreToolUse", "codex", { tool_name: "request_user_input" });
    await this.rpc({
      op: "pane.acknowledge",
      protocol: 1,
      pane: this.pane,
      session: SESSION,
      through: 1,
      attention_at: stamp,
    });
    this.assertFalse((await this.state()).unread);
    this.assertEqual((await this.state()).attention, "needs_input");
  }
  async test_old_receipt_and_wrong_session_do_not_read_new_completion() {
    await this.finish();
    const old = (await this.state()).completed;
    await this.finish();
    await this.rpc({
      op: "pane.acknowledge",
      protocol: 1,
      pane: this.pane,
      session: SESSION,
      through: old,
    });
    this.assertTrue((await this.state()).unread);
    const result = await this.raw_rpc({
      op: "pane.acknowledge",
      protocol: 1,
      pane: this.pane,
      session: "wrong",
      through: 2,
    });
    this.assertEqual(result.err, "StaleAcknowledgement");
    this.assertTrue((await this.state()).unread);
    await this.rpc({
      op: "pane.acknowledge",
      protocol: 1,
      pane: this.pane,
      session: SESSION,
      through: 2,
    });
    this.assertFalse((await this.state()).unread);
  }
  async test_mark_unread_brings_back_the_last_completion() {
    const mark = (session: string) => this.raw_rpc({ op: "pane.mark_unread", protocol: 1, pane: this.pane, session });
    await mark(SESSION);
    this.assertFalse((await this.state()).unread);
    await this.finish();
    await this.rpc({ op: "pane.acknowledge", protocol: 1, pane: this.pane, session: SESSION, through: 1 });
    this.assertEqual((await mark("wrong")).err, "StaleAcknowledgement");
    this.assertFalse((await this.state()).unread);
    await mark(SESSION);
    this.assertEqual([(await this.state()).unread, (await this.state()).attention], [true, "finished"]);
    await this.rpc({ op: "pane.acknowledge", protocol: 1, pane: this.pane, session: SESSION, through: 1 });
    this.assertFalse((await this.state()).unread);
  }
  async test_active_viewer_visits_read_background_viewer_does_not() {
    const other = (await this.command("pane.create", { workspace: 1, command: "sleep 60" })).pane;
    const v = await Viewer.create(this);
    await v.focus(other);
    await this.finish();
    await v.poll();
    this.assertTrue((await this.state()).unread);
    await v.input("\x1b[O");
    await v.focus(this.pane);
    this.assertTrue((await this.state()).unread);
    await v.input("\x1b[I");
    await this.until(async () => !(await this.state()).unread);
  }
  async test_continuation_cancels_pending_and_reload_does_not_replay() {
    this.turn = 1;
    await this.hook("UserPromptSubmit");
    await this.hook("Stop");
    await this.hook("PreToolUse", "codex", { tool_name: "Bash" });
    this.append();
    await this.settleTranscript();
    this.assertFalse((await this.state()).unread);
    await this.hook("Stop");
    this.append();
    await this.until(async () => (await this.state()).unread);
    await this.rpc({ op: "server.reload", protocol: 1, executable: EXE });
    this.assertEqual((await this.state()).completed, 1);
    await this.settle();
    this.assertEqual((await this.state()).completed, 1);
  }
  async test_bad_identity_symlink_and_oversized_record() {
    this.turn = 1;
    await this.hook("UserPromptSubmit");
    writeFileSync(this.log, JSON.stringify({ type: "session_meta", payload: { id: "other" } }) + "\n");
    await this.hook("Stop");
    this.append();
    await this.settleTranscript();
    this.assertFalse((await this.state()).unread);
    await this.hook("UserPromptSubmit");
    const target = join(this.temp.name, "transcript.actual");
    renameSync(this.log, target);
    symlinkSync(target, this.log);
    await this.hook("Stop");
    await this.settle();
    this.assertFalse((await this.state()).unread);
    unlinkSync(this.log);
    renameSync(target, this.log);
    await this.hook("UserPromptSubmit");
    writeFileSync(
      this.log,
      JSON.stringify({ type: "session_meta", payload: { id: SESSION } }) + "\n" + "x".repeat(300000) + "\n",
    );
    await this.hook("Stop");
    this.append();
    await this.until(async () => (await this.state()).unread);
  }
  async test_unread_survives_cold_recovery_and_pending_stop_survives_reload() {
    this.turn = 1;
    await this.hook("UserPromptSubmit");
    await this.hook("Stop");
    await this.rpc({ op: "server.reload", protocol: 1, executable: EXE });
    this.append();
    await this.until(async () => (await this.state()).unread);
    await this.run_cli("checkpoint");
    await this.run_cli("shutdown");
    await this.run_cli("start");
    this.assertTrue((await this.state()).unread);
    this.assertEqual((await this.state()).state, "unknown");
    this.assertEqual((await this.state()).completed, 1);
    const v = await Viewer.create(this);
    await v.focus(this.pane);
    await this.until(async () => !(await this.state()).unread);
  }
  async test_native_completion_is_correlated_and_unread_survives_next_turn() {
    const ident = (
      await this.rpc({
        op: "native.start",
        provider: "codex",
        cwd: this.temp.name,
      })
    ).session;
    const snapshot = async () => (await this.session()).native_sessions[0];
    await this.until(async () => (await snapshot()).ready);
    const event = (method: string, turn: string, status?: string) =>
      this.rpc({
        op: "native.send",
        session: ident,
        message: {
          method: "test/event",
          params: {
            method,
            params: {
              threadId: "thread",
              turn: { id: turn, ...(status ? { status } : {}) },
            },
          },
        },
      });
    await event("turn/started", "one");
    await this.until(async () => (await snapshot()).state === "working");
    await event("turn/completed", "one", "completed");
    await this.until(async () => (await snapshot()).observation.completed === 1);
    await event("turn/started", "two");
    await this.until(async () => (await snapshot()).state === "working");
    this.assertEqual((await snapshot()).observation.read, 0);
    const seq = async () => (await this.rpc({ op: "native.events", session: ident })).next_seq;
    const before = await seq();
    await event("turn/completed", "one", "completed");
    // The stale completion goes through the provider process, not a worker.
    await this.until(async () => (await seq()) > before);
    this.assertEqual((await snapshot()).state, "working");
    await this.rpc({ op: "server.reload", protocol: 1, executable: EXE });
    await event("turn/completed", "two", "interrupted");
    await this.until(async () => (await snapshot()).state === "idle");
    this.assertEqual((await snapshot()).observation.outcome, "interrupted");
    this.assertEqual((await snapshot()).observation.completed, 2);
  }
  async test_claude_uses_fresh_post_turn_record_not_assistant_or_stop_summary() {
    // A pane keeps one conversation actor; use a fresh pane for Claude after
    // setUp registered the first pane as Codex.
    this.pane = (await this.command("pane.create", { workspace: 1, command: "sleep 60" })).pane;
    await this.hook("UserPromptSubmit", "claude");
    await this.hook("Stop", "claude");
    const write = (kind: string, subtype: string) =>
      appendFileSync(
        this.log,
        JSON.stringify({
          type: kind,
          subtype,
          sessionId: SESSION,
          timestamp: new Date().toISOString(),
        }) + "\n",
      );
    write("assistant", "end_turn");
    write("system", "stop_hook_summary");
    await this.settleTranscript();
    this.assertFalse((await this.state()).unread);
    write("system", "turn_duration");
    await this.until(async () => (await this.state()).unread);
    await this.hook("Stop", "claude");
    await this.settle();
    this.assertEqual([(await this.state()).state, (await this.state()).completed], ["idle", 1]);
    await this.rpc({ op: "server.reload", protocol: 1, executable: EXE });
    await this.hook("Stop", "claude");
    await this.settle();
    this.assertEqual([(await this.state()).state, (await this.state()).completed], ["idle", 1]);
    await this.hook("UserPromptSubmit", "claude");
    await this.hook("Stop", "claude");
    write("system", "turn_duration");
    await this.until(async () => (await this.state()).completed === 2);
  }
  async test_claude_works_on_while_its_stop_lists_running_subagents() {
    this.pane = (await this.command("pane.create", { workspace: 1, command: "sleep 60" })).pane;
    const lane = (id: string, description: string) => ({
      id,
      type: "subagent",
      status: "running",
      description,
      agent_type: "general-purpose",
    });
    const stop = (...lanes: any[]) => this.hook("Stop", "claude", { background_tasks: lanes });
    const parent = async () => {
      const snapshot = await this.session();
      const id = snapshot.panes.find((p: any) => p.id === this.pane).agent.conversation;
      const conversations = snapshot.conversations;
      return {
        ...conversations.find((c: any) => c.id === id),
        children: Object.fromEntries(
          conversations.filter((c: any) => c.parent === id).map((c: any) => [c.agent.activity, c.agent.state]),
        ),
      };
    };
    const turnEnded = () =>
      appendFileSync(
        this.log,
        JSON.stringify({
          type: "system",
          subtype: "turn_duration",
          sessionId: SESSION,
          timestamp: new Date().toISOString(),
        }) + "\n",
      );
    const launch = (id: string, description: string) =>
      this.hook("PostToolUse", "claude", {
        tool_name: "Agent",
        tool_input: { description, subagent_type: "general-purpose" },
        tool_response: { status: "async_launched", agentId: id },
      });
    await this.hook("UserPromptSubmit", "claude");
    await launch("a1", "Lane A");
    await launch("a2", "Lane B");
    // Lane A writes its own transcript, beside the session's.
    const lanes = join(this.temp.name, SESSION, "subagents");
    mkdirSync(lanes, { recursive: true });
    writeFileSync(
      join(lanes, "agent-a1.jsonl"),
      JSON.stringify({
        type: "assistant",
        sessionId: SESSION,
        isSidechain: true,
        agentId: "a1",
        timestamp: new Date().toISOString(),
        message: {
          id: "m1",
          model: "claude-haiku-4-5-20251001",
          usage: { input_tokens: 40, output_tokens: 2 },
        },
      }) + "\n",
    );
    await this.until(async () => {
      const snapshot = await this.session();
      const lane = snapshot.conversations.find((c: any) => c.agent.activity === "Lane A");
      return lane?.usage.tokens.input === 40;
    });
    // Each counts from its launch, while the turn that launched it runs.
    let seen = await parent();
    this.assertEqual(seen.agent.state, "working");
    this.assertEqual(seen.agent.subagents, {
      running: 2,
      blocked: 0,
      waiting: false,
    });
    this.assertEqual(seen.children, {
      "Lane A": "working",
      "Lane B": "working",
    });
    await stop(lane("a1", "Lane A"), lane("a2", "Lane B"));
    turnEnded();
    await this.settleTranscript();
    seen = await parent();
    this.assertEqual(seen.agent.state, "working");
    this.assertEqual(seen.agent.subagents, {
      running: 2,
      blocked: 0,
      waiting: true,
    });
    this.assertEqual(seen.children, {
      "Lane A": "working",
      "Lane B": "working",
    });
    this.assertEqual((await this.state()).completed, 0);
    // The list holds across a reload; nothing re-reads it.
    await this.rpc({ op: "server.reload", protocol: 1, executable: EXE });
    await this.settle();
    seen = await parent();
    this.assertEqual(seen.agent.subagents, {
      running: 2,
      blocked: 0,
      waiting: true,
    });
    this.assertTrue(seen.children_observed_at > 0);
    await stop(lane("a2", "Lane B"));
    seen = await parent();
    this.assertEqual(seen.agent.subagents, {
      running: 1,
      blocked: 0,
      waiting: true,
    });
    this.assertEqual(seen.children, { "Lane A": "idle", "Lane B": "working" });
    await stop();
    turnEnded();
    await this.until(async () => (await this.state()).completed === 1);
    seen = await parent();
    this.assertEqual(seen.agent.state, "idle");
    this.assertEqual(seen.children, { "Lane A": "idle", "Lane B": "idle" });
  }
  async test_claude_pauses_while_its_monitor_or_wakeup_can_wake_it() {
    this.pane = (await this.command("pane.create", { workspace: 1, command: "sleep 60" })).pane;
    // A stand-in for the Claude process that sends the hooks.
    const script = join(this.temp.name, "claude");
    writeFileSync(script, "#!/bin/sh\nwhile :; do sleep 0.2; done\n", {
      mode: 0o755,
    });
    const claude = Bun.spawn([script], { stdout: "ignore", stderr: "ignore" });
    try {
      const hook = (event: string, extra: Record<string, any> = {}) => {
        this.seq = Math.max(this.seq + 1, Math.floor(Date.now() * 1000));
        return this.rpc({
          op: "hook",
          pane: this.pane,
          provider: "claude",
          seq: this.seq,
          pid: claude.pid,
          event: {
            hook_event_name: event,
            session_id: SESSION,
            transcript_path: this.log,
            ...extra,
          },
        });
      };
      const record = (type: string, extra: Record<string, any> = {}) =>
        appendFileSync(
          this.log,
          JSON.stringify({
            type,
            sessionId: SESSION,
            timestamp: new Date().toISOString(),
            ...extra,
          }) + "\n",
        );
      let turns = 0;
      const turn = async (stop: Record<string, any>) => {
        await hook("UserPromptSubmit");
        await hook("Stop", stop);
        record("system", { subtype: "turn_duration" });
        turns++;
        await this.until(async () => (await this.state()).completed === turns);
      };
      const wakeup = {
        background_tasks: [],
        session_crons: [{ id: "c1", schedule: "0 9 * * *", recurring: false, prompt: "go" }],
      };
      const notice = (id: string, status: string) =>
        record("queue-operation", {
          operation: "enqueue",
          content: `<task-notification>\n<task-id>${id}</task-id>\n<status>${status}</status>\n<summary>Task "probe" was stopped by the user</summary>\n</task-notification>`,
        });
      await hook("PostToolUse", {
        tool_name: "Monitor",
        tool_input: { command: "tail -F ci.log", description: "probe" },
        tool_response: { taskId: "m1", timeoutMs: 1800000, persistent: false },
      });
      await turn({
        background_tasks: [
          {
            id: "m1",
            type: "shell",
            status: "running",
            command: "tail -F ci.log",
          },
          {
            id: "b1",
            type: "shell",
            status: "running",
            command: "bun run dev",
          },
        ],
        session_crons: [],
      });
      const seen = await this.state();
      this.assertEqual([seen.state, seen.unread, seen.paused], ["idle", true, true]);
      // A settle checks the pause: Claude still runs, so it holds.
      await this.settle();
      this.assertTrue((await this.state()).paused);
      // Another task ending leaves it; its Monitor stopped from Claude's task
      // list, which queues a notice but wakes nothing, ends it.
      notice("b1", "completed");
      await this.settleTranscript();
      this.assertTrue((await this.state()).paused);
      notice("m1", "killed");
      await this.until(async () => {
        await this.settleTranscript();
        return !(await this.state()).paused;
      });
      this.assertEqual((await this.state()).state, "idle");
      // A wake the transcript shows ends it though no hook arrives.
      await turn(wakeup);
      this.assertTrue((await this.state()).paused);
      record("user", {
        message: { role: "user", content: "<task-notification>" },
      });
      await this.until(async () => {
        await this.settleTranscript();
        return !(await this.state()).paused;
      });
      // Claude exiting ends it.
      await turn(wakeup);
      this.assertTrue((await this.state()).paused);
      claude.kill("SIGKILL");
      await claude.exited;
      await this.until(async () => !(await this.state()).paused);
    } finally {
      claude.kill("SIGKILL");
    }
  }
}
registerCase("Observations", Observations, { inherited: false });
