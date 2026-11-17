import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Viewers } from "./viewers";
import { PALETTE, screen_text } from "./runtime";
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
    // With archive Off, nothing is archived however long it idles: Delta has
    // been stale for minutes with nothing holding it back.
    this.assertEqual((await this.session()).workspace_auto_order.archive_after, 0);
    this.assertEqual(await this.archived(), []);
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

  async test_a_reload_keeps_the_pause_going() {
    const [alpha] = await this.workspaces("Alpha", "Bravo");
    const a = await this.agent(alpha);
    await this.work(a);
    await this.age(140);
    // Alpha's agent stops with Bravo 40 s short of stale, and a reload comes
    // 10 s later: the 50 s of the pause still to come count, as without it.
    await this.stop(a);
    await this.age(10);
    await this.rpc({ op: "server.reload", executable: EXE });
    this.assertEqual((await this.steps()).Bravo, 0);
    await this.age(60);
    this.assertTrue((await this.steps()).Bravo >= 1, JSON.stringify(await this.steps()));
  }

  async archived() {
    return (await this.session()).workspaces
      .filter((w: any) => w.archived)
      .map((w: any) => w.name)
      .sort();
  }
  log() {
    return readFileSync(join(this.temp.name, "server.log"), "utf8");
  }
  /** Has `viewer` show `workspace`, as it tells the daemon on its next sync. */
  async show(viewer: Viewer, workspace: number) {
    await this.rpc({ op: "workspace.switch", workspace });
    await this.until(async () => {
      await viewer.poll();
      return (await this.rpc({ op: "viewer.list" })).viewers[0].workspace === workspace;
    });
  }

  async test_long_idle_workspaces_are_archived_unless_something_holds_them() {
    await this.reconfigure({ workspace_stale_after: 2 });
    const [alpha, bravo, charlie, delta, echo] = await this.workspaces("Alpha", "Bravo", "Charlie", "Delta", "Echo");
    // With archive Off at first, the others idle past the "archive after" to come.
    await this.work(await this.agent(alpha));
    await this.age(260);
    await this.reconfigure({ workspace_archive_after: 4 });
    // The pane was recovered asleep; a new agent keeps the clock going.
    const a = await this.agent(alpha);
    // Charlie runs a program, Echo's agent waits on a permission prompt,
    // and a viewer shows Delta.
    const sleeper = (
      await this.command("pane.create", { workspace: charlie, cwd: this.temp.name, command: "sleep 600" })
    ).pane;
    const e = await this.agent(echo);
    await this.hook(e, "PermissionRequest");
    const viewer = await this.newViewer(100, 40);
    await this.show(viewer, delta);
    await this.work(a);
    // Switching archive on, here by a restart, waits a full "archive after"
    // first, though Bravo has idled longer.
    await this.age(200);
    this.assertEqual(await this.archived(), []);
    await this.age(100);
    this.assertEqual(await this.archived(), ["Bravo"]);
    const bravo_row = (await this.session()).workspaces.find((w: any) => w.id === bravo);
    this.assertTrue(bravo_row.auto_archived, JSON.stringify(bravo_row));
    this.assertIn("Auto-archived workspace", this.log());
    // The viewer showing Delta heard about it.
    await viewer.poll();
    this.assertIn("Auto-archived Bravo", screen_text(viewer.state.data, 100, 40).join("\n"));
    // The others wait in the darkest gray, each reason logged once.
    const steps = await this.steps();
    this.assertEqual([steps.Charlie, steps.Delta, steps.Echo], [5, 5, 5]);
    await this.age(120);
    this.assertEqual(await this.archived(), ["Bravo"]);
    for (const reason of ["running-process", "on-screen", "waiting-agent"])
      this.assertEqual(this.log().split(`"reason":"${reason}"`).length - 1, 1);
    // Each goes once what held it back is gone. Echo's agent, answered,
    // goes back to work, which makes Echo active again.
    await this.command("pane.close", { target: sleeper });
    await this.show(viewer, alpha);
    await this.hook(e, "PostToolUse");
    await this.stop(e);
    await this.age(70);
    this.assertEqual(await this.archived(), ["Bravo", "Charlie", "Delta"]);
    this.assertEqual((await this.steps()).Echo, 0);
    await this.age(260);
    this.assertEqual(await this.archived(), ["Bravo", "Charlie", "Delta", "Echo"]);
    // Unarchived, a workspace joins the end of the active group with its agents resumable.
    await this.command("workspace.unarchive", { target: echo });
    await this.settle();
    this.assertEqual(await this.order(), ["Alpha", "Echo"]);
    const back = (await this.session()).workspaces.find((w: any) => w.id === echo);
    this.assertEqual([back.auto_archived, back.stale_step], [false, 0]);
    this.assertTrue(
      (await this.session()).panes.some((p: any) => p.id === e && p.dormant),
      "the agent's pane waits to be resumed",
    );
  }

  async test_switching_on_waits_a_full_archive_after() {
    await this.reconfigure({ workspace_auto_order: false, workspace_stale_after: 2, workspace_archive_after: 4 });
    const [alpha] = await this.workspaces("Alpha", "Bravo");
    const a = await this.agent(alpha);
    await this.work(a);
    await this.age(360);
    this.assertEqual(await this.archived(), []);
    await this.reconfigure({ workspace_auto_order: true });
    // The pane was recovered asleep; a new agent keeps the clock going.
    const b = await this.agent(alpha);
    await this.work(b);
    await this.age(200);
    this.assertEqual(await this.archived(), []);
    this.assertEqual((await this.steps()).Bravo, 5);
    await this.age(60);
    this.assertEqual(await this.archived(), ["Bravo"]);
  }

  async test_configure_applies_at_once_persists_and_refuses_thresholds_out_of_order() {
    await this.reconfigure({ workspace_auto_order: false });
    const [alpha] = await this.workspaces("Alpha", "Bravo");
    const a = await this.agent(alpha);
    await this.work(a);
    await this.age(200);
    const first = await this.newViewer(100, 40),
      second = await this.newViewer(100, 40);
    this.assertEqual((await this.steps()).Bravo, 0);
    const reply = await this.rpc({ op: "workspace_auto_order.configure", enabled: true, stale_after: 2 });
    this.assertEqual(reply.workspace_auto_order, { enabled: true, pause_after: 1, stale_after: 2, archive_after: 0 });
    await this.settle();
    // Both viewers fade the stale workspace at once: its name is no longer
    // in the usual gray.
    this.assertTrue((await this.steps()).Bravo >= 1);
    for (const viewer of [first, second]) {
      await viewer.poll();
      const drawn = /((?:\x1b\[[\d;]*m)+)Bravo/.exec(viewer.state.data);
      this.assertTrue(drawn !== null && !drawn[1].includes(`38;2;${PALETTE.muted}m`), JSON.stringify(drawn?.[1]));
    }
    const saved = JSON.parse(readFileSync(this.settingsFile, "utf8"));
    this.assertEqual(
      [saved.workspace_auto_order, saved.workspace_stale_after, saved.workspace_archive_after],
      [true, 2, "off"],
    );
    // Out of order: refused, and nothing changes.
    const refused = await this.raw_rpc({ op: "workspace_auto_order.configure", pause_after: 5 });
    this.assertEqual(refused.err, "InvalidThresholds");
    this.assertEqual(JSON.parse(readFileSync(this.settingsFile, "utf8")).workspace_pause_after, 1);
    // A restart keeps them; a malformed value falls back on its own, and
    // thresholds out of order all do.
    await this.run_cli("shutdown");
    await this.run_cli("start");
    this.assertEqual((await this.session()).workspace_auto_order.stale_after, 2);
    await this.reconfigure({ workspace_stale_after: "soon" });
    this.assertEqual((await this.session()).workspace_auto_order, {
      enabled: true,
      pause_after: 1,
      stale_after: 10,
      archive_after: 0,
    });
    await this.reconfigure({ workspace_stale_after: 2, workspace_pause_after: 30 });
    this.assertEqual((await this.session()).workspace_auto_order, {
      enabled: true,
      pause_after: 5,
      stale_after: 10,
      archive_after: 480,
    });
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
