/** Live child discovery and usage through real viewers. */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Titles, A } from "./codex_titles";
import { Runtime, EXE, screen_text } from "./runtime";
import { Viewer } from "./viewer_client";
import { registerCase, sleep } from "./support";

const C = "01921234-1234-1234-1234-123456789abc",
  D = "01931234-1234-1234-1234-123456789abc",
  E = "01941234-1234-1234-1234-123456789abc";
class Children extends Titles {
  async conversation(session: string) {
    return (await this.session()).conversations.find(
      (c: any) => c.agent.session === session,
    );
  }
  stamp() {
    return new Date().toISOString();
  }
  token_event(ordinal: number, total: number[], last: number[]) {
    const usage = (v: number[]) => ({
      input_tokens: v[0],
      cached_input_tokens: v[1],
      output_tokens: v[2],
    });
    return {
      type: "event_msg",
      ordinal,
      timestamp: this.stamp(),
      payload: {
        type: "token_count",
        info: {
          total_token_usage: usage(total),
          last_token_usage: usage(last),
        },
      },
    };
  }
  create_child(
    session: string,
    parent: string,
    role: string,
    name: string,
    boundary = true,
  ) {
    const path = join(this.temp.name, session + ".jsonl"),
      stamp = this.stamp();
    const metadata: any = {
      id: session,
      timestamp: stamp,
      source: { subagent: { thread_spawn: { parent_thread_id: parent } } },
    };
    if (boundary) metadata.subagent_history_start_ordinal = 10;
    const records = [
      { type: "session_meta", ordinal: 0, timestamp: stamp, payload: metadata },
      this.token_event(2, [1000, 800, 100], [1000, 800, 100]),
      {
        type: "turn_context",
        ordinal: 10,
        timestamp: stamp,
        payload: { turn_id: "work-" + session },
      },
      this.token_event(11, [1200, 850, 120], [100, 50, 20]),
    ];
    writeFileSync(path, records.map((r) => JSON.stringify(r) + "\n").join(""));
    this.sim.set_turn(session, "work-" + session, "inProgress");
    this.sim.names[session] = name;
    this.sim.paths[session] = path;
    this.children.push({
      id: session,
      parentThreadId: parent,
      agentRole: role,
      name,
      path,
      status: { type: "active", activeFlags: [] },
    });
    return path;
  }
  async test_owned_catchup_nested_groups_and_live_hover() {
    this.sim.set_turn(A, "parent-work", "inProgress");
    const path = this.create_child(C, A, "Explorer", "Trace usage");
    this.create_child(D, A, "Explorer", "Map sessions");
    this.create_child(E, C, "Reviewer", "Check accounting");
    await this.until(async () => {
      const all = await Promise.all([C, D, E].map((s) => this.conversation(s)));
      return all.every((c) => c && c.usage.known);
    });
    const root = await this.conversation(A),
      child = await this.conversation(C),
      nested = await this.conversation(E);
    this.assertEqual(child.parent, root.id);
    this.assertEqual(nested.parent, child.id);
    for (const session of [C, D, E])
      this.assertEqual((await this.conversation(session)).usage.tokens, {
        input: 100,
        cached_input: 50,
        output: 20,
      });
    const a = await Viewer.create(this, 120, 40),
      b = await Viewer.create(this, 120, 40);
    await this.until(async () => (await a.poll()).data.includes("↳2"));
    let rows = screen_text(a.state.data, 120, 40);
    const y = rows.findIndex((r) => r.includes("↳2")),
      x = rows[y].indexOf("↳2");
    await a.input(`\x1b[<35;${x + 1};${y + 1}M`);
    this.assertNotIn("Including subagents", a.state.data);
    await sleep(0.6);
    let frame = (await a.poll()).data;
    for (const text of [
      "Total",
      "Including subagents",
      "Trace usage",
      "Check accounting",
    ])
      this.assertIn(text, frame);
    const childRows = screen_text(frame, 120, 40).filter(
      (r) => r.includes("↳") && r.includes("70+"),
    );
    this.assertEqual(childRows.length, 3);
    this.assertTrue(childRows.every((r) => r.includes("50+")));
    this.assertNotIn("Including subagents", (await b.poll()).data);
    let screen = screen_text(frame, 120, 40);
    const border = screen.find((r) => r.includes("╭") && r.includes("╮"))!;
    this.assertEqual(
      border.slice(border.indexOf("╭"), border.indexOf("╮") + 1).length,
      88,
    );
    this.assertIn("\x1b[1;38;2;148;226;213m", frame);
    writeFileSync("/tmp/corgi-subagents-screen.txt", screen.join("\n"));
    writeFileSync(
      "/tmp/corgi-subagents-frame.json",
      JSON.stringify({ cols: 120, rows: 40, frame }),
    );
    for (const hoverY of [y - 1, y]) {
      await a.input(`\x1b[<35;6;${hoverY + 1}M`);
      this.assertNotIn("Including subagents", a.state.data);
      await sleep(0.6);
      frame = (await a.poll()).data;
      for (const text of [
        "Total",
        "Including subagents",
        "Trace usage",
        "Check accounting",
      ])
        this.assertIn(text, frame);
    }
    await a.request({ op: "size", cols: 64, rows: 13 });
    rows = screen_text((await a.poll()).data, 64, 13);
    const smallY = rows.findIndex((r, i) => i > 6 && r.includes("codex"));
    await a.input(`\x1b[<35;6;${smallY + 1}M`);
    await sleep(0.6);
    const small = (await a.poll()).data;
    for (const text of ["Total", "+3 more", "Including subagents"])
      this.assertIn(text, small);
    await a.request({ op: "size", cols: 120, rows: 40 });
    appendFileSync(
      path,
      JSON.stringify(this.token_event(12, [1200, 850, 120], [100, 50, 20])) +
        "\n" +
        JSON.stringify(this.token_event(13, [1250, 860, 125], [50, 10, 5])) +
        "\n",
    );
    await this.until(
      async () => (await this.conversation(C)).usage.tokens.input === 150,
    );
    const second = await this.create_attachment(C);
    await this.until(async () => (await second.state()).session === C);
    this.assertEqual(
      (await this.session()).conversations.filter(
        (c: any) => c.agent.session === C,
      ).length,
      1,
    );
    this.assertEqual((await this.conversation(C)).usage.tokens.output, 25);
    await a.focus(this.pane);
    await sleep(0.3);
    this.assertEqual((await this.conversation(C)).usage.tokens.input, 150);
    await a.input("x");
    this.assertNotIn("Including subagents", a.state.data);
    this.assertEqual(this.errors, []);
  }
  async test_ambiguous_prefix_is_partial_and_failed_discovery_retains_children() {
    const path = this.create_child(C, A, "Explorer", "Legacy child", false);
    await this.until(async () => !!(await this.conversation(C))?.usage.partial);
    this.assertEqual((await this.conversation(C)).usage.tokens.input, 0);
    appendFileSync(
      path,
      JSON.stringify(this.token_event(12, [1230, 860, 125], [30, 10, 5])) +
        "\n",
    );
    await this.until(
      async () => (await this.conversation(C)).usage.tokens.input === 30,
    );
    this.create_child(D, A, "Explorer", "Second child");
    this.create_child(E, A, "Reviewer", "Third child");
    await this.until(async () => !!(await this.conversation(E)));
    this.child_error = true;
    await this.until(
      async () => (await this.conversation(A)).children_observed_at === 0,
    );
    this.assertIsNotNone(await this.conversation(C));
    this.assertEqual((await this.conversation(C)).usage.tokens.input, 30);
    const viewer = await Viewer.create(this, 120, 40);
    let rows = screen_text((await viewer.poll()).data, 120, 40);
    const y = rows.findIndex((r, i) => i > 20 && r.includes("codex"));
    await viewer.input(`\x1b[<35;6;${y + 1}M`);
    await sleep(0.6);
    let frame = (await viewer.poll()).data;
    this.assertIn("Total", frame);
    for (const t of [
      "No subagents",
      "Updating child details",
      "Including subagents",
      "Explorer",
      "Reviewer",
      "↳",
    ])
      this.assertNotIn(t, frame);
    this.child_error = false;
    await this.until(
      async () => (await this.conversation(A)).children_observed_at > 0,
    );
    this.assertIn("Including subagents", (await viewer.poll()).data);
    this.sim.set_turn(C, "work-" + C, "completed");
    for (const child of this.children)
      if (child.id === C) child.status.type = "idle";
    await this.until(
      async () => (await this.conversation(C)).agent.state === "idle",
    );
    this.assertEqual((await this.conversation(C)).usage.tokens.input, 30);
    this.assertEqual(this.errors, []);
  }
}
class NativeUsage extends Runtime {
  async test_native_agent_hover_shows_own_usage_without_children() {
    await this.command("pane.create", { workspace: 1, command: "sleep 60" });
    const native = (
      await this.rpc({
        op: "native.start",
        provider: "codex",
        cwd: this.temp.name,
      })
    ).session;
    for (const [method, params] of [
      ["thread/started", { thread: { id: "solo", name: "Solo agent" } }],
      ["turn/started", { threadId: "solo", turn: { id: "work" } }],
      [
        "item/started",
        {
          threadId: "solo",
          turnId: "work",
          item: { id: "tool-1", type: "commandExecution" },
        },
      ],
      [
        "thread/tokenUsage/updated",
        {
          threadId: "solo",
          tokenUsage: {
            total: {
              inputTokens: 12345,
              cachedInputTokens: 8100,
              outputTokens: 2345,
            },
            last: {
              inputTokens: 12345,
              cachedInputTokens: 8100,
              outputTokens: 2345,
            },
          },
        },
      ],
    ] as const)
      await this.rpc({
        op: "native.send",
        session: native,
        message: { id: 1, method: "test/event", params: { method, params } },
      });
    await this.until(async () =>
      (await this.session()).conversations.some(
        (c: any) => c.agent.session === "solo" && c.usage.known,
      ),
    );
    const a = await Viewer.create(this, 100, 30),
      b = await Viewer.create(this, 100, 30);
    let rows = screen_text((await a.poll()).data, 100, 30);
    const y = rows.findIndex((r, i) => i > 15 && r.includes("codex"));
    let frame = "";
    for (const hoverY of [y, y + 1]) {
      await a.input(`\x1b[<35;6;${hoverY + 1}M`);
      this.assertNotIn("Total", a.state.data);
      await sleep(0.6);
      frame = (await a.poll()).data;
      for (const t of ["Total", "🔧", "6.6k", "8.1k", "Tokens", "Cached"])
        this.assertIn(t, frame);
      this.assertNotIn("Running a tool", frame);
      for (const t of ["No subagents", "Updating child details"])
        this.assertNotIn(t, frame);
      this.assertRegex(
        screen_text(frame, 100, 30).join("\n"),
        /now\s+●\s+\.{1,3}/,
      );
      this.assertNotIn("Total", (await b.poll()).data);
    }
    writeFileSync(
      "/tmp/corgi-agent-hover-screen.txt",
      screen_text(frame, 100, 30).join("\n"),
    );
    writeFileSync(
      "/tmp/corgi-agent-hover-frame.json",
      JSON.stringify({ cols: 100, rows: 30, frame }),
    );
    await a.input("\x1b[<35;40;10M");
    this.assertNotIn("Total", (await a.poll()).data);
    await a.request({ op: "size", cols: 64, rows: 13 });
    rows = screen_text((await a.poll()).data, 64, 13);
    const smallY = rows.findIndex((r, i) => i > 6 && r.includes("codex"));
    await a.input(`\x1b[<35;6;${smallY + 1}M`);
    await sleep(0.6);
    this.assertIn("Total", (await a.poll()).data);
    this.assertIn("6.6k", a.state.data);
    await a.input("x");
    this.assertNotIn("Total", a.state.data);
  }
  async test_reload_baselines_replayed_native_usage_but_counts_new_requests() {
    await this.command("pane.create", { workspace: 1, command: "sleep 60" });
    const native = (
      await this.rpc({
        op: "native.start",
        provider: "codex",
        cwd: this.temp.name,
      })
    ).session;
    const send = (method: string, params: any) =>
      this.rpc({
        op: "native.send",
        session: native,
        message: { id: 1, method: "test/event", params: { method, params } },
      });
    const actor = async () =>
      (await this.session()).conversations.find(
        (c: any) => c.agent.session === "native-child",
      );
    await send("turn/started", {
      threadId: "native-child",
      turn: { id: "work" },
    });
    await this.until(async () => !!(await actor()));
    const first = {
      total: { inputTokens: 100, outputTokens: 20 },
      last: { inputTokens: 100, outputTokens: 20 },
    };
    await send("thread/tokenUsage/updated", {
      threadId: "native-child",
      tokenUsage: first,
    });
    await this.until(async () => (await actor()).usage.tokens.input === 100);
    await this.rpc({ op: "server.reload", protocol: 1, executable: EXE });
    const restored = await actor();
    this.assertFalse(restored.usage.known);
    this.assertEqual(restored.usage.tokens.input, 0);
    await send("thread/tokenUsage/updated", {
      threadId: "native-child",
      tokenUsage: first,
    });
    await this.until(
      async () => (await actor()).observed_at > restored.observed_at,
    );
    this.assertEqual((await actor()).usage.tokens.input, 0);
    this.assertTrue((await actor()).usage.partial);
    await send("thread/tokenUsage/updated", {
      threadId: "native-child",
      tokenUsage: {
        total: { inputTokens: 130, outputTokens: 25 },
        last: { inputTokens: 30, outputTokens: 5 },
      },
    });
    await this.until(async () => (await actor()).usage.tokens.input === 30);
    this.assertEqual((await actor()).usage.tokens.output, 5);
  }
}
registerCase("Children", Children, { inherited: false });
registerCase("NativeUsage", NativeUsage, { inherited: false });
