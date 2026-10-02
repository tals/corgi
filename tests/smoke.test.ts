/** Real PTY/socket regressions. Provider doubles never make inference requests. */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
  unlinkSync,
  realpathSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { createConnection } from "node:net";
import { createHash } from "node:crypto";
import {
  Runtime,
  Viewer,
  ROOT,
  EXE,
  FAKE,
  screen_text,
  scrollbar,
  layout_tree,
} from "./runtime";
import {
  TestCase,
  registerCase,
  run,
  sleep,
  quote,
  shellJoin,
  tempDir,
  writeExecutable,
  JsonSocket,
  Pty,
  deadline,
} from "./support";

class Smoke extends Runtime {
  async focused() {
    return (await this.panes()).find((p: any) => p.focused);
  }
  async pane(id: number) {
    return (await this.session()).panes.find((p: any) => p.id === id);
  }
  folder(name: string) {
    const path = join(this.temp.name, name);
    mkdirSync(path);
    return path;
  }
  async choose_terminal(cols = 80, rows = 24) {
    await this.frame_with("New terminal", cols, rows);
    await this.input("t");
  }
  async test_runtime_protocol_negotiates_and_rejects_before_mutating() {
    const hello = await this.raw_rpc({ op: "hello", protocol: 1 });
    this.assertEqual(hello.type, "hello");
    this.assertIn("pane.surface", hello.capabilities);
    this.assertNotIn("handoff", hello.capabilities);
    const ws = (await this.workspaces())[0].id;
    for (const protocol of [0, 2, -1, "1"])
      this.assertEqual(
        (
          await this.raw_rpc({
            op: "session.command",
            command: { "pane.create": { workspace: ws } },
            protocol,
          })
        ).err,
        "UnsupportedProtocol",
      );
    this.assertEqual(
      (await this.raw_rpc({ op: "session.snapshot" })).err,
      "ProtocolRequired",
    );
    this.assertEqual((await this.session()).panes, []);
    const socket = await JsonSocket.connect(this.path);
    try {
      this.assertEqual(
        (await socket.request({ op: "hello", protocol: 1 })).protocol,
        1,
      );
      this.assertEqual(
        (await socket.request({ op: "session.snapshot" })).type,
        "session",
      );
    } finally {
      socket.close();
    }
  }
  async test_runtime_operations_target_ids_without_changing_selection() {
    const first = (await this.open_pane({ command: "sleep 30" })).pane,
      second = (await this.open_pane({ command: "sleep 30" })).pane;
    const original = await this.session(),
      ws = original.workspaces[0].id,
      before = original.panes.find((p: any) => p.id === first);
    const third = (
      await this.command("pane.create", {
        workspace: ws,
        title: "third",
        command: "sleep 30",
      })
    ).pane;
    const split = (
      await this.command("pane.split", {
        command: "sleep 30",
        target: first,
        direction: "right",
      })
    ).pane;
    await this.command("tab.rename", {
      target: before.tab,
      name: "background",
    });
    await this.command("split.resize", { direction: "right", target: first });
    this.assertEqual((await this.focused()).id, second);
    const snap = await this.session();
    this.assertEqual(
      new Set(snap.panes.map((p: any) => p.id)),
      new Set([first, second, third, split]),
    );
    this.assertEqual(
      snap.panes.find((p: any) => p.id === first).pid,
      before.pid,
    );
    this.assertEqual(
      snap.panes.find((p: any) => p.id === first).cols,
      before.cols,
    );
    await this.client!.focus(first);
    await this.client!.poll();
    const visible = (await this.session()).panes.filter((p: any) =>
      [first, split].includes(p.id),
    );
    this.assertEqual(
      visible.reduce((n: number, p: any) => n + p.cols, 0) + 3,
      before.cols,
    );
    await this.client!.focus(second);
    const tab = snap.workspaces[0].model.tabs.find(
      (t: any) => t.id === before.tab,
    );
    this.assertEqual(tab.title, "background");
    this.assertEqual(layout_tree(snap.workspaces[0]).split, {
      axis: "horizontal",
      ratio: 540,
      first: { pane: first },
      second: { pane: split },
    });
    this.assertNotIn("active", snap.workspaces[0]);
    this.assertNotIn("focus", tab);
    this.assertNotIn("focused", snap.panes[0]);
    await this.command("pane.close", { target: split });
    this.assertEqual((await this.focused()).id, second);
    let survivor = await this.pane(first);
    const last = visible.find((p: any) => p.id === first);
    this.assertEqual([survivor.cols, survivor.rows], [last.cols, last.rows]);
    await this.client!.focus(first);
    await this.client!.poll();
    survivor = await this.pane(first);
    this.assertEqual(
      [survivor.cols, survivor.rows],
      [before.cols, before.rows],
    );
  }
  async test_runtime_target_failure_does_not_change_layout_or_focus() {
    const pane = (await this.open_pane({ command: "sleep 30" })).pane,
      before = await this.session(),
      ws = before.workspaces[0].id;
    for (const command of [
      { "pane.split": { target: pane, direction: "bad" } },
      { "pane.split": { target: 999, direction: "right" } },
      { "pane.create": { workspace: ws, cwd: this.temp.name + "/missing" } },
      { "pane.create": { workspace: 999 } },
      { "pane.close": { target: -1 } },
      { "pane.input": { data: 42, target: pane } },
      { "tab.rename": { name: "missing target" } },
    ])
      this.assertIn(
        "err",
        await this.raw_rpc({ op: "session.command", protocol: 1, command }),
      );
    const after = await this.session();
    this.assertEqual(after.workspaces, before.workspaces);
    this.assertEqual(
      after.panes.map((p: any) => p.id),
      [pane],
    );
    this.assertEqual((await this.focused()).id, pane);
  }
  async test_runtime_surface_and_input_do_not_switch_to_the_target() {
    const first = (
      await this.open_pane({
        command: "printf '\\033[31m界é\\033[0m\\n'; exec /bin/sh",
      })
    ).pane;
    const second = (await this.open_pane({ command: "sleep 30" })).pane;
    await this.until(async () =>
      (
        await this.command("pane.read", { target: first, view: "screen" })
      ).text.includes("界é"),
    );
    await this.command("pane.input", {
      data: "printf 'DIRECT_INPUT_OK\\n'\r",
      target: first,
    });
    await this.until(async () =>
      (
        await this.command("pane.read", { target: first, view: "screen" })
      ).text.includes("DIRECT_INPUT_OK"),
    );
    const response = await this.rpc({
        op: "pane.surface",
        protocol: 1,
        pane: first,
      }),
      surface = response.surface;
    this.assertEqual(response.type, "surface");
    this.assertEqual(surface.pane, first);
    this.assertEqual(surface.lines.length, surface.rows);
    this.assertIn("界é", surface.lines.join(""));
    this.assertIn("DIRECT_INPUT_OK", surface.lines.join(""));
    this.assertTrue(
      surface.lines.every((line: string) => line.endsWith("\x1b[0m")),
    );
    this.assertEqual((await this.focused()).id, second);
  }
  async test_runtime_subscription_survives_idle_and_receives_changes() {
    await this.open_pane({ command: "sleep 30" });
    const socket = await JsonSocket.connect(this.path);
    try {
      const initial = await socket.request({
        op: "session.subscribe",
        protocol: 1,
      });
      this.assertEqual(initial.type, "session");
      await sleep(5.2);
      const pane = (await this.open_pane({ command: "sleep 30" })).pane;
      let update: any;
      for (let i = 0; i < 20; i++) {
        update = await socket.read();
        if (update.panes.some((p: any) => p.id === pane)) break;
      }
      this.assertTrue(
        update.panes.some((p: any) => p.id === pane),
        "subscription did not receive created pane",
      );
      this.assertGreater(update.revision, initial.revision);
      this.assertEqual(update.server_pid, initial.server_pid);
    } finally {
      socket.close();
    }
  }
  async test_workspaces_isolate_tabs_preserve_focus_and_default_folders() {
    const one = this.folder("one"),
      two = this.folder("two");
    const first = (await this.open_pane({ cwd: one, command: "sleep 30" }))
        .pane,
      home = (await this.workspaces())[0].id;
    await this.attach();
    await this.frame_with("workspaces");
    const ws = (await this.new_workspace({ name: "Second", cwd: two }))
        .workspace,
      second = (await this.focused()).id;
    this.assertNotEqual(first, second);
    this.assertEqual(
      new Set((await this.panes()).map((p: any) => p.workspace)),
      new Set([home, ws]),
    );
    this.assertEqual((await this.pane(second)).cwd, realpathSync(two));
    await this.rpc({ op: "action", name: "new" });
    await this.choose_terminal();
    const third = (await this.focused()).id;
    await this.rpc({ op: "action", name: "split", value: "right" });
    const fourth = (await this.focused()).id;
    this.assertEqual(new Set([first, second, third, fourth]).size, 4);
    this.assertEqual(await this.tab_count(), 2);
    await this.rpc({ op: "workspace.switch", workspace: home });
    this.assertEqual(await this.tab_count(), 1);
    this.assertEqual((await this.focused()).id, first);
    await this.rpc({ op: "workspace.switch", workspace: ws });
    this.assertEqual((await this.focused()).id, fourth);
    await this.command("workspace.edit", { name: "Renamed", target: ws });
    await this.open_pane({ command: "sleep 30" });
    this.assertEqual((await this.focused()).cwd, realpathSync(two));
    this.assertEqual((await this.pane(second)).cwd, realpathSync(two));
    await this.rpc({ op: "focus", pane: first });
    this.assertEqual(
      (await this.workspaces()).find((w: any) => w.active).id,
      home,
    );
  }
  async test_new_tabs_and_splits_inherit_current_pane_directory() {
    const one = this.folder("one"),
      two = this.folder("two"),
      three = this.folder("three");
    const first = (await this.open_pane({ cwd: one, command: "exec /bin/sh" }))
        .pane,
      second = (await this.open_pane({ cwd: two, command: "exec /bin/sh" }))
        .pane;
    await this.command("pane.input", {
      target: second,
      data: `cd ${quote(three)}\r`,
    });
    await this.until(
      async () => (await this.pane(second)).cwd === realpathSync(three),
    );
    await this.rpc({ op: "action", name: "new" });
    this.assertEqual((await this.focused()).cwd, realpathSync(three));
    await this.rpc({ op: "action", name: "split", value: "right" });
    this.assertEqual((await this.focused()).cwd, realpathSync(three));
    const targeted = (
      await this.command("pane.split", { target: first, direction: "right" })
    ).pane;
    this.assertEqual((await this.pane(targeted)).cwd, realpathSync(one));
    const inherited = (await this.open_pane()).pane;
    this.assertEqual((await this.pane(inherited)).cwd, realpathSync(three));
    const explicit = (await this.split_pane("right", { cwd: two })).pane;
    this.assertEqual((await this.pane(explicit)).cwd, realpathSync(two));
  }
  async test_workspace_name_follows_first_tab_and_custom_name_can_be_cleared() {
    const one = this.folder("one"),
      two = this.folder("two"),
      three = this.folder("three");
    const first = (await this.open_pane({ cwd: one, command: "exec /bin/sh" }))
      .pane;
    await this.until(async () => (await this.workspaces())[0].name === "one");
    const second = (await this.open_pane({ cwd: two, command: "exec /bin/sh" }))
      .pane;
    this.assertEqual((await this.workspaces())[0].name, "one");
    await this.command("pane.input", {
      target: first,
      data: `cd ${quote(three)}\r`,
    });
    await this.until(async () => (await this.workspaces())[0].name === "three");
    this.assertEqual((await this.workspaces())[0].cwd, realpathSync(three));
    await this.rpc({ op: "action", name: "move-tab", value: "left" });
    await this.until(async () => (await this.workspaces())[0].name === "two");
    const ws = (await this.workspaces())[0].id;
    await this.command("workspace.edit", { name: "Custom", target: ws });
    await this.command("pane.input", {
      target: second,
      data: `cd ${quote(one)}\r`,
    });
    await this.until(
      async () => (await this.workspaces())[0].cwd === realpathSync(one),
    );
    this.assertEqual((await this.workspaces())[0].name, "Custom");
    await this.attach();
    this.assertNotIn("📌", (await this.frame_with("Custom")).join("\n"));
    await this.input("\x02W");
    await this.frame_with("edit workspace: name");
    await this.input("\x03\r");
    await this.frame_with("one");
    await this.until(async () => (await this.workspaces())[0].name === "one");
    await this.command("pane.close", { target: second });
    await this.until(async () => (await this.workspaces())[0].name === "three");
    await this.restart_runtime();
    this.assertEqual((await this.workspaces())[0].name, "three");
    this.assertNotIn("pinned", (await this.workspaces())[0]);
    this.assertEqual(
      JSON.parse(readFileSync(this.path + ".workspaces.json", "utf8"))
        .workspaces[0].name,
      "",
    );
  }
  async test_workspace_metadata_survives_restart() {
    const folder = this.folder("项目 café"),
      home = (await this.workspaces())[0].id;
    const ws = (await this.new_workspace({ name: "Project", cwd: folder }))
      .workspace;
    await this.attach();
    await this.command("workspace.edit", { name: "Renamed", target: ws });
    await this.rpc({ op: "workspace.switch", workspace: home });
    const before = await this.workspaces();
    await this.restart_runtime();
    await this.attach();
    this.assertEqual(await this.workspaces(), before);
    await this.rpc({ op: "workspace.switch", workspace: ws });
    await this.attach();
    await this.frame_with("Renamed");
    this.assertEqual((await this.panes())[0].cwd, realpathSync(folder));
    await this.command("workspace.close", { target: home });
    await this.restart_runtime();
    await this.attach();
    this.assertEqual(
      (await this.workspaces()).map((w: any) => w.id),
      [ws],
    );
    this.assertTrue((await this.workspaces())[0].active);
    this.assertGreater(
      (await this.new_workspace({ name: "New" })).workspace,
      ws,
    );
  }
  async test_hidden_workspace_exit_and_undo_do_not_disturb_active_pane() {
    const pane = (
        await this.open_pane({ cwd: this.temp.name, command: "exec /bin/sh" })
      ).pane,
      home = (await this.workspaces())[0].id;
    const ws = (
        await this.new_workspace({ name: "Other", cwd: this.temp.name })
      ).workspace,
      active = (await this.focused()).id;
    await this.attach();
    await this.frame_with("Other");
    await this.command("pane.input", { target: pane, data: "exit\r" });
    await this.until(async () =>
      (await this.panes()).every((p: any) => p.id !== pane),
    );
    this.assertEqual((await this.focused()).id, active);
    this.assertEqual(
      (await this.workspaces()).find((w: any) => w.active).id,
      ws,
    );
    await this.rpc({ op: "action", name: "undo-close" });
    this.assertEqual(
      (await this.workspaces()).find((w: any) => w.active).id,
      home,
    );
    await this.frame_with("restored output");
  }
  async test_workspace_sidebar_create_edit_switch_and_agents() {
    this.folder("项目 café");
    const first = (
      await this.open_pane({ cwd: this.temp.name, command: "sleep 30" })
    ).pane;
    await this.rpc({
      op: "hook",
      pane: first,
      provider: "claude",
      seq: 1,
      event: { hook_event_name: "SessionStart", session_id: "first" },
    });
    await this.attach();
    let screen = await this.agent_frame("claude", "○");
    this.assertTrue(screen[0].startsWith(" workspaces"));
    this.assertTrue(screen[11].startsWith(" agents"));
    await this.click(21, 1);
    await this.frame_with("new workspace: name");
    await this.input("Project\r");
    await this.frame_with("No agents yet");
    const ws = (await this.workspaces()).find((w: any) => w.active);
    this.assertEqual(
      [ws.name, ws.cwd],
      ["Project", realpathSync(this.temp.name)],
    );
    await this.click(4, 3);
    await this.agent_frame("claude", "○");
    this.assertEqual((await this.focused()).id, first);
    await this.input("\x1b[<2;4;6M\x1b[<2;4;6m");
    await this.click_text(await this.frame_with("|Rename"), "Rename");
    await this.frame_with("edit workspace: name");
    await this.input("Edited\r");
    screen = await this.frame_with("Edited");
    this.assertNotIn("workspace: default folder", screen.join("\n"));
    this.assertNotIn("edit workspace: name", screen.join("\n"));
    const edited = (await this.workspaces()).find((w: any) => w.id === ws.id);
    this.assertEqual(
      [edited.name, edited.cwd],
      ["Edited", realpathSync(this.temp.name)],
    );
    await this.input("\x02}");
    await this.frame_with("No agents yet");
    this.assertEqual(
      (await this.workspaces()).find((w: any) => w.active).id,
      ws.id,
    );
  }
  async test_workspace_and_agent_lists_scroll_independently() {
    await this.open_pane({ cwd: this.temp.name, command: "sleep 30" });
    for (let i = 0; i < 6; i++)
      await this.new_workspace({ name: `Group-${i}`, cwd: this.temp.name });
    for (let i = 0; i < 6; i++) {
      const pane = (
        await this.open_pane({ cwd: this.temp.name, command: "sleep 30" })
      ).pane;
      await this.rpc({
        op: "hook",
        pane,
        provider: "claude",
        seq: 1,
        event: { hook_event_name: "SessionStart", session_id: String(i) },
      });
    }
    await this.attach();
    let screen = await this.frame_with("Group-4");
    this.assertIn("Group-5", screen[5]);
    this.assertIn("<  >", screen[9]);
    await this.scrollbar_with("┃┃┃┃┃┃┃┃┃┃│");
    await this.input("\x1b[<65;5;15M");
    screen = await this.scrollbar_with("│┃┃┃┃┃┃┃┃┃┃");
    this.assertIn("Group-4", screen[2]);
    this.assertIn("Group-5", screen[5]);
    await this.input("\x1b[<64;5;5M");
    screen = await this.frame_with("Group-3");
    this.assertIn("Group-4", screen[5]);
    await this.input("\x1b[<64;5;5M".repeat(2));
    screen = await this.frame_with("Group-1");
    this.assertEqual(scrollbar(screen), "│┃┃┃┃┃┃┃┃┃┃");
    await this.click_text(
      screen.map((r) => r.slice(0, 27)),
      "Group-1",
    );
    this.assertEqual(
      (await this.workspaces()).find((w: any) => w.active).name,
      "Group-1",
    );
    await this.frame_with("No agents yet");
  }
  async test_native_sessions_belong_to_their_workspace() {
    await this.open_pane({ cwd: this.temp.name, command: "sleep 30" });
    const original = (await this.workspaces())[0].id;
    await this.rpc({
      op: "native.start",
      provider: "codex",
      cwd: this.temp.name,
    });
    await this.attach();
    await this.agent_frame("codex", "○");
    await this.new_workspace({ name: "Other", cwd: this.temp.name });
    await this.frame_with("No agents yet");
    await this.rpc({ op: "workspace.switch", workspace: original });
    await this.agent_frame("codex", "○");
  }
  async test_workspace_invalid_folder_and_empty_close() {
    const first = (
        await this.open_pane({ cwd: this.temp.name, command: "sleep 30" })
      ).pane,
      before = await this.workspaces();
    this.assertNotEqual(
      (
        await run(
          [
            EXE,
            "workspace",
            "new",
            "Bad",
            "--cwd",
            this.temp.name + "/missing",
          ],
          { env: this.env, check: false },
        )
      ).code,
      0,
    );
    this.assertEqual(await this.workspaces(), before);
    const ws = (
        await this.new_workspace({ name: "Empty", cwd: this.temp.name })
      ).workspace,
      pane = (await this.focused()).id;
    await this.command("pane.close", { target: pane });
    await this.command("workspace.close", { target: ws });
    this.assertEqual((await this.workspaces()).length, 1);
    this.assertEqual((await this.focused()).id, first);
  }
  async test_synchronized_redraw_keeps_completed_frame_and_cursor() {
    const begin = join(this.temp.name, "begin"),
      middle = join(this.temp.name, "middle"),
      finish = join(this.temp.name, "finish");
    const fixture = writeExecutable(
      join(this.temp.name, "sync"),
      `import {existsSync,writeFileSync} from 'node:fs';
const emit=s=>process.stdout.write(s); const wait=async name=>{while(!existsSync(name))await Bun.sleep(5)};
emit('\x1b[2J\x1b[5;5HREADY\x1b[5;5H\x1b[?25h'); await wait('begin');
emit('\x1b[?2026h\x1b[2;20HMID_SYNC\x1b[2;20H');writeFileSync('middle','');await wait('finish');
emit('\x1b[2;20H        \x1b[5;5HDONE_SYNC\x1b[5;5H\x1b[?2026l');await Bun.sleep(30000);`,
    );
    const pane = (
      await this.open_pane({ cwd: this.temp.name, command: quote(fixture) })
    ).pane;
    await this.attach();
    let frame = "";
    await this.until(async () => {
      frame = (await this.get_type("frame")).data;
      return frame.includes("READY");
    });
    const cursors = (s: string) =>
      [...s.matchAll(/\x1b\[(\d+);(\d+)H\x1b\[\?25h/g)].map((m) => m.slice(1));
    const cursor = cursors(frame);
    this.assertTrue(cursor.length);
    writeFileSync(begin, "");
    await this.until(() => existsSync(middle));
    for (let i = 0; i < 3; i++) {
      this.assertNotIn(
        "MID_SYNC",
        (await this.command("pane.read", { target: pane, view: "screen" }))
          .text,
      );
      await this.write({ op: "size", cols: 80, rows: 24 });
      frame = (await this.get_type("frame")).data;
      this.assertIn("READY", frame);
      this.assertNotIn("MID_SYNC", frame);
      this.assertEqual(cursor, cursors(frame));
    }
    writeFileSync(finish, "");
    await this.until(async () => {
      frame = (await this.get_type("frame")).data;
      this.assertNotIn("MID_SYNC", frame);
      return frame.includes("DONE_SYNC");
    });
    this.assertEqual(cursor, cursors(frame));
  }
  async test_mouse_tab_reorder_indicator_and_cancellation() {
    const first = (
      await this.open_pane({ cwd: this.temp.name, title: "First" })
    ).pane;
    await this.open_pane({ cwd: this.temp.name, title: "Second" });
    await this.open_pane({ cwd: this.temp.name, title: "Third" });
    await this.attach();
    let screen = await this.tabs_are("First Second Third");
    const dragFrame = async () => {
      for (let i = 0; i < 100; i++) {
        const frame = screen_text((await this.get_type("frame")).data);
        if (frame[0].slice(28).includes("│")) return frame;
      }
      this.fail("missing tab drop indicator");
    };
    let x = screen[0].indexOf("First") + 1;
    const end = screen[0].lastIndexOf(" + ") + 1;
    await this.input(`\x1b[<0;${x};1M\x1b[<32;${end};1M`);
    screen = await dragFrame();
    this.assertEqual(screen[0][end - 2], "│");
    await this.input(`\x1b[<0;${end};1m`);
    screen = await this.tabs_are("Second Third First");
    this.assertEqual((await this.focused()).id, first);
    x = screen[0].indexOf("First") + 1;
    const left = 29;
    await this.input(`\x1b[<0;${x};1M\x1b[<32;${left};1M`);
    await dragFrame();
    await this.input(`\x1b[<32;${left};3M\x1b[<0;${left};3m`);
    screen = await this.tabs_are("Second Third First");
    const [other, reader] = await this.viewer();
    await this.viewer_frame(reader, "First");
    await this.input(`\x1b[<0;${x};1M\x1b[<32;${left};1M`);
    await dragFrame();
    await other.request({ op: "input", data: `\x1b[<0;${left};1m` });
    await this.input(`\x1b[<0;${left};1m`);
    screen = await this.tabs_are("First Second Third");
    await this.click(screen[0].indexOf("Third") + 1, 1);
    await this.tabs_are("First Second Third");
    await this.input(`\x1b[<0;${left};1M\x1b[<32;${end};1M`);
    await dragFrame();
    await this.input("\x1b");
    await this.tabs_are("First Second Third");
    await this.input(`\x1b[<0;${end};1m`);
    await this.tabs_are("First Second Third");
  }
  async test_multiple_viewers_share_input_most_recent_sizes_and_detach_independently() {
    await this.attach();
    await this.get_type("frame");
    await this.rpc({ op: "action", name: "sidebar" });
    const pane = (await this.panes())[0].id;
    let checks = 0;
    const checkSize = async (cols: number, rows: number) => {
      const path = join(this.temp.name, `size-check-${checks++}`);
      await this.command("pane.input", {
        target: pane,
        data: `stty size > ${quote(path)}\r`,
      });
      await this.until(
        () =>
          existsSync(path) &&
          readFileSync(path, "utf8").trim() === `${rows} ${cols}`,
      );
    };
    await checkSize(80, 23);
    const [other, reader] = await this.viewer(60, 18);
    await this.viewer_frame(reader, " + ", 60, 18);
    await checkSize(60, 17);
    await this.input("printf 'FIRST_VIEWER\\n'\r");
    await this.viewer_frame(reader, "FIRST_VIEWER", 60, 18);
    await checkSize(80, 23);
    await other.request({ op: "input", data: "printf 'SECOND_VIEWER\\n'\r" });
    await this.frame_with("SECOND_VIEWER");
    await checkSize(60, 17);
    await this.write({ op: "size", cols: 100, rows: 30 });
    await checkSize(100, 29);
    await other.request({ op: "input", data: "\x02q" });
    this.assertTrue(other.state.detached);
    await other.close();
    await checkSize(100, 29);
    await this.input("printf 'STILL_CONNECTED\\n'\r");
    await this.frame_with("STILL_CONNECTED", 100, 30);
    const [third, thirdReader] = await this.viewer(50, 12);
    await this.viewer_frame(thirdReader, " + ", 50, 12);
    await checkSize(50, 11);
    await thirdReader.close();
    await third.close();
    await checkSize(100, 29);
  }
  async test_new_viewer_has_independent_dialog_and_paste() {
    await this.attach();
    await this.get_type("frame");
    await this.input("\x02T");
    await this.frame_with("rename tab");
    const [other] = await this.viewer();
    this.assertFalse(other.state.dialog);
    await this.input("\x1b[200~Private title");
    await other.input("\r");
    this.assertTrue((await this.client!.poll()).dialog);
    await this.input("\x1b[201~\r");
    await this.tab_frame("Private title");
    await this.viewer_frame(other, "Private title");
  }
  rawInputFixture(name: string, ready: string) {
    return writeExecutable(
      join(this.temp.name, name),
      `import {writeFileSync,appendFileSync} from 'node:fs';
process.stdin.setRawMode(true);const log=process.argv[2];writeFileSync(log,'');
process.stdout.write((process.argv[3]||'')+'\\x1b[?2004h'+${JSON.stringify(ready)});
process.stdin.on('data',data=>appendFileSync(log,data));process.stdin.resume();`,
    );
  }
  async test_enhanced_keys_follow_pane_mode_and_preserve_corgi_controls() {
    const fixture = this.rawInputFixture("keys", "KEYS_READY"),
      logs = ["legacy-keys", "kitty-keys"].map((name) =>
        join(this.temp.name, name),
      );
    const panes = [];
    for (const [index, mode] of ["", "\x1b[>1u"].entries())
      panes.push(
        (
          await this.open_pane({
            cwd: this.temp.name,
            command: shellJoin([fixture, logs[index], mode]),
          })
        ).pane,
      );
    for (const pane of panes)
      await this.until(async () =>
        (
          await this.command("pane.read", { target: pane, view: "screen" })
        ).text.includes("KEYS_READY"),
      );
    await this.attach();
    await this.get_type("frame");
    await this.input("\x1b[13;");
    await this.input("9u\x1b[13;2u\x1b[106;5u");
    const expected = "\x1b[13;9u\x1b[13;2u\x1b[106;5u";
    await this.until(() => readFileSync(logs[1], "utf8") === expected);
    await this.input("\x1b[98;5u");
    this.assertTrue((await this.client!.poll()).prefix);
    await this.input("\x1b[27u");
    await this.frame_with("KEYS_READY");
    this.assertEqual(readFileSync(logs[1], "utf8"), expected);
    await this.input("\x1b[98;5uTRenamed\x1b[13u");
    await this.tab_frame("Renamed");
    this.assertEqual(readFileSync(logs[1], "utf8"), expected);
    await this.rpc({ op: "focus", pane: panes[0] });
    await this.input("\x1b[106;");
    await sleep(0.12);
    this.assertEqual(readFileSync(logs[0], "utf8"), "");
    await this.input("5u\x1b[27u\x1b[13u");
    await this.until(() => readFileSync(logs[0], "utf8") === "\n\x1b\r");
    await this.input("\x1b[57352;5u");
    await this.until(
      () => readFileSync(logs[0], "utf8") === "\n\x1b\r\x1b[1;5A",
    );
    await this.input("\x1b[200~\x1b[106;5u\x1b[201~");
    await this.until(
      () =>
        readFileSync(logs[0], "utf8") ===
        "\n\x1b\r\x1b[1;5A\x1b[200~\x1b[106;5u\x1b[201~",
    );
    const before = readFileSync(logs[0], "utf8");
    await this.input("\x1b[");
    await this.until(() => readFileSync(logs[0], "utf8") === before + "\x1b[");
    await this.input("x");
    await this.until(() => readFileSync(logs[0], "utf8") === before + "\x1b[x");
  }
  async test_paste_stays_in_original_pane_when_another_viewer_changes_focus() {
    const fixture = this.rawInputFixture("paste", "PASTE_READY"),
      logs = ["first-input", "second-input"].map((name) =>
        join(this.temp.name, name),
      ),
      panes = [];
    for (const log of logs)
      panes.push(
        (
          await this.open_pane({
            cwd: this.temp.name,
            command: shellJoin([fixture, log]),
          })
        ).pane,
      );
    for (const pane of panes)
      await this.until(async () =>
        (
          await this.command("pane.read", { target: pane, view: "screen" })
        ).text.includes("PASTE_READY"),
      );
    await this.rpc({ op: "focus", pane: panes[0] });
    await this.attach();
    await this.get_type("frame");
    const [other, reader] = await this.viewer();
    await this.viewer_frame(reader, "PASTE_READY");
    await this.input("\x1b[200~");
    await this.until(() => readFileSync(logs[0], "utf8") === "\x1b[200~");
    await other.request({ op: "input", data: "\x02n" });
    this.assertEqual(other.state.pane, panes[1]);
    this.assertEqual(this.client!.state.pane, panes[0]);
    await this.input("\x1b[");
    await this.until(() => readFileSync(logs[0], "utf8") === "\x1b[200~\x1b[");
    await this.input("PASTED_TEXT\x1b[201~");
    await this.until(
      () =>
        readFileSync(logs[0], "utf8") === "\x1b[200~\x1b[PASTED_TEXT\x1b[201~",
    );
    this.assertEqual(readFileSync(logs[1], "utf8"), "");
  }
  async test_paused_viewer_receives_latest_state_on_next_sync() {
    await this.attach();
    await this.get_type("frame");
    const [other] = await this.viewer();
    await this.rpc({ op: "action", name: "rename", value: "Latest frame" });
    await this.tab_frame("Latest frame");
    await this.viewer_frame(other, "Latest frame");
  }
  async test_workspace_context_menu_rename_close_and_last_workspace() {
    const first = (await this.workspaces())[0].id;
    await this.command("workspace.edit", { name: "Keep", target: first });
    const pane = (await this.open_pane({ cwd: this.temp.name })).pane,
      second = (
        await this.new_workspace({ name: "Target", cwd: this.temp.name })
      ).workspace;
    await this.rpc({ op: "workspace.switch", workspace: first });
    await this.attach();
    await this.frame_with("Target");
    await this.input("\x1b[<2;5;6M\x1b[<2;5;6m");
    const menu = await this.frame_with("|Rename");
    this.assertTrue(menu.some((row) => row.includes("|Close")));
    this.assertFalse(menu.some((row) => row.includes("|New tab")));
    this.assertEqual(
      (await this.workspaces()).find((w: any) => w.active).id,
      first,
    );
    await this.click_text(menu, "Rename");
    await this.frame_with("edit workspace: name");
    await this.input("Renamed\r");
    await this.frame_with("Renamed");
    this.assertEqual(
      (await this.workspaces()).find((w: any) => w.id === second).name,
      "Renamed",
    );
    await this.input("\x1b[<2;5;6M\x1b[<2;5;6m");
    await this.click_text(await this.frame_with("|Close"), "Close");
    await this.until(async () => (await this.workspaces()).length === 1);
    this.assertEqual(
      (await this.panes()).map((p: any) => p.id),
      [pane],
    );
    await this.input("\x1b[<2;5;3M\x1b[<2;5;3m");
    await this.frame_with("|Rename");
    await this.input("\x1b[B\r");
    await this.frame_with("Cannot close the last workspace");
    this.assertEqual(
      (await this.panes()).map((p: any) => p.id),
      [pane],
    );
  }
  async test_tab_context_menu_targets_clicked_tab_for_rename_and_new() {
    const one = this.folder("one"),
      two = this.folder("two"),
      first = (await this.open_pane({ cwd: one, title: "One" })).pane,
      second = (await this.open_pane({ cwd: two, title: "Two" })).pane;
    await this.attach();
    let screen = await this.tab_frame("Two");
    await this.right_click_tab(screen, "One");
    let menu = await this.frame_with("|New tab");
    this.assertTrue(menu.some((row) => row.includes("|Rename")));
    this.assertTrue(menu.some((row) => row.includes("|Close")));
    this.assertEqual((await this.focused()).id, second);
    await this.input("\x1b[200~touch CONTEXT_LEAK\r\x1b[201~");
    await this.click_text(menu, "Rename");
    await this.frame_with("rename tab");
    await this.input("First\r");
    screen = await this.tab_frame("First");
    this.assertEqual((await this.focused()).id, first);
    await this.rpc({ op: "focus", pane: second });
    await this.right_click_tab(screen, "First");
    menu = await this.frame_with("|New tab");
    await this.click_text(menu, "New tab");
    await this.choose_terminal();
    await this.until(async () => (await this.tab_count()) === 3);
    this.assertEqual(await this.tab_count(), 3);
    this.assertEqual(
      realpathSync((await this.focused()).cwd),
      realpathSync(one),
    );
    this.assertFalse(existsSync(join(one, "CONTEXT_LEAK")));
    this.assertFalse(existsSync(join(two, "CONTEXT_LEAK")));
  }
  async test_tab_context_close_keeps_target_through_focus_and_reorder() {
    await this.open_pane({ cwd: this.temp.name, title: "First" });
    await this.split_pane("right", { cwd: this.temp.name });
    const second = (
      await this.open_pane({ cwd: this.temp.name, title: "Second" })
    ).pane;
    await this.attach();
    let screen = await this.tab_frame("Second");
    await this.right_click_tab(screen, "First");
    const menu = await this.frame_with("|New tab");
    await this.rpc({ op: "focus", pane: second });
    await this.rpc({ op: "action", name: "move-tab", value: "left" });
    await this.click_text(menu, "Close");
    await this.until(async () => {
      const panes = await this.panes();
      return panes.length === 1 && panes[0].id === second;
    });
    this.assertEqual((await this.session()).closed_panes, 2);
    const gone = (await this.open_pane({ cwd: this.temp.name, title: "Gone" }))
      .pane;
    await this.rpc({ op: "focus", pane: second });
    screen = await this.tab_frame("Gone");
    await this.right_click_tab(screen, "Gone");
    await this.frame_with("|New tab");
    await this.command("pane.close", { target: gone });
    let cleared = false;
    for (let i = 0; i < 100; i++) {
      screen = screen_text((await this.get_type("frame")).data);
      if (
        !screen.join("\n").includes("|New tab") &&
        !screen[0].includes("Gone")
      ) {
        cleared = true;
        break;
      }
    }
    this.assertTrue(cleared, "stale tab menu");
    this.assertEqual(
      (await this.panes()).map((p: any) => p.id),
      [second],
    );
  }
  async test_tab_context_keyboard_dismissal_and_minimum_size() {
    await this.attach();
    let screen = await this.frame_with(" 1 ");
    await this.right_click_tab(screen, " 1 ");
    await this.frame_with("|New tab");
    await this.click(79, 23);
    screen = screen_text((await this.client!.poll()).data);
    this.assertNotIn("|New tab", screen.join("\n"));
    await this.right_click_tab(screen, " 1 ");
    await this.frame_with("|New tab");
    await this.input("\x1b");
    await sleep(0.1);
    await this.client!.poll();
    screen = screen_text((await this.client!.poll()).data);
    this.assertNotIn("|New tab", screen.join("\n"));
    await this.write({ op: "size", cols: 10, rows: 4 });
    screen = await this.frame_with(" 1 ", 10, 4);
    await this.right_click_tab(screen, " 1 ");
    const menu = await this.frame_with("|New tab", 10, 4);
    this.assertTrue(menu.some((row) => row.includes("|Rename")));
    this.assertTrue(menu.some((row) => row.includes("|Close")));
    await this.input("\x1b[");
    await this.input("B\r");
    await this.frame_with("rename t", 10, 4);
    await this.input("Tiny\r");
    await this.tab_frame("Tiny", 10, 4);
  }
  async test_wheel_scrollback_keeps_keyboard_live() {
    const fixture = writeExecutable(
      join(this.temp.name, "scroll-input-fixture"),
      `import {appendFileSync} from 'node:fs';
process.stdin.setRawMode(true);process.stdout.write(Array.from({length:100},(_,i)=>'HISTORY_'+i+'\\r\\n').join('')+'LIVE_PROMPT');
process.stdin.on('data',data=>appendFileSync('scroll-input',data));process.stdin.resume();`,
    );
    await this.open_pane({
      cwd: this.temp.name,
      command: `exec ${quote(fixture)}`,
    });
    await this.attach();
    await this.frame_with("LIVE_PROMPT");
    const log = join(this.temp.name, "scroll-input");
    let expected = "";
    for (const [keys, forwarded] of [
      ["jkqy", "jkqy"],
      ["\x1b[A", "\x1b[A"],
      ["\x1b[107;5u", "\x0b"],
      ["\x1b[200~paste\x1b[201~", "paste"],
      ["\x1b", "\x1b"],
    ]) {
      await this.input("\x1b[<64;40;10M");
      const screen = screen_text((await this.get_type("frame")).data);
      this.assertNotIn("LIVE_PROMPT", screen.join("\n"));
      this.assertNotIn("SCROLL  j/k", screen.join("\n"));
      await this.input(keys);
      expected += forwarded;
      await this.until(
        () => existsSync(log) && readFileSync(log, "utf8") === expected,
      );
      await this.frame_with("LIVE_PROMPT");
    }
    await this.input("\x02s");
    await this.frame_with("SCROLL  j/k");
    await this.input("\x1b[<64;40;10Mzqx");
    expected += "x";
    await this.until(() => readFileSync(log, "utf8") === expected);
    await this.frame_with("LIVE_PROMPT");
  }
  async test_wheel_and_right_drag_do_not_open_commands() {
    await this.attach();
    const screen = await this.frame_with(" + ");
    // The last row belongs to the sidebar and panes; no status text sits there.
    this.assertEqual(screen.at(-1)!.replace("│", "").trim(), "");
    for (const modifiers of [0, 4, 8, 16, 28])
      for (const button of [64, 65, 66, 67, 34]) {
        await this.input(`\x1b[<${button | modifiers};40;10M`);
        this.assertNotIn("Commands", (await this.get_type("frame")).data, [
          button,
          modifiers,
        ]);
      }
    await this.input("\x1b[<2;40;10M\x1b[<2;40;10m");
    await this.frame_with("Rename pane");
  }
  async test_menu_hover_highlights_and_click_activates() {
    await this.attach();
    await this.get_type("frame");
    await this.input("\x1b[<2;40;10M\x1b[<2;40;10m");
    const menu = await this.frame_with("Split right");
    const y = menu.findIndex((row) => row.includes("Split right")),
      x = menu[y].indexOf("Split right");
    await this.input(`\x1b[<35;${x + 1};${y + 1}M`);
    let data = "",
      found = false;
    for (let i = 0; i < 100; i++) {
      data = (await this.get_type("frame")).data;
      if (data.includes("\x1b[1;38;2;24;27;32;48;2;161;194;178mSplit right")) {
        found = true;
        break;
      }
    }
    this.assertTrue(found, "hover did not highlight command");
    this.assertIn("\x1b[?1003h", data);
    this.assertNotIn("\x1b[?1002l", data);
    this.assertNotIn("\x1b[?1003l", data);
    this.assertEqual((await this.panes()).length, 1);
    await this.click(x + 1, y + 1);
    await this.until(async () => (await this.panes()).length === 2);
    found = false;
    for (let i = 0; i < 100; i++) {
      data = (await this.get_type("frame")).data;
      if (!data.includes("Split right") && data.includes("\x1b[?1003h")) {
        found = true;
        break;
      }
    }
    this.assertTrue(found, "menu close did not preserve motion tracking");
    this.assertNotIn("\x1b[?1002l", data);
    this.assertNotIn("\x1b[?1003l", data);
  }
  async test_prefix_menu_keyboard_mouse_and_no_paste_leak() {
    await this.attach();
    await this.get_type("frame");
    await this.write({ op: "size", cols: 100, rows: 40 });
    await this.input("\x02");
    const pending = await this.client!.poll();
    this.assertTrue(pending.prefix);
    this.assertNotIn("Keyboard shortcuts", pending.data);
    await this.input("?");
    let menu = await this.frame_with("Keyboard shortcuts", 100, 40);
    this.assertTrue(menu.some((row) => row.includes("New tab → agent picker")));
    this.assertTrue(menu.some((row) => row.includes("Resize")));
    await this.input("\x1b[200~touch MENU_LEAK\r\x1b[201~");
    await this.click_text(menu, "New tab");
    await this.choose_terminal(100, 40);
    await this.until(async () => (await this.tab_count()) === 2);
    this.assertFalse(existsSync(join(this.temp.name, "MENU_LEAK")));
    await this.input("\x02?");
    menu = await this.frame_with("Keyboard shortcuts", 100, 40);
    await this.click_text(menu, "Right");
    await this.until(async () => (await this.panes()).length === 3);
    await this.input("\x02?");
    menu = await this.frame_with("Keyboard shortcuts", 100, 40);
    await this.click_text(menu, "Resize");
    menu = await this.frame_with("Resize panes", 100, 40);
    await this.click_text(menu, "Resize left");
    await this.frame_with("Resize panes", 100, 40);
    await this.input("\x1b");
    this.assertFalse((await this.client!.poll()).prefix);
    await this.input("\x02?");
    menu = await this.frame_with("Keyboard shortcuts", 100, 40);
    const closeRow = menu.findIndex((row) => row.includes("Close / reopen"));
    await this.click(menu[closeRow].indexOf("x / u") + 1, closeRow + 1);
    await this.until(async () => (await this.panes()).length === 2);
    await this.input("\x02?");
    await this.frame_with("Keyboard shortcuts", 100, 40);
    await this.click(1, 1);
    this.assertFalse((await this.client!.poll()).prefix);
    await this.input("printf '%s%s\\n' MENU_ CLOSED\r");
    const pane = (await this.focused()).id;
    await this.until(async () =>
      (
        await this.command("pane.read", { target: pane, view: "screen" })
      ).text.includes("MENU_CLOSED"),
    );
  }
  async test_plus_and_shortcut_open_picker_before_creating_unnamed_tab() {
    await this.attach();
    const initial = await this.frame_with(" + ");
    this.assertEqual(initial[0].lastIndexOf(" + ") - 28, 10);
    await this.click_text(initial.slice(0, 1), " + ");
    await this.frame_with("New terminal");
    this.assertEqual(await this.tab_count(), 1);
    await this.input("\x1b");
    this.assertEqual(await this.tab_count(), 1);
    await this.click_text(initial.slice(0, 1), " + ");
    await this.choose_terminal();
    await this.until(async () => (await this.tab_count()) === 2);
    const screen = await this.frame_with(" 2 ");
    this.assertNotIn("new tab", screen.join("\n"));
    this.assertEqual(
      realpathSync((await this.focused()).cwd),
      realpathSync(this.temp.name),
    );
    await this.input("\x02c");
    await this.choose_terminal();
    await this.until(async () => (await this.tab_count()) === 3);
    this.assertNotIn("new tab", (await this.frame_with(" 3 ")).join("\n"));
  }
  async test_new_tab_picker_works_with_sidebar_hidden() {
    await this.attach();
    await this.rpc({ op: "action", name: "sidebar" });
    const initial = await this.frame_with(" + ");
    this.assertNotIn("workspaces", initial.join("\n"));
    await this.click_text(initial.slice(0, 1), " + ");
    await this.choose_terminal();
    this.assertEqual(await this.tab_count(), 2);
    await this.input("\x02c");
    await this.choose_terminal();
    this.assertEqual(await this.tab_count(), 3);
  }
  async test_unnamed_tabs_recompute_numbers_after_reorder_close_and_restore() {
    await this.attach();
    await this.frame_with(" 1 ");
    const first = (await this.panes())[0].id;
    await this.input("\x02c");
    await this.choose_terminal();
    await this.until(async () => (await this.tab_count()) === 2);
    await this.rpc({ op: "action", name: "new" });
    await this.choose_terminal();
    await this.tabs_are("1 2 3");
    const third = (await this.focused()).id;
    await this.rpc({
      op: "hook",
      pane: third,
      provider: "codex",
      seq: 1,
      event: { hook_event_name: "SessionStart", session_id: "numbering" },
    });
    await this.agent_frame("codex", "○");
    const labels = (screen: string[]) =>
      screen[0].slice(28).trim().split(/\s+/).join(" ");
    await this.rpc({ op: "action", name: "move-tab", value: "left" });
    let screen = await this.tabs_are("1 2 3");
    this.assertEqual(labels(screen), "1 2 3 +");
    await this.command("pane.close", { target: first });
    screen = await this.tabs_are("1 2");
    this.assertEqual(labels(screen), "1 2 +");
    this.assertNotIn(" 3 ", screen[0]);
    await this.input("\x02T");
    await this.frame_with("rename tab");
    await this.rpc({ op: "action", name: "move-tab", value: "right" });
    await this.frame_with("│2");
    await this.input("\r");
    screen = await this.tabs_are("1 2");
    this.assertEqual(labels(screen), "1 2 +");
    await this.input("\x02TPinned\r");
    await this.tab_frame("Pinned");
    await this.input("\x02T\x03");
    await this.frame_with("│2");
    await this.input("\r");
    screen = await this.tabs_are("1 2");
    this.assertEqual(labels(screen), "1 2 +");
    await this.input("\x02T2\r");
    await this.tabs_are("1 2");
    await this.rpc({ op: "action", name: "move-tab", value: "left" });
    await this.tabs_are("2 2");
    await this.rpc({ op: "action", name: "undo-close" });
    screen = await this.frame_with(" 3 ");
    this.assertEqual(labels(screen), "2 2 3 +");
    const second = (await this.panes()).find(
      (p: any) => p.id !== third && !p.focused,
    ).id;
    await this.command("pane.close", { target: second });
    screen = await this.tabs_are("2 2");
    this.assertNotIn(" 3 ", screen[0]);
    await this.split_pane("right", { cwd: this.temp.name });
    await this.rpc({ op: "action", name: "break" });
    await this.tabs_are("2 2 3");
    await this.open_pane({ command: "sleep 30" });
    screen = await this.tabs_are("2 2 3 4");
    this.assertNotIn("shell", screen[0]);
  }
  async test_menu_paging_and_plus_remain_usable_in_narrow_terminal() {
    await this.attach();
    await this.get_type("frame");
    await this.input("\x02v");
    const before = layout_tree((await this.session()).workspaces[0]);
    await this.write({ op: "size", cols: 30, rows: 5 });
    await this.input("\x02r");
    let menu = await this.frame_with("Resize panes", 30, 5);
    this.assertTrue(menu.some((row) => row.includes("Next >")));
    await this.click_text(menu, "Next >");
    menu = await this.frame_with("Resize right", 30, 5);
    this.assertTrue(menu.some((row) => row.includes("2/2")));
    await this.click_text(menu, "Resize right");
    this.assertNotEqual(
      layout_tree((await this.session()).workspaces[0]),
      before,
    );
    await this.input("\x1b");
    await this.write({ op: "size", cols: 30, rows: 8 });
    await this.input("\x02?");
    await this.frame_with("Help needs 32 × 12", 30, 8);
    await this.input("\x1b");
    // The agent chooser needs room for its rows; retain the narrow tab strip.
    await this.write({ op: "size", cols: 30, rows: 14 });
    for (let i = 0; i < 4; i++)
      await this.open_pane({
        cwd: this.temp.name,
        title: `Long tab name ${i}`,
      });
    const screen = await this.tab_frame("Long tab name 3", 30, 14);
    await this.click_text(screen.slice(0, 1), " + ");
    await this.choose_terminal(30, 14);
    await this.until(async () => (await this.tab_count()) === 6);
  }
  async test_name_dialog_mouse_buttons_and_cursor_editing() {
    await this.attach();
    await this.get_type("frame");
    await this.input("\x02T");
    let dialog = await this.frame_with("rename tab");
    this.assertTrue(
      dialog.some((row) => row.includes("┌") && row.includes("┐")),
    );
    await this.click_text(dialog, "^C clear");
    await this.input("ac\x1b[Db");
    dialog = await this.frame_with("│abc");
    await this.click_text(dialog, "↵ save");
    await this.tab_frame("abc");
    await this.input("\x02T");
    dialog = await this.frame_with("rename tab");
    await this.input("discarded");
    await this.frame_with("│discarded");
    await this.click_text(dialog, "esc cancel");
    this.assertNotIn("discarded", (await this.tab_frame("abc"))[0]);
    await this.input("\x02T");
    await this.frame_with("rename tab");
    await this.input("\x03\x1b[200~new\rname\x1b[201~");
    dialog = await this.frame_with("│newname");
    await this.click_text(dialog, "↵ save");
    await this.tab_frame("newname");
    this.assertEqual(await this.tab_count(), 1);
    this.assertEqual((await this.session()).closed_panes, 0);
  }
  async test_name_dialog_retains_target() {
    await this.attach();
    await this.get_type("frame");
    await this.input("\x02T");
    await this.frame_with("rename tab");
    await this.open_pane({ cwd: this.temp.name, title: "Other" });
    await this.input("Original\r");
    await this.tab_frame("Original");
    this.assertEqual(await this.tab_count(), 2);
    this.assertTrue((await this.rpc({ op: "ping" })).ok);
  }
  async test_tab_pane_identity_and_process_survival() {
    const first = (
      await this.open_pane({
        cwd: this.temp.name,
        command: "printf 'PERSIST\\n'; exec /bin/sh",
      })
    ).pane;
    const second = (
      await this.split_pane("right", {
        cwd: this.temp.name,
        command: "printf 'SECOND\\n'; exec /bin/sh",
      })
    ).pane;
    await this.until(async () =>
      (
        await this.command("pane.read", { target: first, view: "screen" })
      ).text.includes("PERSIST"),
    );
    await this.rpc({ op: "action", name: "break" });
    this.assertEqual(await this.tab_count(), 2);
    await this.rpc({ op: "action", name: "join", value: "1" });
    this.assertEqual(await this.tab_count(), 1);
    this.assertEqual(
      (await this.panes()).map((p: any) => p.id),
      [first, second],
    );
    await this.command("pane.close", { target: second });
    this.assertIn(
      "PERSIST",
      (await this.command("pane.read", { target: first, view: "screen" })).text,
    );
  }
  async test_shell_exit_removes_split_and_hidden_tab() {
    const first = (await this.open_pane({ cwd: this.temp.name })).pane,
      second = (await this.split_pane("right", { cwd: this.temp.name })).pane;
    await this.command("pane.input", { target: second, data: "exit\r" });
    await this.until(async () => {
      const panes = await this.panes();
      return panes.length === 1 && panes[0].id === first;
    });
    this.assertTrue((await this.panes())[0].focused);
    this.assertEqual(await this.tab_count(), 1);
    const third = (await this.open_pane({ cwd: this.temp.name })).pane;
    await this.command("pane.input", { target: first, data: "exit\r" });
    await this.until(async () => {
      const panes = await this.panes();
      return panes.length === 1 && panes[0].id === third;
    });
    this.assertTrue((await this.panes())[0].focused);
    this.assertEqual(await this.tab_count(), 1);
  }
  async test_last_shell_exit_detaches_and_keyboard_undo_preserves_output_and_cwd() {
    await this.attach();
    await this.get_type("frame");
    const sub = this.folder("nested");
    await this.input('cd nested; printf "SAVED_OUTPUT\\n"\r');
    await this.until(async () =>
      (
        await this.command("pane.read", { target: 1, view: "screen" })
      ).text.includes("SAVED_OUTPUT"),
    );
    await this.until(
      async () =>
        realpathSync((await this.panes())[0].cwd) === realpathSync(sub),
    );
    await this.input("exit\r");
    await this.until(async () => (await this.tab_count()) === 0);
    await this.get_type("detach");
    this.assertEqual((await this.session()).closed_panes, 1);
    await this.reconnect();
    await this.input("\x02u");
    await this.until(async () => (await this.panes()).length === 2);
    const pane = await this.focused();
    this.assertNotEqual(pane.id, 1);
    this.assertFalse(pane.exited);
    this.assertEqual(pane.provider, null);
    this.assertEqual(realpathSync(pane.cwd), realpathSync(sub));
    this.assertIn(
      "SAVED_OUTPUT",
      (await this.command("pane.read", { target: pane.id, view: "screen" }))
        .text,
    );
    this.assertEqual((await this.session()).closed_panes, 0);
    await this.input("printf '%s%s\\n' FRESH_ SHELL\r");
    await this.until(async () =>
      (
        await this.command("pane.read", { target: pane.id, view: "screen" })
      ).text.includes("FRESH_SHELL"),
    );
  }
  async test_closed_history_is_bounded_and_does_not_rerun_commands() {
    const workspace = (await this.session()).workspaces[0].id;
    for (let i = 0; i < 10; i++) {
      // A viewer attached after a fast exit would create a new empty shell.
      await this.command("pane.create", {
        workspace,
        cwd: this.temp.name,
        title: `saved-${i}`,
        command: `printf "FINAL_${i}\\n"; echo ran >> runs; exit 7`,
      });
      await this.until(async () => (await this.tab_count()) === 0);
      this.assertEqual((await this.session()).closed_panes, Math.min(i + 1, 8));
    }
    await this.attach();
    await this.get_type("frame");
    for (let i = 9; i > 1; i--) {
      await this.rpc({ op: "action", name: "undo-close" });
      const pane = await this.focused();
      this.assertIn(
        `FINAL_${i}`,
        (await this.command("pane.read", { target: pane.id, view: "screen" }))
          .text,
      );
    }
    this.assertEqual((await this.session()).closed_panes, 0);
    this.assertEqual(
      readFileSync(join(this.temp.name, "runs"), "utf8").trimEnd().split("\n")
        .length,
      10,
    );
    await this.rpc({ op: "action", name: "undo-close" });
    this.assertEqual((await this.panes()).length, 9);
  }
  async test_manual_close_retains_scrollback_and_cancels_stale_modes() {
    await this.attach();
    await this.get_type("frame");
    await this.input(
      "printf 'SCROLLBACK_SENTINEL\\n'; i=0; while [ $i -lt 50 ]; do echo line-$i; i=$((i+1)); done\r",
    );
    await this.until(async () =>
      (
        await this.command("pane.read", { target: 1, view: "screen" })
      ).text.includes("line-49"),
    );
    await this.input("\x02TStored name\r\x02s/missing");
    await this.command("pane.close", { target: 1 });
    await this.get_type("detach");
    await this.reconnect();
    await this.input("\x02u");
    await this.until(async () => (await this.panes()).length === 2);
    const pane = (await this.focused()).id;
    await this.input("\x02sg");
    await this.frame_with("SCROLLBACK_SENTINEL");
    await this.until(async () =>
      (await this.get_type("frame")).data.includes("Stored name"),
    );
    await this.input("q");
    await this.input("printf '%s%s\\n' LIVE_AFTER_ UNDO\r");
    await this.until(async () =>
      (
        await this.command("pane.read", { target: pane, view: "screen" })
      ).text.includes("LIVE_AFTER_UNDO"),
    );
  }
}
registerCase("Smoke", Smoke);
