/** Conversation ownership through hooks, observation, and panes. */
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerCase, sleep } from "./support";
import { Runtime, EXE } from "./runtime";
import { Titles, A, B } from "./codex_titles";

const actor = async (test: any, session: string, provider = "codex") =>
  (await test.session()).conversations.find((a: any) => a.agent.provider === provider && a.agent.session === session);
const paneSnapshot = async (test: any, pane: number) => (await test.session()).panes.find((p: any) => p.id === pane);
class CodexConversations extends Titles {
  actor(session: string) {
    return actor(this, session);
  }
  pane_snapshot(pane: number) {
    return paneSnapshot(this, pane);
  }
  async finish_a() {
    this.sim.set_turn(A, "first-turn", "inProgress");
    await this.until(async () => (await this.state()).state === "working");
    this.sim.set_turn(A, "first-turn", "completed");
    await this.until(async () => (await this.state()).completed === 1);
  }
  async switch(session: string) {
    await this.attachment.select(session);
    await this.until(async () => (await this.state()).session === session);
  }
  async test_background_commands_follow_provider_inventory_and_session() {
    this.sim.background_tasks = {
      [A]: [
        { processId: "task-1", command: "bun test" },
        { processId: "task-2", command: "bun run dev" },
      ],
    };
    await this.until(async () => (await this.actor(A)).background_tasks.items.length === 2);
    let tasks = (await this.actor(A)).background_tasks;
    this.assertTrue(tasks.live);
    this.assertEqual(
      tasks.items.map((t: any) => t.group),
      ["tests", "servers"],
    );
    await this.switch(B);
    this.assertEqual((await this.actor(B)).background_tasks.items, []);
    this.sim.background_tasks[A] = [];
    await this.switch(A);
    await this.until(async () => (await this.actor(A)).background_tasks.items.length === 0);
  }
  async test_switch_preserves_each_conversations_receipts() {
    await this.finish_a();
    const first = await this.actor(A);
    this.assertGreater(first.id, 0);
    this.assertEqual(first.attachments, 1);
    await this.switch(B);
    this.assertEqual((await this.state()).completed, 0);
    this.assertFalse((await this.state()).unread);
    const retained = await this.actor(A);
    this.assertEqual(retained.id, first.id);
    this.assertEqual(retained.attachments, 0);
    this.assertEqual(retained.agent.observation.completed, 1);
    this.assertEqual(retained.agent.observation.read, 0);
    this.assertNotEqual((await this.actor(B)).id, first.id);
    await this.switch(A);
    this.assertEqual((await this.pane_snapshot(this.pane)).agent.conversation, first.id);
    this.assertEqual((await this.state()).completed, 1);
    this.assertTrue((await this.state()).unread);
  }
  async test_two_attachments_share_completion_and_acknowledgement() {
    const second = await this.create_attachment(A);
    await this.until(async () => (await second.state()).session === A);
    this.assertEqual((await this.actor(A)).attachments, 2);
    this.assertEqual(
      (await this.pane_snapshot(this.pane)).agent.conversation,
      (await this.pane_snapshot(second.pane)).agent.conversation,
    );
    await this.finish_a();
    await this.until(async () => (await second.state()).completed === 1);
    this.assertEqual((await this.actor(A)).agent.observation.completed, 1);
    this.assertTrue((await second.state()).unread);
    await this.rpc({
      op: "pane.acknowledge",
      protocol: 1,
      pane: second.pane,
      session: A,
      through: 1,
    });
    await this.until(async () => !(await this.state()).unread && !(await second.state()).unread);
    this.assertEqual((await this.actor(A)).agent.observation.read, 1);
    await this.command("pane.close", { target: second.pane });
    this.assertEqual((await this.actor(A)).attachments, 1);
    this.assertEqual((await this.state()).completed, 1);
  }
  async test_old_attachment_acknowledgement_cannot_read_another_conversation() {
    await this.finish_a();
    await this.switch(B);
    const result = await this.raw_rpc({
      op: "pane.acknowledge",
      protocol: 1,
      pane: this.pane,
      session: A,
      through: 1,
    });
    this.assertEqual(result.err, "StaleAcknowledgement");
    this.assertEqual((await this.actor(A)).agent.observation.read, 0);
    this.assertEqual((await this.actor(B)).agent.observation.completed, 0);
  }
  async test_unselected_working_conversation_can_finish_in_background() {
    this.sim.set_turn(A, "background", "inProgress");
    await this.until(async () => (await this.state()).state === "working");
    await this.switch(B);
    this.assertEqual((await this.actor(A)).attachments, 0);
    this.sim.set_turn(A, "background", "completed");
    await this.until(async () => (await this.actor(A)).agent.observation.completed === 1);
    this.assertEqual((await this.state()).session, B);
    this.assertEqual((await this.state()).completed, 0);
    this.assertEqual((await this.state()).state, "idle");
    await this.switch(A);
    this.assertTrue((await this.state()).unread);
  }
  async test_aba_selection_discards_held_old_observation() {
    this.sim.set_turn(A, "before-switch", "inProgress");
    await this.until(async () => (await this.state()).state === "working");
    const old = this.sim.hold_turn(A, "before-switch", "completed");
    try {
      await old.wait();
      this.assertEqual(old.response.result.data[0].status, "completed");
      const before = (await this.pane_snapshot(this.pane)).binding;
      await this.attachment.select(B);
      await this.until(async () => (await this.pane_snapshot(this.pane)).binding > before);
      const middle = (await this.pane_snapshot(this.pane)).binding;
      await this.attachment.select(A);
      await this.until(async () => (await this.pane_snapshot(this.pane)).binding > middle);
      this.sim.set_turn(A, "after-switch", "inProgress");
      const fresh = this.sim.hold("thread/turns/list", A);
      try {
        old.release();
        await fresh.wait();
        this.assertEqual(fresh.response.result.data[0].id, "after-switch");
        this.assertEqual((await this.actor(A)).agent.observation.completed, 0);
      } finally {
        fresh.release();
      }
      await this.until(async () => {
        const s = await this.state();
        return s.session === A && s.state === "working";
      });
      this.assertEqual((await this.state()).completed, 0);
    } finally {
      old.release();
    }
  }
  async test_reload_preserves_detached_actor_and_shared_binding() {
    await this.finish_a();
    const second = await this.create_attachment(A);
    await this.until(async () => (await second.state()).session === A);
    await this.switch(B);
    const original = Object.fromEntries(
      await Promise.all([A, B].map(async session => [session, (await this.actor(session)).id])),
    );
    await this.rpc({ op: "server.reload", protocol: 1, executable: EXE });
    this.assertEqual(
      Object.fromEntries(await Promise.all([A, B].map(async session => [session, (await this.actor(session)).id]))),
      original,
    );
    this.assertEqual((await this.state()).session, B);
    this.assertEqual((await this.state()).completed, 0);
    this.assertEqual((await second.state()).session, A);
    this.assertEqual((await second.state()).completed, 1);
    await this.rpc({
      op: "pane.acknowledge",
      protocol: 1,
      pane: second.pane,
      session: A,
      through: 1,
    });
    await this.switch(A);
    this.assertFalse((await this.state()).unread);
  }
  async test_cold_recovery_preserves_unselected_completion() {
    await this.finish_a();
    await this.switch(B);
    const actorId = (await this.actor(A)).id;
    await this.run_cli("checkpoint");
    await this.run_cli("shutdown");
    await this.until(() => !existsSync(this.path));
    await this.run_cli("start");
    const retained = await this.actor(A);
    this.assertEqual(retained.id, actorId);
    this.assertEqual(retained.agent.observation.completed, 1);
    this.assertEqual(retained.agent.observation.read, 0);
    this.assertEqual((await this.state()).session, B);
    this.assertEqual((await this.state()).completed, 0);
  }
}
class ClaudeConversations extends Runtime {
  pane!: number;
  seq = 0;
  logs: Record<string, string> = {};
  async setUp() {
    await super.setUp();
    this.pane = (await this.command("pane.create", { workspace: 1, command: "sleep 60" })).pane;
    this.seq = Date.now() * 1000;
    this.logs = {};
  }
  actor(session: string, provider = "claude") {
    return actor(this, session, provider);
  }
  pane_snapshot(pane: number) {
    return paneSnapshot(this, pane);
  }
  log(session: string) {
    if (!this.logs[session]) {
      this.logs[session] = join(this.temp.name, session + ".jsonl");
      writeFileSync(this.logs[session], "");
    }
    return this.logs[session];
  }
  hook(session: string, event: string, { pane = null, background = false, ...extra }: any = {}) {
    this.seq = Math.max(this.seq + 1, Date.now() * 1000);
    return this.rpc({
      op: "hook",
      pane: pane ?? this.pane,
      provider: "claude",
      seq: this.seq,
      background,
      event: {
        hook_event_name: event,
        session_id: session,
        transcript_path: this.log(session),
        ...extra,
      },
    });
  }
  record(session: string, fields: any) {
    appendFileSync(this.log(session), JSON.stringify({ sessionId: session, ...fields }) + "\n");
  }
  async finish(session: string) {
    await this.hook(session, "Stop");
    appendFileSync(
      this.log(session),
      JSON.stringify({
        type: "system",
        subtype: "turn_duration",
        sessionId: session,
        timestamp: new Date().toISOString(),
      }) + "\n",
    );
  }
  async test_shell_task_descriptions_are_last_reported_and_empty_census_clears() {
    await this.hook("tasks", "SessionStart");
    await this.hook("tasks", "UserPromptSubmit");
    await this.hook("tasks", "Stop", {
      background_tasks: [
        {
          id: "shell-1",
          type: "shell",
          status: "running",
          description: "Run parser tests",
          command: "bun test",
        },
        { id: "agent-1", type: "subagent", description: "Review" },
      ],
    });
    const tasks = (await this.actor("tasks")).background_tasks;
    this.assertFalse(tasks.live);
    this.assertEqual(tasks.items, [{ id: "shell-1", label: "Run parser tests", group: "tests" }]);
    await this.hook("tasks", "UserPromptSubmit");
    await this.hook("tasks", "Stop", { background_tasks: [] });
    this.assertEqual((await this.actor("tasks")).background_tasks.items, []);
  }
  async test_background_hook_updates_known_actor_without_changing_selection() {
    await this.hook("claude-a", "SessionStart");
    await this.hook("claude-a", "UserPromptSubmit");
    await this.hook("claude-b", "SessionStart");
    await this.hook("claude-b", "UserPromptSubmit");
    await this.hook("claude-b", "PermissionRequest");
    await this.finish("claude-a");
    await this.until(async () => (await this.actor("claude-a")).agent.observation.completed === 1);
    const selected = (await this.pane_snapshot(this.pane)).agent;
    this.assertEqual(selected.session, "claude-b");
    this.assertEqual(selected.state, "blocked");
    this.assertEqual(selected.attention, "needs_input");
    this.assertEqual(selected.observation.completed, 0);
    this.assertEqual((await this.actor("claude-a")).attachments, 0);
  }
  async test_transcript_titles_name_claude_conversations() {
    await this.hook("titled", "SessionStart");
    this.record("titled", { type: "ai-title", aiTitle: "Generated title" });
    await this.until(async () => (await this.pane_snapshot(this.pane)).agent.name === "Generated title");
    this.record("titled", { type: "agent-name", agentName: "Chosen name" });
    this.record("titled", {
      type: "ai-title",
      aiTitle: "Later generated title",
    });
    await this.until(async () => (await this.pane_snapshot(this.pane)).agent.name === "Chosen name");
  }
  async test_claude_activity_follows_tools_and_text_updates() {
    await this.hook("active", "SessionStart");
    await this.hook("active", "UserPromptSubmit");
    await this.hook("active", "PreToolUse", {
      tool_name: "Read",
      tool_input: { file_path: "/repo/src/server.zig" },
    });
    this.assertEqual((await this.pane_snapshot(this.pane)).agent.activity, "Reading server.zig");
    await sleep(0.01);
    this.record("active", {
      type: "assistant",
      timestamp: new Date().toISOString(),
      message: { content: [{ type: "text", text: "Tracing the hook router" }] },
    });
    await this.until(async () => (await this.pane_snapshot(this.pane)).agent.activity === "Tracing the hook router");
    await this.hook("active", "PreToolUse", {
      tool_name: "Bash",
      tool_input: { command: "zig build test", description: "Run unit tests" },
    });
    this.assertEqual((await this.pane_snapshot(this.pane)).agent.activity, "Run unit tests");
    await sleep(0.6);
    this.assertEqual((await this.pane_snapshot(this.pane)).agent.activity, "Run unit tests");
  }
  async test_background_daemon_hooks_never_select_by_inherited_pane() {
    await this.hook("foreground", "SessionStart");
    await this.hook("foreground", "UserPromptSubmit");
    await this.hook("unrelated", "SessionStart", { background: true });
    await this.hook("unrelated", "UserPromptSubmit", { background: true });
    const selected = (await this.pane_snapshot(this.pane)).agent;
    this.assertEqual(selected.session, "foreground");
    this.assertEqual(selected.state, "working");
    this.assertFalse((await this.session()).conversations.some((a: any) => a.agent.session === "unrelated"));
  }
  async test_known_conversation_reclaims_pane_after_its_selection_ended() {
    await this.hook("parent", "SessionStart");
    await this.hook("parent", "UserPromptSubmit");
    // A nested run that older hook clients let claim the pane.
    await this.hook("child", "SessionStart");
    await this.hook("child", "UserPromptSubmit");
    await this.finish("child");
    await this.hook("child", "SessionEnd");
    let selected = (await this.pane_snapshot(this.pane)).agent;
    this.assertEqual(selected.session, "child");
    this.assertEqual(selected.state, "done");
    await this.hook("parent", "UserPromptSubmit");
    selected = (await this.pane_snapshot(this.pane)).agent;
    this.assertEqual(selected.session, "parent");
    this.assertEqual(selected.state, "working");
    this.assertEqual((await this.actor("child")).attachments, 0);
  }
  async test_backgrounded_conversation_follows_its_continuation() {
    await this.hook("original", "SessionStart");
    await this.hook("original", "UserPromptSubmit");
    this.record("continued", {
      type: "ai-title",
      aiTitle: "Backgrounded work",
    });
    this.record("original", {
      type: "continued-in",
      continuedInSessionId: "continued",
    });
    await this.until(async () => (await this.pane_snapshot(this.pane)).agent.session === "continued");
    this.assertEqual((await this.pane_snapshot(this.pane)).agent.state, "working");
    await this.until(async () => (await this.pane_snapshot(this.pane)).agent.name === "Backgrounded work");
    this.assertEqual((await this.actor("original")).agent.state, "done");
    await this.hook("continued", "Notification", {
      background: true,
      notification_type: "permission_prompt",
    });
    this.assertEqual((await this.pane_snapshot(this.pane)).agent.state, "blocked");
  }
  async test_context_follows_the_latest_call_and_shares_automatic_compaction() {
    const call = (session: string, id: string, cached: number) =>
      this.record(session, {
        type: "assistant",
        timestamp: new Date().toISOString(),
        message: {
          id,
          model: "claude-opus-5-5",
          usage: {
            input_tokens: 2,
            cache_read_input_tokens: cached,
            cache_creation_input_tokens: 1000,
            output_tokens: 10,
          },
        },
      });
    await this.hook("context", "SessionStart");
    await this.hook("context", "UserPromptSubmit");
    call("context", "m1", 300000);
    await this.until(async () => (await this.actor("context"))?.context?.used === 301002);
    const first = (await this.actor("context")).context;
    this.assertEqual(first.window, 1000000);
    this.assertEqual((await this.actor("context")).model_name, "Opus 5.5");
    this.assertEqual(first.compacts_at, 0);
    this.record("context", {
      type: "system",
      subtype: "compact_boundary",
      timestamp: new Date().toISOString(),
      compactMetadata: { trigger: "auto", preTokens: 400000, postTokens: 9000 },
    });
    await this.until(async () => (await this.actor("context")).context.used === 9000);
    this.assertEqual((await this.actor("context")).context.compacts_at, 400000);
    // Another conversation on the same model measures against that point.
    call("other", "m2", 100000);
    await this.hook("other", "SessionStart");
    await this.until(async () => (await this.actor("other"))?.context?.compacts_at === 400000);
    this.assertEqual((await this.actor("other")).context.used, 101002);
  }
  async test_second_attachment_does_not_reset_existing_conversation() {
    await this.hook("shared-claude", "SessionStart");
    await this.hook("shared-claude", "UserPromptSubmit");
    await this.finish("shared-claude");
    await this.until(async () => (await this.actor("shared-claude")).agent.observation.completed === 1);
    const second = (await this.command("pane.create", { workspace: 1, command: "sleep 60" })).pane;
    await this.hook("shared-claude", "SessionStart", { pane: second });
    const actor = await this.actor("shared-claude");
    this.assertEqual(actor.attachments, 2);
    this.assertEqual(actor.agent.observation.completed, 1);
    await this.rpc({
      op: "pane.acknowledge",
      protocol: 1,
      pane: second,
      session: "shared-claude",
      through: 1,
    });
    this.assertEqual((await this.pane_snapshot(this.pane)).agent.observation.read, 1);
    this.assertEqual((await this.pane_snapshot(second)).agent.observation.read, 1);
  }
}
registerCase("CodexConversations", CodexConversations, { inherited: false });
registerCase("ClaudeConversations", ClaudeConversations, { inherited: false });
