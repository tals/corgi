import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerCase, sleep } from "./support";
import { Viewer } from "./viewer_client";
import { screen_text, EXE } from "./runtime";
import { A } from "./codex_titles";
import { Summaries, ClaudeSummaries, lines } from "./activity_summary";

class SummaryCases extends Summaries {
  async test_tool_icon_survives_polls_and_tracks_yielded_background_build() {
    await this.start_turn("active", false);
    await this.until(
      async () => (await this.state()).activity === "Tracing pane focus",
    );
    const call = this.tools(1, "zig build", false)[0];
    await this.until(async () => (await this.state()).tool_active);
    await sleep(1.2);
    this.assertTrue((await this.state()).tool_active);
    this.sim.background_tasks = {
      [A]: [{ processId: "build-1", command: "zig build" }],
    };
    await this.until(
      async () =>
        !!(await this.session()).conversations.find(
          (c: any) => c.agent.session === A,
        ).background_tasks.items.length,
    );
    this.finish_tool(call);
    await sleep(1.2);
    this.assertTrue((await this.state()).tool_active);
    await this.until(
      () =>
        this.calls().some((call) =>
          JSON.parse(call).evidence.includes(
            "Currently running background tasks:\nBuilding project",
          ),
        ),
      12,
    );
    const viewer = await Viewer.create(this);
    try {
      await this.until(async () => (await viewer.poll()).data.includes("🔧"));
    } finally {
      await viewer.close();
    }
    this.sim.background_tasks = {};
    await this.until(async () => !(await this.state()).tool_active);
    const next = this.tools(1, "rg focus src", false)[0];
    await this.until(async () => (await this.state()).tool_active);
    this.finish_tool(next);
    await this.until(async () => !(await this.state()).tool_active);
  }
  async test_summary_log_records_exact_request_and_output() {
    const raw = '  "Tracing pane focus"\n';
    writeFileSync(this.control, JSON.stringify({ delay: 0, label: raw }));
    await this.start_turn("active", false);
    await this.until(
      async () => (await this.state()).activity === "Tracing pane focus",
    );
    const records = this.summary_logs(),
      request = records.find((r: any) => r.event === "request"),
      result = records.find((r: any) => r.event === "result");
    this.assertEqual(request.input, this.calls()[0]);
    this.assertIn("2 or 3 words", request.instructions);
    this.assertEqual(request.context, result.context);
    this.assertEqual(request.context.source.panes, [this.pane]);
    this.assertEqual(request.context.source.session, A);
    this.assertEqual(request.context.turn, "active");
    this.assertEqual(JSON.parse(result.output), { label: raw });
    this.assertEqual(result.status, "validated");
  }
  async test_summary_log_identifies_inference_error() {
    writeFileSync(this.control, JSON.stringify({ delay: 0, fail: true }));
    await this.start_turn("active", false);
    await this.until(() =>
      this.summary_logs().some((r: any) => r.event === "result"),
    );
    const [request, result] = this.summary_logs().slice(0, 2);
    this.assertEqual(request.context, result.context);
    this.assertEqual(request.input, this.calls()[0]);
    this.assertEqual(result.context.source.panes, [this.pane]);
    this.assertEqual(
      [result.status, result.err],
      ["inference_error", "InferenceFailed"],
    );
    this.assertIsNone(result.output);
    this.assertEqual((await this.state()).activity, "");
  }
  async test_short_summary_is_usable_without_retry() {
    for (const [i, label] of [
      "Tracing tool activity code",
      "Inspecting logs and summary behavior",
      "Checking tool calls and background builds",
    ].entries()) {
      writeFileSync(this.control, JSON.stringify({ delay: 0, label }));
      await this.start_turn("concise-" + i, false);
      await this.until(async () => (await this.state()).activity === label);
      const result = this.summary_logs()
        .filter((r: any) => r.event === "result")
        .at(-1);
      this.assertEqual(
        [result.status, JSON.parse(result.output).label],
        ["validated", label],
      );
      await sleep(1);
      this.assertEqual(this.calls().length, i + 1);
    }
  }
  async test_compaction_overrides_current_activity_and_remains_in_timeline() {
    const conversation = async () =>
      (await this.session()).conversations.find(
        (c: any) => c.agent.session === A,
      );
    const points = async () =>
      (await conversation()).timeline.points.map((p: any) => p.activity);
    await this.start_turn("active", false);
    await this.until(
      async () => (await this.state()).activity === "Tracing pane focus",
    );
    await this.attachment.send("screen:compacting");
    await this.until(async () => (await this.state()).compacting);
    this.assertEqual(await points(), [
      "Tracing pane focus",
      "Compacting context",
    ]);
    await sleep(1.2);
    this.assertTrue((await this.state()).compacting);
    const viewer = await Viewer.create(this);
    const rows = async () =>
      screen_text(
        (await viewer.poll()).data.replace(/\x1b_G.*?\x1b\\/gs, ""),
        100,
        30,
      );
    try {
      const initial = await rows();
      const y = initial.findIndex((r, i) => i > 15 && r.includes("codex"));
      await viewer.input(`\x1b[<35;6;${y + 1}M`);
      await sleep(0.6);
      this.assertTrue(
        (await rows()).some((r) => r.includes("now  ●  Compacting context")),
      );
      this.assertFalse(
        (await rows()).some((r) => r.includes("now  ●  Tracing pane focus")),
      );
      await this.attachment.send("screen:working");
      await this.until(async () => !(await this.state()).compacting);
      this.assertEqual(await points(), [
        "Tracing pane focus",
        "Compacting context",
        "Tracing pane focus",
      ]);
      this.assertTrue(
        (await rows()).some((r) => r.includes("○  Compacting context")),
      );
      this.assertTrue(
        (await rows()).some((r) => r.includes("now  ●  Tracing pane focus")),
      );
    } finally {
      await viewer.close();
    }
  }
  async test_compaction_clears_after_live_reload_while_the_same_turn_keeps_working() {
    const points = async () =>
      (await this.session()).conversations
        .find((c: any) => c.agent.session === A)
        .timeline.points.map((p: any) => p.activity);
    await this.start_turn("active", false);
    await this.until(
      async () => (await this.state()).activity === "Tracing pane focus",
    );
    await this.attachment.send("screen:compacting");
    await this.until(async () => (await this.state()).compacting);
    await this.rpc({ op: "server.reload", protocol: 1, executable: EXE });
    await this.until(
      async () =>
        (await this.state()).compacting &&
        JSON.stringify(await points()) ===
          JSON.stringify(["Compacting context"]),
    );
    await this.attachment.send("screen:working");
    await this.until(async () => !(await this.state()).compacting);
    this.assertEqual((await this.state()).state, "working");
    this.assertEqual(await points(), [
      "Compacting context",
      "Tracing pane focus",
    ]);
  }
  async test_commentary_fires_without_tools_and_one_completion_refreshes() {
    await this.start_turn("active", false);
    await this.until(() => this.calls().length === 1);
    await this.until(
      async () => (await this.state()).activity === "Tracing pane focus",
    );
    this.assertIn("tracing pane focus", JSON.parse(this.calls()[0]).evidence);
    const id = this.tools(1, "rg focus src", false)[0];
    this.finish_tool(id);
    this.finish_tool(id);
    await this.until(() => this.calls().length === 2, 12);
    this.assertIn("rg focus src", JSON.parse(this.calls()[1]).evidence);
    await sleep(8.5);
    this.assertEqual(this.calls().length, 2);
  }
  async test_running_command_refreshes_before_completion_without_repeated_inference() {
    await this.start_turn("active", false);
    await this.until(
      async () => (await this.state()).activity === "Tracing pane focus",
    );
    writeFileSync(
      this.control,
      JSON.stringify({ delay: 0, label: "Running smoke tests" }),
    );
    this.tools(1, "bun test tests/smoke.test.ts --long-running", false);
    await this.until(
      async () => (await this.state()).activity === "Running smoke tests",
      12,
    );
    const evidence = JSON.parse(this.calls().at(-1)!).evidence;
    this.assertIn("Currently running tools", evidence);
    this.assertIn("bun test tests/smoke.test.ts", evidence);
    const count = this.calls().length;
    await sleep(8.5);
    this.assertEqual(this.calls().length, count);
  }
  async test_later_wave_refreshes_under_throttle_even_when_commentary_is_unchanged() {
    await this.start_turn();
    await this.until(() => this.calls().length === 1);
    const first = performance.now();
    await this.until(
      async () => (await this.state()).activity === "Tracing pane focus",
    );
    writeFileSync(
      this.control,
      JSON.stringify({ delay: 0, label: "Testing pane focus" }),
    );
    this.tools(3, "zig build test");
    await sleep(1);
    this.assertEqual(this.calls().length, 1);
    await this.until(() => this.calls().length === 2, 12);
    this.assertGreater(performance.now() - first, 6000);
    this.assertEqual(lines(this.log + ".processes").length, 1);
    await this.until(
      async () => (await this.state()).activity === "Testing pane focus",
    );
    this.assertIn("zig build test", JSON.parse(this.calls()[1]).evidence);
  }
  async test_new_turn_reuses_actor_conversation_without_waiting_for_tools() {
    await this.start_turn("active", false);
    await this.until(() => this.calls().length === 1);
    await this.until(
      async () => (await this.state()).activity === "Tracing pane focus",
    );
    await this.start_turn("second", false);
    await this.until(() => this.calls().length === 2);
    const second = JSON.parse(this.calls()[1]);
    this.assertEqual(second.turn, "second");
    this.assertEqual(second.previous, "Tracing pane focus");
    this.assertIn("Tracing pane focus", second.history[0]);
    const sessions = lines(this.log + ".sessions").map((v) => JSON.parse(v));
    this.assertEqual(sessions[0].pid, sessions[1].pid);
    this.assertEqual(sessions[0].thread, sessions[1].thread);
    this.assertEqual(sessions[1].turn, 2);
  }
  async test_setup_switches_provider_persists_choice_and_auto_follows_agents() {
    let status = (await this.session()).inference;
    this.assertEqual(
      [status.choice, status.provider, status.model],
      ["codex", "codex", "gpt-6-luna"],
    );
    await this.start_turn("active", false);
    await this.until(
      async () => (await this.state()).activity === "Tracing pane focus",
    );
    await this.until(async () => (await this.session()).inference.locked);
    let reply = await this.rpc({
      op: "inference.configure",
      protocol: 1,
      choice: "claude",
    });
    this.assertTrue(reply.saved);
    this.assertEqual(
      [reply.inference.provider, reply.inference.locked],
      ["claude", false],
    );
    this.assertEqual(
      JSON.parse(readFileSync(this.path + ".settings.json", "utf8")),
      { inference: "claude" },
    );
    this.assertEqual(
      (await this.session()).system_model,
      "claude-haiku-4-5-20251001",
    );
    writeFileSync(
      this.control,
      JSON.stringify({ delay: 0, label: "Running tests" }),
    );
    await this.start_turn("after-switch", false);
    await this.until(
      async () => (await this.state()).activity === "Running tests",
    );
    this.assertEqual(lines(this.log + ".processes").length, 2);
    this.assertEqual(
      (
        await this.rpc({
          op: "inference.configure",
          protocol: 1,
          choice: "off",
        })
      ).inference.provider,
      null,
    );
    status = (
      await this.rpc({ op: "inference.configure", protocol: 1, choice: "auto" })
    ).inference;
    this.assertEqual([status.choice, status.provider], ["auto", "codex"]);
    this.assertGreaterEqual(status.launches.codex, 1);
    this.assertEqual(status.launches.claude, 0);
  }
  async test_watched_workspace_still_collects_tools() {
    await this.attach();
    await this.rpc({ op: "focus", pane: this.pane });
    await this.start_turn();
    await this.until(
      async () => (await this.state()).activity === "Tracing pane focus",
    );
    this.assertEqual(this.calls().length, 1);
  }
  async test_summary_second_row_and_unchanged_input() {
    await this.command("pane.rename", {
      name: "A deliberately long agent name",
      target: this.pane,
    });
    await this.start_turn();
    await this.until(
      async () => (await this.state()).activity === "Tracing pane focus",
    );
    await this.attach();
    let screen = await this.frame_with("Tracing pane focus");
    this.assertIn("A deliberately long", screen[13].slice(0, 27));
    this.assertNotIn("Tracing", screen[13].slice(0, 27));
    this.assertIn("Tracing pane focus", screen[14].slice(0, 27));
    this.assertNotIn("agent name", screen[14].slice(0, 27));
    const payload = JSON.parse(this.calls()[0]);
    this.assertEqual(payload.provider, "codex");
    this.assertIn("tracing pane focus", payload.evidence);
    await sleep(1.2);
    this.assertEqual(this.calls().length, 1);
    this.states[A] = "idle";
    this.turns[A] = ["active", "completed"];
    await this.until(async () => (await this.state()).state === "idle");
    this.assertEqual((await this.state()).activity, "");
    screen = await this.frame_with("ᐯ", 80, 24, 14);
    this.assertNotIn("Tracing pane focus", screen[14].slice(0, 27));
  }
  async test_late_result_after_completion_is_discarded() {
    writeFileSync(
      this.control,
      JSON.stringify({ delay: 1.5, label: "Old stale activity" }),
    );
    await this.start_turn();
    await this.until(() => existsSync(this.log));
    this.states[A] = "idle";
    this.turns[A] = ["active", "completed"];
    await this.until(async () => (await this.state()).state === "idle");
    this.assertEqual((await this.state()).activity, "");
    await sleep(1.8);
    this.assertEqual((await this.state()).activity, "");
    const actor = (await this.session()).conversations.find(
      (c: any) => c.agent.session === A,
    );
    this.assertEqual(actor.timeline.points, []);
  }
  async test_bad_backend_output_falls_back_without_retry_loop() {
    writeFileSync(
      this.control,
      JSON.stringify({ delay: 0, label: "This label has far too many words" }),
    );
    await this.start_turn();
    await this.until(() => existsSync(this.log));
    await sleep(1);
    this.assertEqual((await this.state()).activity, "");
    await this.attach();
    const screen = await this.frame_with("codex", 13);
    this.assertTrue(screen[14].slice(4, 27).trim());
    this.assertNotIn("This label has far too many words", screen.join("\n"));
    this.assertEqual(this.calls().length, 1);
    const records = this.summary_logs(),
      request = records.find((r: any) => r.event === "request"),
      result = records.find((r: any) => r.event === "result");
    this.assertEqual(request.input, this.calls()[0]);
    this.assertEqual(result.context, request.context);
    this.assertEqual(result.context.source.panes, [this.pane]);
    this.assertEqual(
      JSON.parse(result.output).label,
      "This label has far too many words",
    );
    this.assertEqual(
      [result.status, result.err],
      ["rejected", "InvalidWordCount"],
    );
  }
  async test_abstention_waits_for_evidence_without_failure_backoff() {
    writeFileSync(this.control, JSON.stringify({ label: null }));
    await this.start_turn("active", false);
    await this.until(() =>
      this.summary_logs().some((r: any) => r.status === "abstained"),
    );
    this.assertEqual((await this.state()).activity, "");
    this.assertEqual((await this.state()).state, "working");
    await sleep(9);
    this.assertEqual(this.calls().length, 1);
    writeFileSync(
      this.control,
      JSON.stringify({ label: "Fixing cursor visibility" }),
    );
    this.items[A].at(-1).text = "I am fixing cursor visibility.";
    await this.until(
      async () => (await this.state()).activity === "Fixing cursor visibility",
      12,
    );
    this.assertEqual(this.calls().length, 2);
  }
  async test_abstention_clears_stale_activity_without_changing_lifecycle() {
    await this.start_turn("active", false);
    await this.until(
      async () => (await this.state()).activity === "Tracing pane focus",
    );
    writeFileSync(this.control, JSON.stringify({ label: null }));
    this.items[A] = [
      { type: "userMessage", content: [{ type: "text", text: "continue" }] },
    ];
    await this.until(
      () => this.summary_logs().some((r: any) => r.status === "abstained"),
      12,
    );
    await this.until(async () => (await this.state()).activity === "");
    this.assertEqual((await this.state()).state, "working");
    this.assertEqual((await this.state()).attention, "none");
  }
  async test_activity_timeline_tracks_intervals_and_preserves_own_breakdown() {
    const conversation = async () =>
      (await this.session()).conversations.find(
        (c: any) => c.agent.session === A,
      );
    const total = [0, 0, 0];
    const spend = async (values: number[]) => {
      values.forEach((v, i) => (total[i] += v));
      const tokens = (v: number[]) => ({
        input_tokens: v[0],
        cached_input_tokens: v[1],
        output_tokens: v[2],
      });
      this.append_record("event_msg", {
        type: "token_count",
        info: {
          total_token_usage: tokens(total),
          last_token_usage: tokens(values),
        },
      });
      await this.until(
        async () => (await conversation()).usage.tokens.input === total[0],
      );
    };
    const waves: [string, number[]][] = [
      ["Reading source", [1000, 600, 200]],
      ["Tracing usage", [4500, 3000, 900]],
      ["Running tests", [6000, 4000, 1600]],
    ];
    for (const [i, [label, values]] of waves.entries()) {
      writeFileSync(this.control, JSON.stringify({ delay: 0, label }));
      await this.start_turn("timeline-" + i, false);
      await this.until(
        async () => (await conversation()).timeline.points.length === i + 1,
      );
      await spend(values);
    }
    await spend([400, 200, 100]);
    await this.until(
      async () => (await this.session()).system_usage.tokens.input === 3000,
    );
    this.assertEqual((await this.session()).system_model, "gpt-6-luna");
    this.assertEqual((await this.session()).system_usage.tokens, {
      input: 3000,
      cached_input: 1800,
      output: 30,
    });
    const points = (await conversation()).timeline.points;
    this.assertEqual(
      points.map((p: any) => p.usage.tokens.input + p.usage.tokens.output),
      [1200, 5400, 0],
    );
    this.assertEqual(
      points.map((p: any) => p.activity),
      ["Reading source", "Tracing usage", "Running tests"],
    );
    this.assertEqual(
      points.map((p: any) => p.at).toSorted(),
      points.map((p: any) => p.at),
    );
    this.assertTrue(
      points.every((p: any) => p.usage.known && !p.usage.partial),
    );
    this.assertEqual(
      (await conversation()).timeline.pending.tokens.input,
      6400,
    );
    this.viewers = [];
    const viewer = await Viewer.create(this, 100, 30);
    const hover = async (cols: number, rows: number) => {
      const screen = screen_text((await viewer.poll()).data, cols, rows);
      const y = screen.findIndex(
        (r, i) => i > Math.floor(rows / 2) && r.includes("codex"),
      );
      await viewer.input(`\x1b[<35;6;${y + 1}M`);
      await sleep(0.6);
      return (await viewer.poll()).data;
    };
    try {
      let frame = await hover(100, 30);
      for (const t of [
        "Total",
        "Tokens",
        "Cached",
        "6.9k",
        "7.8k",
        "Recent",
        "Running tests",
      ])
        this.assertIn(t, frame);
      let rows = screen_text(frame.replace(/\x1b_G.*?\x1b\\/gs, ""), 100, 30);
      const timelineRow = (label: string) =>
        rows.find(
          (r) => r.includes(label) && (r.includes("○") || r.includes("●")),
        )!;
      this.assertEqual(
        rows.filter((r) => r.includes("Tokens") && r.includes("Cached")).length,
        1,
      );
      this.assertRegex(
        rows.find((r) => r.includes("Total"))!,
        /Total\s+6\.9k\s+7\.8k/,
      );
      this.assertRegex(
        timelineRow("Reading source"),
        /Reading source\s+600\s+600/,
      );
      this.assertRegex(
        timelineRow("Tracing usage"),
        /Tracing usage\s+2\.4k\s+3(\.0)?k/,
      );
      this.assertRegex(
        timelineRow("Running tests"),
        /Running tests\s+3\.9k\+\s+4\.2k\+/,
      );
      const positions = [
        "Reading source",
        "Tracing usage",
        "Running tests",
      ].map((label) =>
        rows.findIndex(
          (r) => r.includes(label) && (r.includes("○") || r.includes("●")),
        ),
      );
      this.assertEqual(positions, [
        positions[0],
        positions[0] + 1,
        positions[0] + 2,
      ]);
      writeFileSync(
        "/tmp/corgi-timeline-frame.json",
        JSON.stringify({ cols: 100, rows: 30, frame }),
      );
      await viewer.request({ op: "badge", visible: true });
      await viewer.input("\x1b[<35;3;1M");
      await sleep(0.6);
      const overview = (await viewer.poll()).data;
      for (const t of [
        "Corgi (Activity summarizer)",
        "Top agents",
        "Model",
        "Tokens",
        "Cached",
        "8.1k tokens (+9.6k cached)",
      ])
        this.assertIn(t, overview);
      rows = screen_text(overview.replace(/\x1b_G.*?\x1b\\/gs, ""), 100, 30);
      const systemRow = rows.find((r) =>
        r.includes("Corgi (Activity summarizer"),
      )!;
      const agentRow = rows.find((r) => r.includes("codex ·"))!;
      this.assertRegex(
        systemRow,
        /Corgi \(Activity summarizer\)\s+gpt-6-luna\s+1\.2k\s+1\.8k\s+1\.2k/,
      );
      this.assertRegex(agentRow, /codex · \S+\s+—\s+6\.9k\s+7\.8k/);
      this.assertNotIn("tracked sessions", overview);
      writeFileSync(
        "/tmp/corgi-overview-frame.json",
        JSON.stringify({ cols: 100, rows: 30, frame: overview }),
      );
      await viewer.request({ op: "badge", visible: false });
      frame = await hover(100, 30);
      await viewer.poll();
      await viewer.poll();
      this.assertEqual(
        (await conversation()).timeline.pending.tokens.input,
        6400,
      );
      this.states[A] = "idle";
      this.turns[A] = ["timeline-2", "completed"];
      await this.until(async () => (await this.state()).state === "idle");
      frame = (await viewer.poll()).data;
      this.assertIn(" last", frame);
      this.assertNotIn("3.9k+", frame);
      this.assertEqual((await conversation()).timeline.points.length, 3);
      await viewer.request({ op: "size", cols: 64, rows: 13 });
      await viewer.input("\x1b[<35;63;1M");
      const small = await hover(64, 13);
      for (const t of ["Total", "6.9k", "7.8k", "Recent", "Running tests"])
        this.assertIn(t, small);
      this.assertNotIn("Own usage", small);
    } finally {
      await viewer.close();
    }
  }
}
registerCase("Summaries", SummaryCases, { inherited: false });
registerCase("ClaudeSummaries", ClaudeSummaries, { inherited: false });
