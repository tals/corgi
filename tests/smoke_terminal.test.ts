/** Terminal, hook, native-session, and executable-discovery regressions. */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  deadline,
  EXE,
  JsonSocket,
  Pty,
  ROOT,
  TestCase,
  quote,
  registerCase,
  run,
  shellJoin,
  sleep,
  tempDir,
  writeExecutable,
} from "./support";
import { FAKE, Runtime } from "./runtime";

const file = (path: string) => readFileSync(path, "utf8");
const json = (path: string) => JSON.parse(file(path));
const hash = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

class SmokeTerminal extends Runtime {
  async assertAgentExited(pane: number) {
    try {
      await this.until(
        async () =>
          (await this.panes()).find((p: any) => p.id === pane)?.provider ===
          null,
        8,
      );
    } catch (error) {
      const panes = await this.panes();
      const screen = await this.command("pane.read", {
        target: pane,
        view: "screen",
      });
      throw new Error(
        `Agent exit was not observed: ${JSON.stringify({ panes, screen })}`,
        { cause: error },
      );
    }
  }
  async test_real_client_plays_embedded_request_and_completion_sounds() {
    const players = join(this.temp.name, "players");
    mkdirSync(players);
    const played = join(this.temp.name, "played.jsonl");
    const player = `import { appendFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const path = process.argv.at(-1);
appendFileSync(${JSON.stringify(played)}, JSON.stringify({hash:createHash('sha256').update(readFileSync(path)).digest('hex'),path}) + '\\n');
`;
    for (const name of [
      "afplay",
      "paplay",
      "pw-play",
      "ffplay",
      "mpg123",
      "mpv",
    ])
      writeExecutable(join(players, name), player);
    const env: Record<string, string | undefined> = {
      ...this.env,
      PATH: players + ":" + (this.env.PATH ?? ""),
      TMPDIR: this.temp.name,
    };
    for (const name of ["CORGI_BELL", "SSH_CONNECTION", "SSH_TTY"])
      delete env[name];
    const pty = await Pty.spawn([EXE], { env, cols: 80, rows: 24 });
    this.pty = pty;
    await this.until(async () => (await this.panes()).length > 0);
    const pane = (await this.panes())[0].id;
    const transcript = join(this.temp.name, "sounds.jsonl");
    writeFileSync(
      transcript,
      JSON.stringify({ type: "session_meta", payload: { id: "sounds" } }) +
        "\n",
    );
    let turn = "initial";
    const hook = async (event: string, seq: number) => {
      if (event === "UserPromptSubmit") turn = String(seq);
      await this.rpc({
        op: "hook",
        pane,
        provider: "codex",
        seq,
        event: {
          hook_event_name: event,
          session_id: "sounds",
          turn_id: turn,
          transcript_path: transcript,
          tool_name: "request_user_input",
        },
      });
      if (event === "Stop") {
        const timestamp = new Date().toISOString();
        writeFileSync(
          transcript,
          JSON.stringify({
            type: "event_msg",
            timestamp,
            payload: { type: "task_complete", turn_id: turn },
          }) + "\n",
          { flag: "a" },
        );
      }
    };
    const records = () =>
      existsSync(played)
        ? file(played)
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [];
    await hook("SessionStart", 1);
    await hook("UserPromptSubmit", 2);
    await hook("PermissionRequest", 3);
    await sleep(0.7);
    this.assertEqual(records(), []);
    await hook("PreToolUse", 4);
    await this.until(() => records().length === 1);
    this.assertEqual(
      records()[0].hash,
      hash(join(ROOT, "src/sounds/request.mp3")),
    );
    await hook("PreToolUse", 5);
    await hook("UserPromptSubmit", 6);
    await hook("Stop", 7);
    await sleep(1.6);
    this.assertEqual(records().length, 1);
    const background = (await this.open_pane({ cwd: this.temp.name })).pane;
    await this.until(async () =>
      (await this.rpc({ op: "viewer.list" })).viewers.some(
        (v: any) => v.pane === background,
      ),
    );
    await hook("UserPromptSubmit", 8);
    await hook("Stop", 9);
    await this.until(() => records().length === 2);
    this.assertEqual(
      records()[1].hash,
      hash(join(ROOT, "src/sounds/done.mp3")),
    );
    await this.until(() =>
      records().every((record: any) => !existsSync(record.path)),
    );
    await this.rpc({ op: "action", name: "mute" });
    await hook("UserPromptSubmit", 10);
    await hook("PreToolUse", 11);
    await sleep(1.6);
    this.assertEqual(records().length, 2);
  }
  async test_attention_is_deduplicated_and_explicitly_acknowledged() {
    await this.attach();
    await this.get_type("frame");
    await this.input("\x02v");
    await this.until(async () => (await this.panes()).length === 2);
    const hook = (
      event: string,
      seq: number,
      session = "test",
      extra: any = {},
    ) =>
      this.rpc({
        op: "hook",
        pane: 1,
        provider: "claude",
        seq,
        event: { hook_event_name: event, session_id: session, ...extra },
      });
    await hook("SessionStart", 1);
    await hook("UserPromptSubmit", 2);
    await hook("PermissionRequest", 3);
    this.assertEqual((await this.get_type("bell")).kind, "needs_input");
    await hook("PermissionRequest", 4);
    await hook("Stop", 5, "child");
    await hook("Stop", 6, "test", { agent_id: "child" });
    this.assertEqual((await this.panes())[0].state, "blocked");
    this.assertEqual((await this.panes())[0].attention, "needs_input");
    await this.input("\x02f");
    await this.until(async () => (await this.panes())[0].focused);
    this.assertEqual((await this.panes())[0].attention, "none");
    this.assertEqual((await this.panes())[0].state, "blocked");
    await hook("UserPromptSubmit", 7);
    await hook("Stop", 8);
    this.assertEqual((await this.panes())[0].attention, "none");
  }
  async test_slow_and_malformed_clients_do_not_block_runtime() {
    const bad = await JsonSocket.connect(this.path);
    bad.socket.write("{incomplete");
    this.assertTrue((await this.rpc({ op: "ping" })).ok);
    bad.close();
    const pane = (
      await this.open_pane({
        cwd: this.temp.name,
        command: "printf OUT; exec /bin/sh",
      })
    ).pane;
    await this.until(async () =>
      (
        await this.command("pane.read", { target: pane, view: "screen" })
      ).text.includes("OUT"),
    );
    const malformed = await JsonSocket.connect(this.path);
    malformed.socket.write("[]\n");
    this.assertIn("UnknownOperation", JSON.stringify(await malformed.read()));
    malformed.close();
    this.assertTrue((await this.rpc({ op: "ping" })).ok);
  }
  async test_hook_binary_silent_and_configuration_valid() {
    const pane = (await this.open_pane({ cwd: this.temp.name })).pane;
    const payload = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: "session",
    });
    const result = await run([EXE, "hook", "claude"], {
      env: { ...this.env, CORGI_PANE: String(pane) },
      input: payload,
      timeout: 3000,
    });
    this.assertEqual([result.code, result.stdout, result.stderr], [0, "", ""]);
    await this.until(async () => (await this.panes())[0].state === "working");
    for (const provider of ["claude", "codex"]) {
      const config = JSON.parse(await this.run_cli("hooks", provider));
      this.assertIn("PermissionRequest", config.hooks);
    }
  }
  async test_automatic_hook_install_preserves_settings_and_is_idempotent() {
    const original = {
      theme: "dark",
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "echo existing" }] }],
      },
    };
    const paths = [
      join(this.env.CODEX_HOME!, "hooks.json"),
      join(this.env.CLAUDE_CONFIG_DIR!, "settings.json"),
    ];
    for (const path of paths) {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, JSON.stringify(original));
    }
    await this.restart_runtime();
    const contents: [Buffer, bigint][] = [];
    for (const path of paths) {
      await this.until(() => file(path).includes("CORGI_BIN"));
      const saved = json(path);
      this.assertEqual(saved.theme, "dark");
      this.assertEqual(saved.hooks.Stop[0], original.hooks.Stop[0]);
      this.assertEqual(
        json(join(path, "..", `${path.split("/").at(-1)}.corgi-backup`)),
        original,
      );
      contents.push([
        readFileSync(path),
        statSync(path, { bigint: true }).mtimeNs,
      ]);
      const command = saved.hooks.Stop.at(-1).hooks[0].command;
      const outside = Object.fromEntries(
        Object.entries(this.env).filter(([key]) => !key.startsWith("CORGI_")),
      );
      const result = await run(["/bin/sh", "-c", command], {
        env: outside,
        input: "{}",
        timeout: 3000,
      });
      this.assertEqual(
        [result.code, result.stdout, result.stderr],
        [0, "", ""],
      );
    }
    await this.restart_runtime();
    await this.open_pane({ cwd: this.temp.name });
    for (const [i, path] of paths.entries())
      this.assertEqual(
        [readFileSync(path), statSync(path, { bigint: true }).mtimeNs],
        contents[i],
      );
  }
  async test_invalid_or_symlink_settings_are_left_intact() {
    mkdirSync(this.env.CODEX_HOME!, { recursive: true });
    mkdirSync(this.env.CLAUDE_CONFIG_DIR!, { recursive: true });
    const bad = join(this.env.CODEX_HOME!, "hooks.json");
    writeFileSync(bad, "{broken");
    const target = join(this.temp.name, "external.json");
    writeFileSync(target, "{}");
    const link = join(this.env.CLAUDE_CONFIG_DIR!, "settings.json");
    symlinkSync(target, link);
    await this.restart_runtime();
    await this.open_pane({ cwd: this.temp.name });
    this.assertEqual(file(bad), "{broken");
    this.assertEqual(file(target), "{}");
    this.assertTrue((await import("node:fs")).lstatSync(link).isSymbolicLink());
  }
  async test_plain_commands_gain_hooks_without_wrappers() {
    for (const provider of ["codex", "claude"]) {
      const pane = await this.ordinary_agent(provider, true);
      await this.until(
        async () =>
          (await this.panes()).find((p: any) => p.id === pane).session ===
          "ordinary-" + provider,
      );
      for (const [command, state] of [
        ["work", "working"],
        ["block", "blocked"],
        ["stop", "idle"],
      ]) {
        await this.command("pane.input", {
          target: pane,
          data: command + "\r",
        });
        await this.until(
          async () =>
            (await this.panes()).find((p: any) => p.id === pane).state ===
            state,
        );
      }
      await this.command("pane.input", { target: pane, data: "exit\r" });
      await this.assertAgentExited(pane);
      this.assertEqual(
        (await this.panes()).find((p: any) => p.id === pane).session,
        "",
      );
    }
  }
  async test_plain_agent_detection_and_terminal_attention_without_hooks() {
    const pane = await this.ordinary_agent("codex");
    await this.until(async () => (await this.panes())[0].state === "idle");
    this.assertEqual((await this.panes())[0].session, "");
    for (const [command, state] of [
      ["work", "working"],
      ["block", "blocked"],
      ["stop", "idle"],
    ]) {
      await this.command("pane.input", { target: pane, data: command + "\r" });
      await this.until(async () => (await this.panes())[0].state === state);
    }
    await this.command("pane.input", { target: pane, data: "exit\r" });
    await this.assertAgentExited(pane);
  }
  async test_codex_fallback_tool_icon_without_hooks() {
    const pane = await this.ordinary_agent("codex");
    await this.until(async () => (await this.panes())[0].state === "idle");
    await this.attach();
    for (const [command, icon] of [
      ["work", "thinking"],
      ["tool", "🔧"],
      ["work", "thinking"],
      ["tool", "🔧"],
    ]) {
      await this.command("pane.input", { target: pane, data: command + "\r" });
      await this.agent_frame("codex", "●", icon);
    }
    await this.command("pane.input", { target: pane, data: "stop\r" });
    await this.agent_frame("codex", "○", "");
  }
  async test_agent_startup_has_its_own_indicator_and_never_thinks() {
    const pane = await this.ordinary_agent("codex", false, true);
    await this.attach();
    const screen = await this.agent_frame("codex", "●", "", "160;146;184");
    this.assertIn("Starting session", screen[14]);
    await sleep(0.8);
    this.assertEqual((await this.panes())[0].state, "initializing");
    await this.command("pane.input", { target: pane, data: "ready\r" });
    await this.agent_frame("codex", "○", "", "166;227;161");
    await this.command("pane.input", { target: pane, data: "work\r" });
    await this.agent_frame("codex", "●", "thinking", "249;226;175");
  }
  async test_bun_agent_detection() {
    const script = join(
      this.temp.name,
      "node_modules/@anthropic-ai/claude-code/cli.js",
    );
    mkdirSync(join(script, ".."), { recursive: true });
    writeFileSync(
      script,
      'console.log("\\x1b]2;✳ Bun agent\\x07");setInterval(()=>{},1000);',
    );
    const pane = (
      await this.open_pane({
        cwd: this.temp.name,
        command: shellJoin([process.execPath, script]),
      })
    ).pane;
    await this.until(async () => (await this.panes())[0].provider === "claude");
    await this.until(async () => (await this.panes())[0].state === "idle");
    await this.command("pane.close", { target: pane });
  }
  async test_native_handshake_retained_approvals_and_event_rotation() {
    for (const provider of ["codex", "claude"]) {
      const ident = (
        await this.rpc({ op: "native.start", provider, cwd: this.temp.name })
      ).session;
      await this.until(async () =>
        (await this.rpc({ op: "native.list" })).sessions.some(
          (s: any) => s.id === ident && s.ready,
        ),
      );
      await this.rpc({
        op: "native.send",
        session: ident,
        message: { id: 1, method: "test/approval" },
      });
      await this.until(async () =>
        (await this.rpc({ op: "native.list" })).sessions.some(
          (s: any) => s.id === ident && s.pending_requests === 1,
        ),
      );
      await this.rpc({
        op: "native.send",
        session: ident,
        message: { id: 2, method: "test/flood" },
      });
      await this.until(async () =>
        (await this.rpc({ op: "native.list" })).sessions.some(
          (s: any) => s.id === ident && s.next_seq > 150,
        ),
      );
      const events = await this.rpc({ op: "native.events", session: ident });
      this.assertLessEqual(events.events.length, 128);
      this.assertEqual(events.pending_requests.length, 1);
      this.assertGreater(events.first_seq, 1);
      const response =
        provider === "codex"
          ? { id: 900, result: { decision: "decline" } }
          : {
              type: "control_response",
              response: {
                subtype: "success",
                request_id: "permission-1",
                response: { behavior: "deny", message: "test" },
              },
            };
      await this.rpc({ op: "native.send", session: ident, message: response });
      await this.until(async () =>
        (await this.rpc({ op: "native.list" })).sessions.some(
          (s: any) =>
            s.id === ident && s.state === "idle" && s.pending_requests === 0,
        ),
      );
      await this.rpc({ op: "native.stop", session: ident });
    }
  }
  async test_native_acknowledgement_refreshes_attached_frame() {
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
    await this.rpc({
      op: "native.send",
      session: ident,
      message: { id: 1, method: "test/approval" },
    });
    await this.frame_with("! 1 needs you");
    await this.rpc({ op: "native.events", session: ident });
    const frame = await this.get_type("frame");
    this.assertIn("! 0 needs you", frame.data);
    this.assertEqual(
      (await this.rpc({ op: "native.list" })).sessions[0].pending_requests,
      1,
    );
  }
  async test_native_codex_discovers_path_without_override() {
    await this.run_cli("shutdown");
    await this.until(() => !existsSync(this.path));
    const binDir = join(this.temp.name, "auto-bin");
    mkdirSync(binDir);
    writeExecutable(join(binDir, "codex"), FAKE);
    delete this.env.CORGI_CODEX_BIN;
    this.env.PATH = binDir + ":" + (this.env.PATH ?? "");
    const ident = JSON.parse(
      await this.run_cli("native", "start", "codex"),
    ).session;
    await this.until(async () =>
      (await this.rpc({ op: "native.list" })).sessions.some(
        (s: any) => s.id === ident && s.ready,
      ),
    );
    const events = (await this.rpc({ op: "native.events", session: ident }))
      .events;
    this.assertTrue(
      events.some((e: any) => JSON.parse(e.line).result?.version === "fixture"),
    );
  }
  async checkRealClientExit(keys: string, remainingPanes: number) {
    const pty = new Pty(80, 24);
    this.pty = pty;
    const before = await pty.settings();
    pty.start([EXE], { env: this.env });
    await pty.waitFor("corgi", 4000);
    const offset = pty.output.length;
    pty.write(keys);
    this.assertEqual(
      await deadline(pty.proc.exited, 4000, "Corgi did not detach"),
      0,
    );
    await sleep(0.1);
    const collected = pty.output;
    this.assertIn("\x1b[>1u", collected);
    this.assertIn("\x1b[<u", collected);
    this.assertLess(
      collected.indexOf("\x1b[<u"),
      collected.indexOf("\x1b[?1049l"),
    );
    this.assertIn("\x1b[?1049l", collected);
    if (this.env.CORGI_CURSOR_BLINK === "1") {
      for (const mode of ["\x1b[?12s", "\x1b[?12l", "\x1b[?12r"])
        this.assertNotIn(mode, collected);
    } else {
      this.assertEqual(collected.split("\x1b[?12s\x1b[?12l").length - 1, 1);
      this.assertLess(
        collected.indexOf("\x1b[?12l"),
        collected.indexOf("\x1b[?2026h"),
      );
      this.assertEqual(collected.split("\x1b[?12r").length - 1, 1);
      this.assertLess(
        collected.indexOf("\x1b[?1049l"),
        collected.indexOf("\x1b[?12r"),
      );
    }
    this.assertEqual(await pty.settings(), before);
    this.assertEqual((await this.panes()).length, remainingPanes);
    return collected;
  }
  async test_real_client_restores_terminal_on_detach() {
    delete this.env.CORGI_CURSOR_BLINK;
    await this.checkRealClientExit("\x02q", 1);
  }
  async test_real_client_can_keep_host_cursor_blink() {
    this.env.CORGI_CURSOR_BLINK = "1";
    await this.checkRealClientExit("\x02q", 1);
  }
  async test_real_client_steady_cursor_still_honors_hidden_cursor() {
    delete this.env.CORGI_CURSOR_BLINK;
    const pane = (
      await this.open_pane({
        command: "printf '\\033[?25lCURSOR_HIDDEN'; sleep 30",
      })
    ).pane;
    await this.until(async () =>
      (
        await this.command("pane.read", { target: pane, view: "screen" })
      ).text.includes("CURSOR_HIDDEN"),
    );
    const output = await this.checkRealClientExit("\x02q", 1);
    const frames = [
      ...output.matchAll(/\x1b\[\?2026h(.*?)\x1b\[\?2026l/gs),
    ].map((match) => match[1]);
    this.assertTrue(frames.length > 0);
    this.assertTrue(frames.every((frame) => !frame.includes("\x1b[?25h")));
  }
  async test_real_client_inherits_host_theme_and_answers_child_color_queries() {
    const pty = await Pty.spawn([EXE], { env: this.env, cols: 80, rows: 24 });
    this.pty = pty;
    await pty.waitFor("\x1b]11;?", 4000);
    pty.write("printf EARLY_INPUT_OK\r\x1b]10;rgb:dddd/");
    pty.write("dddd/dddd\x1b\\\x1b]11;rgb:1e/1e/1e\x07");
    for (let i = 0; i < 16; i++) pty.write(`\x1b]4;${i};rgb:11/cc/33\x1b\\`);
    await pty.waitFor("EARLY_INPUT_OK", 4000);
    await pty.waitFor("48;2;30;30;30m", 4000);
    this.assertNotIn(
      "rgb:",
      (await this.command("pane.read", { target: 1, view: "screen" })).text,
    );
    const probe = join(import.meta.dir, "fixtures/color_probe.ts"),
      result = join(this.temp.name, "colors.json");
    const ident = (
      await this.open_pane({
        cwd: this.temp.name,
        command: shellJoin([process.execPath, probe, result]),
      })
    ).pane;
    await this.until(() => existsSync(result));
    const replies = json(result);
    this.assertIn("\x1b]10;rgb:dddd/dddd/dddd\x1b\\", replies);
    this.assertIn("\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\", replies);
    this.assertIn("\x1b]4;2;rgb:1111/cccc/3333\x1b\\", replies);
    await pty.waitFor("48;2;57;57;57m COMPOSER ", 4000);
    pty.write("\x1b]11;rgb:22/22/22\x07");
    await pty.waitFor("48;2;34;34;34m", 4000);
    await this.command("pane.close", { target: ident });
    pty.write("\x02q");
    this.assertEqual(await deadline(pty.proc.exited, 3000), 0);
  }
  async test_real_client_returns_to_terminal_on_last_shell_exit() {
    await this.checkRealClientExit("exit\r", 0);
    this.assertEqual((await this.session()).closed_panes, 1);
  }
  async test_real_client_returns_to_terminal_on_last_tab_close() {
    await this.open_pane({ cwd: this.temp.name });
    await this.split_pane("right", { cwd: this.temp.name });
    const ident = (
      await this.rpc({
        op: "native.start",
        provider: "codex",
        cwd: this.temp.name,
      })
    ).session;
    await this.checkRealClientExit("\x02X\x02c\r", 0);
    this.assertEqual((await this.session()).closed_panes, 2);
    this.assertEqual(
      (await this.rpc({ op: "native.list" })).sessions[0].id,
      ident,
    );
  }
}

registerCase("smoke terminal", SmokeTerminal, { timeout: 120_000 });

class Discovery extends TestCase {
  temp!: ReturnType<typeof tempDir>;
  root!: string;
  env!: Record<string, string | undefined>;
  async setUp() {
    this.temp = tempDir("corgi-discovery-");
    this.root = this.temp.name;
    this.env = { ...process.env, HOME: this.root, PATH: "", CORGI_TEST_SYSTEM_ROOT: join(this.root, "system") };
    delete this.env.CORGI_CODEX_BIN;
  }
  async tearDown() {
    this.temp?.cleanup();
  }
  script(relative: string, body: string) {
    const path = join(this.root, relative);
    mkdirSync(join(path, ".."), { recursive: true });
    writeExecutable(path, "#!/bin/sh\n" + body + "\n");
    return path;
  }
  async which() {
    const result = await run([EXE, "which", "codex"], {
      env: this.env,
      cwd: this.root,
      timeout: 5000,
    });
    this.assertEqual(result.stderr, "");
    return result.stdout.trim();
  }
  async test_skip_broken_and_false_positive_path_entries() {
    const broken = this.script(
      "broken/codex",
      'echo "missing native package" >&2; exit 1',
    );
    const unrelated = this.script("unrelated/codex", 'echo "another tool 1.0"');
    const valid = this.script("valid/codex", 'echo "codex-cli 1.2.3"');
    this.env.PATH = [broken, unrelated, valid]
      .map((path) => join(path, ".."))
      .join(":");
    this.assertEqual(await this.which(), valid);
    const result = await run([EXE, "agent", "codex", "--version"], {
      env: { ...this.env, CORGI_PANE: "1" },
      timeout: 5000,
    });
    this.assertEqual(
      [result.code, result.stdout.trim()],
      [0, "codex-cli 1.2.3"],
    );
  }
  async test_skip_hanging_candidate() {
    const hung = this.script("hung/codex", "/bin/sleep 30");
    const valid = this.script("valid/codex", 'echo "codex-cli 1.2.3"');
    this.env.PATH = [hung, valid].map((path) => join(path, "..")).join(":");
    this.assertEqual(await this.which(), valid);
  }
  async test_preserve_symlink_shim_invocation() {
    const shim = this.script(
      "shared/shim",
      'case "$0" in */codex) echo "codex-cli 1.2.3";; *) exit 1;; esac',
    );
    const link = join(this.root, "bin/codex");
    mkdirSync(join(link, ".."));
    symlinkSync(shim, link);
    this.env.PATH = join(link, "..");
    this.assertEqual(await this.which(), link);
  }
  async test_relative_path_resolves_to_absolute_executable() {
    const valid = this.script("relative/codex", 'echo "codex-cli 1.2.3"');
    this.env.PATH = "relative";
    const found = await this.which();
    this.assertTrue(found.startsWith("/"));
    this.assertEqual(realpathSync(found), realpathSync(valid));
  }
  async test_user_install_fallback() {
    const valid = this.script(".local/bin/codex", 'echo "codex-cli 1.2.3"');
    this.assertEqual(await this.which(), valid);
  }
  async test_renamed_user_app_bundle_fallback() {
    const valid = this.script(
      "Applications/Codex Beta.app/Contents/Resources/codex",
      'echo "codex-cli 1.2.3"',
    );
    this.assertEqual(await this.which(), valid);
  }
  async test_explicit_override_is_preserved() {
    this.env.CORGI_CODEX_BIN = "/custom/provider";
    this.assertEqual(await this.which(), "/custom/provider");
  }
}

registerCase("executable discovery", Discovery, {
  skipTests: {
    test_renamed_user_app_bundle_fallback:
      process.platform === "darwin" ? "" : "macOS app bundles",
  },
});
