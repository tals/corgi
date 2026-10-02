/** Smoke coverage for terminal input, sidebar targeting, and native tool activity. */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Runtime, EXE, screen_text } from "./runtime";
import { registerCase, run, quote, sleep, writeExecutable } from "./support";

class SmokeInput extends Runtime {
  async test_panes_use_full_height_and_translate_first_row_input() {
    const fixture = join(this.temp.name, "screen.ts");
    const log = join(this.temp.name, "mouse-input");
    writeExecutable(
      fixture,
      `import { appendFileSync } from 'node:fs';\nprocess.stdin.setRawMode(true);\nconst size=()=>{process.stdout._refreshSize?.();return [process.stdout.columns,process.stdout.rows]};\nfunction draw(){const [cols,rows]=size();process.stdout.write('\\x1b[2J\\x1b[HTOP_'+rows+'x'+cols+'\\x1b['+rows+';1HBOTTOM_'+rows+'\\x1b[1;2H\\x1b[?1000h\\x1b[?1006h');}\nlet last=size().join('x');process.on('SIGWINCH',draw);draw();setInterval(()=>{const next=size().join('x');if(next!==last){last=next;draw()}},25);process.stdin.on('data',chunk=>appendFileSync(${JSON.stringify(log)},chunk));\n`,
    );
    const command = "exec " + quote(fixture);
    const first = (await this.open_pane({ cwd: this.temp.name, command })).pane;
    await this.attach();
    let screen = await this.frame_with("BOTTOM_23");
    this.assertTrue(screen[1].slice(28).startsWith("TOP_23x52"));
    this.assertTrue(screen[23].slice(28).startsWith("BOTTOM_23"));
    await this.click(31, 2);
    await this.click(31, 24);
    let expected = Buffer.from(
      "\x1b[<0;3;1M\x1b[<0;3;1m\x1b[<0;3;23M\x1b[<0;3;23m",
    );
    await this.until(
      () => existsSync(log) && readFileSync(log).equals(expected),
    );
    for (const button of [64, 65, 66, 67, 72, 73, 74, 75]) {
      await this.input(`\x1b[<${button};31;2M`);
      expected = Buffer.concat([expected, Buffer.from(`\x1b[<${button};3;1M`)]);
    }
    await this.until(() => readFileSync(log).equals(expected));
    await this.rpc({
      op: "hook",
      pane: first,
      provider: "codex",
      seq: 1,
      event: { hook_event_name: "SessionStart", session_id: "geometry" },
    });
    let frame = (await this.get_type("frame")).data;
    while (!frame.includes("codex"))
      frame = (await this.get_type("frame")).data;
    this.assertIn("\x1b[2;30H\x1b[?25h", frame);
    this.assertTrue(screen_text(frame).some((row) => row.includes("codex")));
    await this.input("\x1b[<4;29;2M\x1b[<36;31;2M\x1b[<4;31;2m");
    frame = (await this.get_type("frame")).data;
    while (!frame.startsWith("\x1b]52;c;"))
      frame = (await this.get_type("frame")).data;
    this.assertEqual(
      Buffer.from(frame.slice(7, -1), "base64"),
      Buffer.from("TOP"),
    );
    await this.split_pane("down", { cwd: this.temp.name, command });
    screen = await this.frame_with("TOP_10x50", 80, 24, 13);
    this.assertTrue(screen[2].slice(29).startsWith("TOP_10x50"));
    this.assertTrue(screen[11].slice(29).startsWith("BOTTOM_10"));
    this.assertTrue(screen[13].slice(29).startsWith("TOP_10x50"));
    this.assertTrue(screen[22].slice(29).startsWith("BOTTOM_10"));
    await this.rpc({ op: "action", name: "zoom" });
    screen = await this.frame_with("TOP_23x52");
    this.assertTrue(screen[1].slice(28).startsWith("TOP_23x52"));
    this.assertTrue(screen[23].slice(28).startsWith("BOTTOM_23"));
    await this.input("\x02b");
    screen = await this.frame_with("TOP_23x80");
    this.assertTrue(screen[1].startsWith("TOP_23x80"));
    this.assertTrue(screen[23].startsWith("BOTTOM_23"));
    await this.write({ op: "size", cols: 10, rows: 4 });
    screen = await this.frame_with("TOP_3x10", 10, 4);
    this.assertTrue(screen[1].startsWith("TOP_3x10"));
    this.assertTrue(screen[3].startsWith("BOTTOM_3"));
  }
  async test_keyboard_fragmented_paste_mouse_resize_and_reattach() {
    await this.attach();
    await this.get_type("frame");
    await this.input("\x02v");
    await this.until(async () => (await this.panes()).length === 2);
    await this.input("\x02-");
    await this.until(async () => (await this.panes()).length === 3);
    await this.input("\x02h");
    await this.until(async () => (await this.panes())[0].focused);
    const pasted = join(this.temp.name, "pasted");
    await this.input("\x1b[20");
    await this.input("0~printf PASTED > pasted");
    await this.input("\x1b[201~");
    await this.input("\r");
    await this.until(
      () => existsSync(pasted) && readFileSync(pasted, "utf8") === "PASTED",
    );
    await this.input("\x1b[<0;54;10M\x1b[<32;60;10M\x1b[<0;60;10m");
    await this.input("\x02c");
    await this.frame_with("New terminal");
    await this.input("t");
    await this.until(async () => (await this.tab_count()) === 2);
    await this.input("\x02TRenamed\r");
    await this.input("\x02q");
    await this.get_type("detach");
    await this.client!.close();
    this.client = null;
    await this.attach();
    const frame = await this.get_type("frame");
    this.assertIn("Renamed", frame.data);
    await this.input("\x021");
    await this.until(async () => (await this.panes())[0].focused);
    this.assertEqual(readFileSync(pasted, "utf8"), "PASTED");
  }
  async test_sidebar_hook_lifecycle_focus_and_removal() {
    const one = (
      await this.open_pane({
        cwd: this.temp.name,
        title: "Alpha",
        command: "sleep 30",
      })
    ).pane;
    await this.open_pane({
      cwd: this.temp.name,
      title: "Beta",
      command: "sleep 30",
    });
    await this.attach();
    let screen = await this.frame_with("No agents yet");
    this.assertTrue(screen[0].startsWith(" workspaces"));
    const transcript = join(this.temp.name, "sidebar.jsonl");
    writeFileSync(
      transcript,
      JSON.stringify({ type: "session_meta", payload: { id: "sidebar" } }) +
        "\n",
    );
    let turn = 0;
    const hook = async (event: string, extra: any = {}) => {
      if (event === "UserPromptSubmit") turn++;
      const payload = {
        hook_event_name: event,
        session_id: "sidebar",
        ...extra,
        transcript_path: transcript,
        turn_id: String(turn),
      };
      const result = await run([EXE, "hook", "codex"], {
        env: { ...this.env, CORGI_PANE: String(one) },
        input: JSON.stringify(payload),
        timeout: 3000,
        check: false,
      });
      this.assertEqual(
        [result.code, result.stdout, result.stderr],
        [0, "", ""],
      );
      if (event === "Stop")
        appendFileSync(
          transcript,
          JSON.stringify({
            type: "event_msg",
            timestamp: new Date().toISOString(),
            payload: { type: "task_complete", turn_id: String(turn) },
          }) + "\n",
        );
    };
    await hook("SessionStart");
    screen = await this.agent_frame("codex", "○", "", "166;227;161");
    this.assertNotIn("SessionStart", screen.join("\n"));
    this.assertNotIn("Alpha", screen.map((r) => r.slice(0, 27)).join("\n"));
    await hook("UserPromptSubmit");
    await this.agent_frame("codex", "●", "thinking", "249;226;175");
    await hook("PreToolUse", { tool_name: "Bash" });
    screen = await this.agent_frame("codex", "●", "🔧");
    this.assertTrue((await this.panes())[0].tool_active);
    this.assertNotIn("Bash", screen.map((r) => r.slice(0, 27)).join("\n"));
    await hook("PreToolUse", { tool_name: "request_user_input" });
    screen = await this.agent_frame("codex", "●", "🔧", "243;139;168");
    this.assertEqual((await this.panes())[0].attention, "needs_input");
    await this.click_text(
      screen.map((r) => r.slice(0, 27)),
      "codex",
    );
    await this.until(async () => {
      const p = (await this.panes())[0];
      return p.focused && p.attention === "none";
    });
    this.assertEqual((await this.panes())[0].state, "blocked");
    await this.rpc({ op: "action", name: "rename", value: "Renamed" });
    screen = await this.tab_frame("Renamed");
    this.assertNotIn("Renamed", screen.map((r) => r.slice(0, 27)).join("\n"));
    await hook("PostToolUse", { tool_name: "Bash" });
    await this.agent_frame("codex", "●", "thinking");
    await hook("UserPromptSubmit");
    await this.agent_frame("codex", "●", "thinking", "249;226;175");
    await hook("Stop");
    await this.agent_frame("codex", "○", "", "166;227;161");
    await hook("SessionEnd");
    await this.agent_frame("codex", "○", "", "166;227;161");
    this.assertEqual(
      (await this.session()).conversations.find(
        (c: any) => c.agent.session === "sidebar",
      ).agent.state,
      "done",
    );
    await this.command("pane.close", { target: one });
    screen = await this.frame_with("No agents yet");
    this.assertNotIn("Renamed", screen.map((r) => r.slice(0, 27)).join("\n"));
    await this.click(25, 1);
    screen = await this.frame_with(" > ");
    this.assertTrue(screen[0].startsWith(" > "));
    await this.click(2, 1);
    await this.frame_with("No agents yet");
  }
  async test_sidebar_scrolling_and_clicks_keep_stable_pane_targets() {
    const panes: number[] = [];
    for (let index = 0; index < 12; index++) {
      const directory = join(this.temp.name, `Agent-${index}`);
      mkdirSync(directory);
      const pane = (
        await this.open_pane({
          cwd: directory,
          title: `Tab-${index}`,
          command: "sleep 30",
        })
      ).pane;
      panes.push(pane);
      await this.command("pane.rename", {
        name: `Agent-${index}`,
        target: pane,
      });
      await this.rpc({
        op: "hook",
        pane,
        provider: "claude",
        seq: 1,
        event: { hook_event_name: "SessionStart", session_id: String(index) },
      });
    }
    await this.attach();
    let screen = await this.scrollbar_with("┃┃┃┃┃││││││");
    this.assertNotIn(
      "Agent-11",
      screen
        .slice(12, 23)
        .map((r) => r.slice(0, 27))
        .join("\n"),
    );
    await this.input("\x1b[<65;5;15M");
    await this.scrollbar_with("│┃┃┃┃┃│││││");
    await this.input("\x1b[<65;5;15M".repeat(4));
    screen = await this.scrollbar_with("││││┃┃┃┃┃││");
    await this.click_text(
      screen.map((r, i) => (i < 12 ? "" : r.slice(0, 27))),
      "Agent-8",
    );
    await this.until(
      async () =>
        (await this.panes()).find((p: any) => p.focused).id === panes[8],
    );
    await this.rpc({ op: "action", name: "move-tab", value: "left" });
    await this.command("pane.close", { target: panes[11] });
    screen = await this.scrollbar_with("││││┃┃┃┃┃┃│");
    await this.click_text(
      screen.map((r, i) => (i < 12 ? "" : r.slice(0, 27))),
      "Agent-8",
    );
    await this.until(
      async () =>
        (await this.panes()).find((p: any) => p.focused).id === panes[8],
    );
    await this.write({ op: "size", cols: 30, rows: 8 });
    screen = await this.frame_with(" + ", 30, 8);
    this.assertNotIn("agents", screen[0]);
    await this.write({ op: "size", cols: 80, rows: 24 });
    await this.scrollbar_with("││││┃┃┃┃┃┃│");
  }
  async test_each_workspace_keeps_its_agent_list_scroll() {
    const home = (await this.session()).workspaces[0].id;
    const other = (
      await this.command("workspace.create", {
        name: "Other",
        cwd: this.temp.name,
      })
    ).workspace;
    for (const workspace of [home, other])
      for (let index = 0; index < 7; index++) {
        const pane = (
          await this.command("pane.create", {
            workspace,
            cwd: this.temp.name,
            command: "sleep 30",
          })
        ).pane;
        await this.rpc({
          op: "hook",
          pane,
          provider: "claude",
          seq: 1,
          event: {
            hook_event_name: "SessionStart",
            session_id: `${workspace}-${index}`,
          },
        });
      }
    await this.attach();
    await this.write({ op: "workspace", workspace: home });
    await this.scrollbar_with("┃┃┃┃┃┃┃┃┃││");
    await this.input("\x1b[<65;5;15M".repeat(2));
    await this.scrollbar_with("││┃┃┃┃┃┃┃┃┃");
    await this.write({ op: "workspace", workspace: other });
    await this.scrollbar_with("┃┃┃┃┃┃┃┃┃││");
    await this.input("\x1b[<65;5;15M");
    await this.scrollbar_with("│┃┃┃┃┃┃┃┃┃│");
    await this.write({ op: "workspace", workspace: home });
    await this.scrollbar_with("││┃┃┃┃┃┃┃┃┃");
    await this.write({ op: "workspace", workspace: other });
    await this.scrollbar_with("│┃┃┃┃┃┃┃┃┃│");
  }
  async test_launched_and_restored_agents_scroll_into_view() {
    for (let index = 0; index < 7; index++) {
      const pane = (
        await this.open_pane({ cwd: this.temp.name, command: "sleep 30" })
      ).pane;
      await this.rpc({
        op: "hook",
        pane,
        provider: "claude",
        seq: 1,
        event: { hook_event_name: "SessionStart", session_id: String(index) },
      });
    }
    await this.attach();
    await this.scrollbar_with("┃┃┃┃┃┃┃┃┃││");
    const before = (await this.session()).panes.map((p: any) => p.id);
    // The sidebar's "New" launches the last agent.
    await this.click(20, 12);
    let pane = 0;
    await this.until(async () => {
      pane = (await this.session()).panes.find(
        (p: any) => !before.includes(p.id),
      )?.id;
      return pane !== undefined;
    });
    await this.command("pane.rename", { name: "Launched", target: pane });
    await this.rpc({
      op: "hook",
      pane,
      provider: "claude",
      seq: 1,
      event: { hook_event_name: "SessionStart", session_id: "launched" },
    });
    const screen = await this.scrollbar_with("│││┃┃┃┃┃┃┃┃");
    this.assertIn(
      "Launched",
      screen
        .slice(13)
        .map((r) => r.slice(0, 27))
        .join("\n"),
    );
    await this.command("pane.close", { target: pane });
    await this.scrollbar_with("││┃┃┃┃┃┃┃┃┃");
    await this.input("\x1b[<64;5;15M".repeat(3));
    await this.scrollbar_with("┃┃┃┃┃┃┃┃┃││");
    const open = (await this.session()).panes.map((p: any) => p.id);
    await this.rpc({ op: "action", name: "undo-close" });
    await this.until(async () => {
      pane = (await this.session()).panes.find(
        (p: any) => !open.includes(p.id),
      )?.id;
      return pane !== undefined;
    });
    await this.command("pane.rename", { name: "Reopened", target: pane });
    await this.rpc({
      op: "hook",
      pane,
      provider: "claude",
      seq: 1,
      event: { hook_event_name: "SessionStart", session_id: "restored" },
    });
    // The restore notice covers the bottom row, and so the scrollbar's end.
    await this.until(async () =>
      screen_text((await this.client!.poll()).data, 80, 24)
        .slice(13)
        .some((row) => row.slice(0, 27).includes("Reopened")),
    );
  }
  async test_sidebar_keeps_provider_and_activity_separate_from_directory_and_tab_title() {
    const project = join(this.temp.name, "frontend");
    mkdirSync(project);
    const pane = (
      await this.open_pane({ cwd: this.temp.name, title: "Unrelated tab name" })
    ).pane;
    await this.rpc({
      op: "hook",
      pane,
      provider: "claude",
      seq: 1,
      event: { hook_event_name: "SessionStart", session_id: "directory" },
    });
    await this.attach();
    await this.agent_frame("claude", "○");
    await this.command("pane.input", {
      target: pane,
      data: "cd " + quote(project) + "\r",
    });
    await this.until(
      async () =>
        realpathSync((await this.panes())[0].cwd) === realpathSync(project),
    );
    let screen = await this.agent_frame("claude", "○");
    this.assertNotIn("Unrelated", screen.map((r) => r.slice(0, 27)).join("\n"));
    await this.rpc({
      op: "hook",
      pane,
      provider: "claude",
      seq: 2,
      event: {
        hook_event_name: "PreToolUse",
        session_id: "directory",
        cwd: "/a/very/long/working/directory/backend",
        tool_name: "Read",
      },
    });
    screen = await this.agent_frame("claude", "●", "🔧");
    this.assertEqual(
      (await this.session()).panes[0].agent.cwd,
      "/a/very/long/working/directory/backend",
    );
    this.assertIn("Read", screen[14]);
    await this.rpc({
      op: "hook",
      pane,
      provider: "claude",
      seq: 3,
      event: {
        hook_event_name: "PostToolUse",
        session_id: "directory",
        tool_name: "Read",
      },
    });
    await this.agent_frame("claude", "●", "thinking");
  }
  async test_sidebar_native_updates_and_selection_keep_approvals_pending() {
    await this.open_pane({ cwd: this.temp.name, command: "sleep 30" });
    await this.attach();
    await this.get_type("frame");
    const ident = (
      await this.rpc({
        op: "native.start",
        provider: "codex",
        cwd: this.temp.name,
      })
    ).session;
    await this.agent_frame("codex", "○", "", "166;227;161");
    await this.rpc({
      op: "native.send",
      session: ident,
      message: { id: 1, method: "test/approval" },
    });
    const screen = await this.agent_frame("codex", "●", "🔧", "243;139;168");
    await this.click_text(
      screen.map((r) => r.slice(0, 27)),
      "codex",
    );
    await this.frame_with(`corgi native events ${ident}`);
    const session = (await this.rpc({ op: "native.list" })).sessions[0];
    this.assertEqual(
      [session.pending_requests, session.attention],
      [1, "needs_input"],
    );
    await this.rpc({
      op: "native.send",
      session: ident,
      message: { id: 900, result: { decision: "decline" } },
    });
    await this.agent_frame("codex", "●", "", "148;226;213");
    await this.rpc({
      op: "native.send",
      session: ident,
      message: { id: 2, method: "test/exit" },
    });
    await this.agent_frame("codex", "○", "", "108;112;134");
    await this.until(
      async () => (await this.rpc({ op: "native.list" })).sessions[0].exited,
    );
    await this.rpc({ op: "native.stop", session: ident });
    await this.frame_with("No agents yet");
  }
  async test_native_tool_activity_tracks_overlapping_calls_and_clears_on_turn_end() {
    await this.attach();
    await this.get_type("frame");
    for (const provider of ["codex", "claude"]) {
      const ident = (
        await this.rpc({ op: "native.start", provider, cwd: this.temp.name })
      ).session;
      await this.agent_frame(provider, "○");
      const send = (method: string, tool = "a") =>
        this.rpc({
          op: "native.send",
          session: ident,
          message: { method: "test/" + method, params: { id: tool } },
        });
      const count = (n: number) =>
        this.until(
          async () =>
            (await this.rpc({ op: "native.list" })).sessions.find(
              (s: any) => s.id === ident,
            ).active_tools === n,
        );
      await send("tool-start");
      await count(1);
      await this.agent_frame(provider, "●", "🔧");
      await send("tool-start", "b");
      await count(2);
      await send("tool-stop");
      await count(1);
      await this.write({ op: "size", cols: 80, rows: 24 });
      await this.agent_frame(provider, "●", "🔧");
      await send("tool-stop", "b");
      await count(0);
      await this.agent_frame(provider, "●", "thinking");
      await send("tool-start", "c");
      await count(1);
      await this.agent_frame(provider, "●", "🔧");
      await send("turn-end");
      await count(0);
      await this.agent_frame(provider, "●", "", "148;226;213");
      await send("tool-start", "d");
      await count(1);
      await send("exit");
      await count(0);
      await this.agent_frame(provider, "○", "", "108;112;134");
      await this.rpc({ op: "native.stop", session: ident });
      await this.frame_with("No agents yet");
    }
  }
}
registerCase("SmokeInput", SmokeInput, { inherited: false });
