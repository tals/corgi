import { realpathSync } from "node:fs";
import { Viewers } from "./viewers";
import { Viewer } from "./viewer_client";
import { screen_text } from "./runtime";
import { registerCase } from "./support";
import * as layout from "../src/layout";

class Docking extends Viewers {
  mouse(view: Viewer, button: number, x: number, y: number, release = false) {
    return view.input(`\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`);
  }
  tab(view: Viewer, title: string) {
    const x = screen_text(view.state.data, 120, 36)[0].indexOf(title);
    this.assertGreater(x, -1);
    return x + 1;
  }
  async view(pane: number) {
    const view = await this.newViewer(120, 36);
    await view.action("sidebar");
    await view.focus(pane);
    return view;
  }
  async places(pane: number) {
    const snapshot = await this.session(),
      model = layout.Model.fromData(snapshot.workspaces[0].model),
      selection = new layout.Selection();
    selection.reconcile(model);
    selection.focus(model, pane);
    return new layout.View(model, selection).placements(new layout.Rect(0, 1, 120, 35));
  }
  async test_live_preview_commit_undo_redo_and_grip_extraction() {
    const a = await this.new("sleep 60", "Alpha"),
      b = await this.new("printf 'BETA_OUTPUT\\n'; sleep 60", "Beta"),
      view = await this.view(a);
    await this.until(async () =>
      (await this.command("pane.read", { target: b, view: "screen" })).text.includes("BETA_OUTPUT"),
    );
    const before = await this.session(),
      pids = before.panes.map((p: any) => p.pid);
    await this.mouse(view, 0, this.tab(view, "Beta"), 0);
    this.assertEqual(view.state.pane, a);
    await this.mouse(view, 32, 110, 16);
    this.assertIn("┄", view.state.data);
    this.assertIn("BETA_OUTPUT", view.state.data);
    const sourceSize = (snapshot: any) => {
      const pane = snapshot.panes.find((p: any) => p.id === b);
      return [pane.cols, pane.rows];
    };
    this.assertEqual(sourceSize(await this.session()), sourceSize(before));
    await this.mouse(view, 32, 20, 16);
    this.assertIn("BETA_OUTPUT", view.state.data);
    await this.mouse(view, 32, 110, 16);
    this.assertIn("BETA_OUTPUT", view.state.data);
    this.assertEqual((await this.session()).workspaces[0].model, before.workspaces[0].model);
    await this.mouse(view, 0, 110, 16, true);
    this.assertEqual((await this.session()).workspaces[0].model.tabs.length, 1);
    this.assertEqual(
      (await this.session()).panes.map((p: any) => p.pid),
      pids,
    );
    await view.action("undo-layout");
    this.assertEqual((await this.session()).workspaces[0].model.tabs.length, 2);
    await view.action("redo-layout");
    const right = (await this.places(b)).find(p => p.id === b)!;
    await this.mouse(view, 35, right.rect.x + Math.floor(right.rect.w / 2), right.rect.y - 1);
    this.assertIn("::", screen_text(view.state.data, 120, 36)[right.rect.y - 1]);
    await this.mouse(view, 35, right.rect.x + 2, right.rect.y);
    this.assertIn("::", screen_text(view.state.data, 120, 36)[right.rect.y - 1]);
    await this.mouse(view, 35, right.rect.x + 2, right.rect.y + 1);
    this.assertNotIn("::", screen_text(view.state.data, 120, 36)[right.rect.y - 1]);
    await this.mouse(view, 35, right.rect.x + 2, 0);
    this.assertNotIn("::", screen_text(view.state.data, 120, 36)[right.rect.y - 1]);
    await this.mouse(view, 0, right.rect.x + 4, right.rect.y - 1);
    await this.mouse(view, 32, 70, 0);
    await this.mouse(view, 0, 70, 0, true);
    this.assertEqual((await this.session()).workspaces[0].model.tabs.length, 2);
    this.assertEqual(
      (await this.session()).panes.map((p: any) => p.pid),
      pids,
    );
  }
  async test_nested_edges_and_middle_zone_in_both_orientations() {
    for (const direction of ["right", "down"]) {
      const a = await this.new("sleep 60", "Alpha"),
        b = (await this.command("pane.split", { target: a, direction, command: "sleep 60" })).pane;
      const source = await this.new("sleep 60", "Cargo"),
        view = await this.view(a);
      const before = await this.places(a),
        first = before.find(p => p.id === a)!,
        second = before.find(p => p.id === b)!;
      const x = direction === "right" ? 30 : 0,
        y = direction === "right" ? 35 : 9;
      await this.mouse(view, 0, this.tab(view, "Cargo"), 0);
      await this.mouse(view, 32, direction === "right" ? 60 : 0, direction === "right" ? 35 : 18);
      await this.mouse(view, 32, x, y);
      await this.mouse(view, 0, x, y, true);
      const after = await this.places(source);
      this.assertEqual(
        after.find(p => p.id === b),
        second,
      );
      this.assertEqual(
        direction === "right" ? after.find(p => p.id === source)!.rect.w : after.find(p => p.id === source)!.rect.h,
        direction === "right" ? first.rect.w : first.rect.h,
      );
      await view.action("undo-layout");
      await this.mouse(view, 0, this.tab(view, "Cargo"), 0);
      await this.mouse(view, 32, direction === "right" ? 60 : 0, direction === "right" ? 35 : 18);
      await this.mouse(view, 0, direction === "right" ? 60 : 0, direction === "right" ? 35 : 18, true);
      const whole = (await this.places(source)).find(p => p.id === source)!;
      this.assertEqual(direction === "right" ? whole.rect.w : whole.rect.h, direction === "right" ? 118 : 33);
      await view.close();
      for (const id of [a, b, source]) await this.command("pane.close", { target: id });
    }
  }
  async test_self_drop_starts_a_shell_at_the_path_and_undo_keeps_it_alive() {
    const a = await this.new("sleep 60", "Alpha"),
      b = await this.new("sleep 60", "Beta"),
      view = await this.view(a);
    await this.mouse(view, 0, this.tab(view, "Beta"), 0);
    await this.mouse(view, 32, 110, 16);
    await this.mouse(view, 0, 110, 16, true);
    await this.mouse(view, 0, this.tab(view, "Alpha"), 0);
    await this.mouse(view, 32, 110, 16);
    this.assertIn("shell at", view.state.data);
    this.assertEqual((await this.session()).panes.length, 2);
    await this.mouse(view, 0, 110, 16, true);
    const created = view.state.pane;
    this.assertNotEqual(created, a);
    const shell = (await this.session()).panes.find((p: any) => p.id === created);
    this.assertEqual(shell.cwd, realpathSync(this.temp.name));
    await this.command("pane.send", { target: created, text: "printf SHELL_READY", enter: true });
    await this.until(async () =>
      (await this.command("pane.read", { target: created, view: "screen" })).text.includes("SHELL_READY"),
    );
    await view.action("undo-layout");
    let now = await this.session();
    this.assertEqual(now.workspaces[0].model.tabs.length, 2);
    this.assertEqual(now.panes.find((p: any) => p.id === created).pid, shell.pid);
    await view.action("undo-layout");
    now = await this.session();
    this.assertEqual(now.workspaces[0].model.tabs.length, 3);
    this.assertEqual(view.state.pane, a);
    this.assertEqual(now.panes.find((p: any) => p.id === created).pid, shell.pid);
    await view.action("redo-layout");
    this.assertEqual(view.state.pane, b);
    await view.action("redo-layout");
    now = await this.session();
    this.assertEqual(now.workspaces[0].model.tabs.length, 1);
    this.assertEqual(now.panes.find((p: any) => p.id === created).pid, shell.pid);
  }
  async test_hover_switch_cancel_resize_and_pane_swap() {
    const a = await this.new("sleep 60", "Alpha"),
      b = await this.new("sleep 60", "Beta"),
      view = await this.view(a);
    const before = (await this.session()).workspaces[0].model;
    await this.mouse(view, 0, this.tab(view, "Alpha"), 0);
    await this.mouse(view, 32, this.tab(view, "Beta"), 0);
    await view.advance(0.6);
    this.assertEqual(view.state.pane, b);
    await this.mouse(view, 32, 110, 16);
    await view.input("\x1b");
    await view.advance(0.1);
    await this.mouse(view, 0, 110, 16, true);
    this.assertEqual(view.state.pane, a);
    this.assertEqual((await this.session()).workspaces[0].model, before);
    await this.mouse(view, 0, this.tab(view, "Beta"), 0);
    await this.mouse(view, 32, 110, 16);
    await view.request({ op: "size", cols: 121, rows: 36 });
    await this.mouse(view, 0, 110, 16, true);
    this.assertEqual((await this.session()).workspaces[0].model, before);
    await view.request({ op: "size", cols: 120, rows: 36 });
    await this.mouse(view, 0, this.tab(view, "Beta"), 0);
    await this.mouse(view, 32, 110, 16);
    await this.mouse(view, 0, 110, 16, true);
    const places = await this.places(b),
      left = places.find(p => p.id === a)!,
      right = places.find(p => p.id === b)!;
    await this.mouse(view, 0, right.rect.x + 4, right.rect.y - 1);
    await this.mouse(view, 32, left.rect.x, 18);
    await this.mouse(view, 32, left.rect.x + Math.floor(left.rect.w / 2), 18);
    await this.mouse(view, 0, left.rect.x + Math.floor(left.rect.w / 2), 18, true);
    this.assertEqual((await this.places(b)).find(p => p.id === b)!.rect, left.rect);
    await view.input("\x02\x1a");
    this.assertEqual((await this.places(b)).find(p => p.id === b)!.rect, right.rect);
    await view.input("\x02\x19");
    this.assertEqual((await this.places(b)).find(p => p.id === b)!.rect, left.rect);
  }
  async test_cancel_and_shared_layout_changes_never_commit_a_stale_drop() {
    const a = await this.new("sleep 60", "Alpha"),
      b = await this.new("sleep 60", "Beta"),
      view = await this.view(a);
    const original = (await this.session()).workspaces[0].model;
    for (const cancel of ["\x1b", "\x1b[O", "\x1b[<2;100;15M", "\x1b[<35;100;15M"]) {
      await this.mouse(view, 0, this.tab(view, "Beta"), 0);
      await this.mouse(view, 32, 110, 16);
      await view.input(cancel);
      await view.advance(0.1);
      await this.mouse(view, 0, 110, 16, true);
      this.assertEqual((await this.session()).workspaces[0].model, original);
      await view.input("\x1b[I");
    }
    await this.mouse(view, 0, this.tab(view, "Beta"), 0);
    await this.mouse(view, 32, 110, 16);
    const peer = await this.newViewer();
    await peer.focus(a);
    await peer.action("split", "down");
    const changed = (await this.session()).workspaces[0].model;
    await view.poll();
    await this.mouse(view, 0, 110, 16, true);
    this.assertEqual((await this.session()).workspaces[0].model, changed);
    await this.mouse(view, 0, this.tab(view, "Beta"), 0);
    await this.mouse(view, 32, 110, 16);
    await this.command("pane.close", { target: b });
    await view.poll();
    await this.mouse(view, 0, 110, 16, true);
    this.assertFalse((await this.session()).panes.some((p: any) => p.id === b));
  }
  async test_copy_mode_allows_tab_clicks_and_cancels_docking() {
    const a = await this.new("sleep 60", "Alpha"),
      b = await this.new("sleep 60", "Beta"),
      view = await this.view(a),
      original = (await this.session()).workspaces[0].model;
    await view.action("copy-mode");
    await this.mouse(view, 0, this.tab(view, "Beta"), 0);
    await this.mouse(view, 0, this.tab(view, "Beta"), 0, true);
    this.assertEqual(view.state.pane, b);
    await view.focus(a);
    await view.action("copy-mode");
    await this.mouse(view, 0, this.tab(view, "Beta"), 0);
    await this.mouse(view, 32, 110, 16);
    await this.mouse(view, 0, 110, 16, true);
    this.assertEqual(view.state.pane, a);
    this.assertEqual((await this.session()).workspaces[0].model, original);
  }
}
registerCase("Docking", Docking, { inherited: false });
