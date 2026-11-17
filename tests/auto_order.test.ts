import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Viewers } from "./viewers";
import { screen_text } from "./runtime";
import type { Viewer } from "./viewer_client";
import { EXE, registerCase } from "./support";

/** Workspace auto-order with short thresholds, on the daemon's test clock. */
class AutoOrder extends Viewers {
  settings: Record<string, unknown> = {
    workspace_auto_order: true,
    workspace_pause_after: 1,
    workspace_stale_after: 3,
    workspace_archive_after: "off",
  };
  seq = 0;
  get settingsFile() {
    return `${this.path}.settings.json`;
  }
  async configure() {
    writeFileSync(this.settingsFile, JSON.stringify(this.settings));
  }
  /** Workspaces named `names`, the starter workspace taking the first. */
  async workspaces(...names: string[]): Promise<number[]> {
    const ids = [(await this.session()).workspaces[0].id];
    await this.command("workspace.edit", { target: ids[0], name: names[0], cwd: null });
    for (const name of names.slice(1))
      ids.push((await this.command("workspace.create", { name, cwd: this.temp.name })).workspace);
    return ids;
  }
  /** A Claude agent in a new pane of `workspace`, idle until prompted. */
  async agent(workspace: number): Promise<number> {
    const pane = (await this.command("pane.create", { workspace, cwd: this.temp.name, command: "sleep 600" })).pane;
    await this.hook(pane, "SessionStart");
    return pane;
  }
  transcript(pane: number) {
    return join(this.temp.name, `s${pane}.jsonl`);
  }
  hook(pane: number, event: string) {
    this.seq = Math.max(this.seq + 1, Date.now() * 1000);
    if (event === "SessionStart") writeFileSync(this.transcript(pane), "");
    return this.rpc({
      op: "hook",
      pane,
      provider: "claude",
      seq: this.seq,
      event: { hook_event_name: event, session_id: `s${pane}`, transcript_path: this.transcript(pane) },
    });
  }
  work(pane: number) {
    return this.hook(pane, "UserPromptSubmit");
  }
  /** Ends the agent's turn, as Claude's transcript confirms. */
  async stop(pane: number) {
    await this.hook(pane, "Stop");
    appendFileSync(
      this.transcript(pane),
      JSON.stringify({
        type: "system",
        subtype: "turn_duration",
        sessionId: `s${pane}`,
        timestamp: new Date().toISOString(),
      }) + "\n",
    );
    await this.until(async () => (await this.panes()).find((p: any) => p.id === pane)?.state === "idle");
  }
  /** Lets `seconds` pass on the daemon's clock, two at a time, as the
   * activity clock adds at most two seconds a tick. */
  async age(seconds: number) {
    for (let t = 0; t < seconds; t += 2) await this.advance(2);
  }
  async live() {
    return (await this.session()).workspaces.filter((w: any) => !w.archived);
  }
  async order() {
    return (await this.live()).map((w: any) => w.name);
  }
  async steps() {
    return Object.fromEntries((await this.live()).map((w: any) => [w.name, w.stale_step]));
  }
  move(target: number, before: number) {
    return this.command("workspace.move", { target, before });
  }
  /** The workspace names in the order `viewer`'s sidebar lists them. */
  shown(viewer: Viewer, names: string[]) {
    const rows = screen_text(viewer.state.data, 100, 40).map(row => row.slice(0, 27));
    return names
      .map(name => [name, rows.findIndex(row => row.includes(name))] as const)
      .filter(([, row]) => row >= 0)
      .sort((a, b) => a[1] - b[1])
      .map(([name]) => name);
  }

