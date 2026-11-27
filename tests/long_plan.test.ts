import { writeFileSync } from "node:fs";
import { registerCase } from "./support";
import { Summaries } from "./activity_summary";
import { Viewer } from "./viewer_client";
import { A } from "./codex_titles";
import { EXE, screen_text } from "./runtime";
import * as owner from "../src/activity/plan_owner";

class Plans extends Summaries {
  legacy_summaries = false;
  async hover(viewer: Viewer) {
    const rows = screen_text((await viewer.poll()).data, 100, 30),
      y = rows.findIndex((row, i) => i > 15 && row.includes("Codex"));
    this.assertTrue(y >= 0);
    await viewer.input(`\x1b[<35;6;${y + 1}M`);
    await viewer.advance(0.6);
  }
  async test_live_plan_reaches_the_viewer_and_keeps_its_episode_across_turns() {
    writeFileSync(this.control, JSON.stringify({ delay: 0, roadmap: true, ownership: true, bump: true }));
    await this.start_turn("first", false);
    const view = async () => (await this.session()).conversations.find((c: any) => c.agent.session === A).activity_plan;
    await this.until(async () => (await view()).nodes.length === 2);
    const first = await view();
    const request = this.summary_logs().find((r: any) => r.event === "request");
    this.assertEqual(request.instructions, owner.variant("direct").instructions);
    this.assertIsNone(request.schema);
    this.assertEqual(
      first.nodes.map((n: any) => n.id),
      ["e", "s"],
    );
    this.assertTrue(first.partial);
    this.assertEqual(first.focus, "e");
    this.assertEqual(first.focus_step, "s");
    const commentary = "Compare plan boundaries using the recorded RPC conversation, not transport implementation";
    this.append_record("response_item", {
      type: "message",
      role: "assistant",
      phase: "commentary",
      content: [{ type: "output_text", text: commentary }],
    });
    await this.advance(10);
    await this.until(() => this.summary_logs().some((r: any) => r.event === "request" && r.input.includes(commentary)));
    const viewer = await Viewer.create(this);
    const screen = async () => screen_text((await viewer.poll()).data, 100, 30).join("\n");
    try {
      await this.hover(viewer);
      await this.until(async () => (await screen()).includes("Repair focus transitions"));
      const tooltip = await screen();
      for (const label of ["Total", "Tokens", "Tools", "Cached", "Existing focus test fails", "▶ …"])
        this.assertIn(label, tooltip);
      this.assertNotIn("Esc close", tooltip);
      await viewer.input("\x1b[<35;99;1M");
      await viewer.advance(0.6);
      await this.until(async () => !(await screen()).includes("Repair focus transitions"));
    } finally {
      await viewer.close();
    }
    const tokens = (input: number) =>
      this.append_record("event_msg", {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: input, cached_input_tokens: 50, output_tokens: 10 },
          last_token_usage: { input_tokens: input === 100 ? 100 : 200, cached_input_tokens: 50, output_tokens: 10 },
        },
      });
    tokens(100);
    await this.until(async () => (await view()).known);
    tokens(300);
    await this.until(async () => BigInt((await view()).counts.e.input) >= 200n);
    this.tools(2, "bun test focus");
    await this.until(async () => {
      const plan = await view();
      return BigInt(plan.counts.e.tools) + BigInt(plan.unassigned.tools) === 2n;
    });
    await this.advance(10);
    await this.until(async () => (await view()).counts.e.tools === "2");
    const before = await view(),
      pid = (await this.session()).server_pid;
    this.assertEqual(before.nodes[1].bump.kind, "verification");
    await this.rpc({ op: "server.reload", executable: EXE });
    await this.attachment.select(A);
    this.assertNotEqual((await this.session()).server_pid, pid);
    this.assertEqual(await view(), before);
    await this.start_turn("second", false);
    this.tools(1, "bun test focus");
    // Reload resets the test clock; pass the cooldown saved by the old daemon.
    await this.advance(60);
    await this.until(() =>
      this.summary_logs().some(
        (r: any) =>
          r.event === "request" &&
          r.fresh_input?.includes("Turn 2;") &&
          JSON.parse(r.fresh_input.split("\n", 1)[0]).tree?.length === 2,
      ),
    );
    this.assertEqual(
      (await view()).nodes.map((n: any) => n.id),
      ["e", "s"],
    );
  }
  async test_returned_work_appends_at_the_tail_and_survives_reload() {
    writeFileSync(this.control, JSON.stringify({ delay: 0, roadmap: true, ownership: true }));
    const view = async () => (await this.session()).conversations.find((c: any) => c.agent.session === A).activity_plan;
    await this.start_turn("first", false);
    await this.until(async () => (await view()).visits?.length === 1);
    writeFileSync(this.control, JSON.stringify({ delay: 0, roadmap: true, ownership: true, plan_step: "other" }));
    await this.start_turn("second", false);
    this.tools(1, "check receipts");
    await this.advance(10);
    await this.until(async () => (await view()).visits.at(-1)?.step === "s2");
    const earlier = (await view()).visits[0];
    writeFileSync(this.control, JSON.stringify({ delay: 0, roadmap: true, ownership: true }));
    await this.start_turn("return", false);
    this.tools(1, "check focus");
    await this.advance(10);
    await this.until(async () => (await view()).visits.at(-1)?.step === "s");
    this.assertEqual(
      (await view()).visits.map((v: any) => v.step),
      ["s", "s2", "s"],
    );
    this.assertEqual((await view()).visits[0], earlier);
    const viewer = await Viewer.create(this);
    try {
      await this.hover(viewer);
      const screen = async () => screen_text((await viewer.poll()).data, 100, 30).join("\n");
      await this.until(async () => (await screen()).includes("↩ Repair focus transitions"));
      const drawn = await screen();
      this.assertTrue(drawn.lastIndexOf("Trace focus changes") > drawn.indexOf("Check receipt totals"));
      const before = (await view()).visits;
      await this.rpc({ op: "server.reload", executable: EXE });
      this.assertEqual((await view()).visits, before);
      await this.until(async () => (await screen()).includes("↩ Repair focus transitions"));
    } finally {
      await viewer.close();
    }
  }
}
registerCase("Plans", Plans, { inherited: false });