  async test_active_workspaces_keep_their_order_and_quiet_ones_sink() {
    const [alpha, bravo, charlie, delta] = await this.workspaces("Alpha", "Bravo", "Charlie", "Delta");
    const [a, b, c] = [await this.agent(alpha), await this.agent(bravo), await this.agent(charlie)];
    for (const pane of [a, b, c]) await this.work(pane);
    await this.age(200);
    // Delta has had nothing going on since it was made.
    this.assertEqual(await this.order(), ["Alpha", "Bravo", "Charlie", "Delta"]);
    const steps = await this.steps();
    this.assertEqual([steps.Alpha, steps.Bravo, steps.Charlie], [0, 0, 0]);
    this.assertTrue(steps.Delta >= 1, JSON.stringify(steps));
    // Bravo's agent comes and goes: nothing moves.
    for (let i = 0; i < 4; i++) {
      await this.stop(b);
      await this.age(10);
      await this.work(b);
      await this.age(10);
    }
    this.assertEqual(await this.order(), ["Alpha", "Bravo", "Charlie", "Delta"]);
    // Charlie goes quiet: it leaves the active group, above the longer idle Delta.
    await this.stop(c);
    await this.age(200);
    this.assertEqual(await this.order(), ["Alpha", "Bravo", "Charlie", "Delta"]);
    const later = await this.steps();
    this.assertTrue(later.Charlie >= 1 && later.Delta >= later.Charlie, JSON.stringify(later));
    // Delta wakes: it joins the end of the active group, in every viewer.
    const first = await this.newViewer(100, 40),
      second = await this.newViewer(100, 40);
    const names = ["Alpha", "Bravo", "Charlie", "Delta"];
    this.assertEqual(this.shown(first, names), names);
    const d = await this.agent(delta);
    await this.work(d);
    await this.settle();
    await this.settle();
    this.assertEqual(await this.order(), ["Alpha", "Bravo", "Delta", "Charlie"]);
    for (const viewer of [first, second]) {
      await viewer.poll();
      this.assertEqual(this.shown(viewer, names), ["Alpha", "Bravo", "Delta", "Charlie"]);
    }
    this.assertEqual((await this.steps()).Delta, 0);
    // A new workspace joins the end of the active group too.
    const echo = (await this.command("workspace.create", { name: "Echo", cwd: this.temp.name })).workspace;
    await this.settle();
    this.assertEqual(await this.order(), ["Alpha", "Bravo", "Delta", "Echo", "Charlie"]);
    // Reordering within the active group sticks; a stale workspace stays put,
    // and nothing lands below the first stale one.
    await this.move(echo, alpha);
    this.assertEqual(await this.order(), ["Echo", "Alpha", "Bravo", "Delta", "Charlie"]);
    await this.move(alpha, charlie);
    this.assertEqual(await this.order(), ["Echo", "Bravo", "Delta", "Alpha", "Charlie"]);
    await this.move(charlie, echo);
    await this.move(bravo, bravo);
    this.assertEqual(await this.order(), ["Echo", "Bravo", "Delta", "Alpha", "Charlie"]);
    await this.settle();
    this.assertEqual(await this.order(), ["Echo", "Bravo", "Delta", "Alpha", "Charlie"]);
  }

  /** Restarts the daemon with `changes` to its settings. */
  async reconfigure(changes: Record<string, unknown>) {
    const file = JSON.parse(readFileSync(this.settingsFile, "utf8"));
    writeFileSync(this.settingsFile, JSON.stringify({ ...file, ...changes }));
    await this.run_cli("shutdown");
    await this.run_cli("start");
  }
  /** A quiet spell long enough for the pause to begin, then `seconds` in one jump. */
  async away(seconds: number) {
    await this.age(70);
    await this.advance(seconds);
  }
  async groups() {
    return (await this.live()).map((w: any) => [w.name, w.stale_step]);
  }

  async test_a_break_counts_only_until_the_pause() {
    const [alpha, bravo] = await this.workspaces("Alpha", "Bravo", "Charlie");
    const a = await this.agent(alpha),
      b = await this.agent(bravo);
    // Only an agent works, for five minutes: the clock runs and Charlie goes stale.
    await this.work(a);
    await this.age(300);
    this.assertEqual((await this.order())[0], "Alpha");
    const steps = await this.steps();
    this.assertTrue(steps.Alpha === 0 && steps.Bravo >= 1 && steps.Charlie >= 1, JSON.stringify(steps));
    // Alpha's agent stops, and everyone leaves for an hour.
    await this.stop(a);
    const before = await this.groups();
    await this.away(3600);
    // The pause never moves anything, and Alpha's idle time is the minute
    // before the pause, not an hour.
    this.assertEqual(await this.groups(), before);
    this.assertEqual((await this.steps()).Alpha, 0);
    // Work resumes in Bravo: Alpha goes stale two minutes later, not before.
    await this.work(b);
    await this.age(100);
    this.assertEqual((await this.steps()).Alpha, 0);
    await this.age(30);
    this.assertTrue((await this.steps()).Alpha >= 1, JSON.stringify(await this.steps()));
    this.assertEqual(await this.order(), ["Bravo", "Alpha", "Charlie"]);
  }

  async test_a_sleep_between_two_ticks_ages_nothing() {
    await this.reconfigure({ workspace_archive_after: 4 });
    const [alpha] = await this.workspaces("Alpha", "Bravo");
    const a = await this.agent(alpha);
    await this.work(a);
    await this.age(20);
    const before = await this.groups();
    // Ten hours pass in one jump, with an agent still working.
    await this.advance(10 * 3600);
    this.assertEqual(await this.groups(), before);
    this.assertEqual(await this.order(), ["Alpha", "Bravo"]);
  }

  async test_restarts_and_reloads_keep_idle_times_without_counting_downtime() {
    const [alpha, bravo] = await this.workspaces("Alpha", "Bravo", "Charlie");
    const a = await this.agent(alpha);
    await this.work(a);
    await this.age(240);
    const before = await this.groups();
    this.assertEqual(before[0], ["Alpha", 0]);
    this.assertTrue(before[1][1] >= 1 && before[2][1] >= 1, JSON.stringify(before));
    // A reload hands the clock and each workspace's activity over.
    await this.rpc({ op: "server.reload", executable: EXE });
    this.assertEqual(await this.groups(), before);
    // Down for an hour: nothing ages, and the order is as saved.
    await this.run_cli("shutdown");
    await this.run_cli("start");
    await this.advance(3600);
    this.assertEqual(await this.groups(), before);
    // Work resumes: Alpha was active 240 s of activity ago at most, Bravo's
    // fade goes on from where it was.
    const b = await this.agent(bravo);
    await this.work(b);
    await this.age(10);
    const order = await this.order();
    this.assertEqual(order.slice(0, 2), ["Alpha", "Bravo"]);
  }

  async test_off_keeps_the_manual_order_and_no_fade() {
    writeFileSync(this.settingsFile, JSON.stringify({ ...this.settings, workspace_auto_order: false }));
    await this.run_cli("shutdown");
    await this.run_cli("start");
    const [alpha, bravo] = await this.workspaces("Alpha", "Bravo", "Charlie");
    const pane = await this.agent(bravo);
    await this.work(pane);
    await this.age(200);
    this.assertEqual(await this.order(), ["Alpha", "Bravo", "Charlie"]);
    this.assertEqual(await this.steps(), { Alpha: 0, Bravo: 0, Charlie: 0 });
    await this.move(bravo, alpha);
    this.assertEqual(await this.order(), ["Bravo", "Alpha", "Charlie"]);
    const snapshot = await this.session();
    this.assertEqual(snapshot.workspace_auto_order, {
      enabled: false,
      pause_after: 1,
      stale_after: 3,
      archive_after: 0,
    });
    // Idle times were kept all along: switching on sorts them out at once,
    // the active ones keeping their order.
    const file = JSON.parse(readFileSync(this.settingsFile, "utf8"));
    writeFileSync(this.settingsFile, JSON.stringify({ ...file, workspace_auto_order: true }));
    await this.run_cli("shutdown");
    await this.run_cli("start");
    await this.settle();
    const order = await this.order();
    this.assertEqual(order[0], "Bravo");
    this.assertEqual([...order].sort(), ["Alpha", "Bravo", "Charlie"]);
    const steps = await this.steps();
    this.assertTrue(steps.Bravo === 0 && steps.Alpha >= 1 && steps.Charlie >= 1, JSON.stringify(steps));
  }
}

registerCase("AutoOrder", AutoOrder);
