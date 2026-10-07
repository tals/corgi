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
import { dirname, join, resolve } from "node:path";
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
import { FAKE, PALETTE, Runtime } from "./runtime";
import { CodexObserver, write_codex_terminal } from "./provider_sim";

const file = (path: string) => readFileSync(path, "utf8");
const json = (path: string) => JSON.parse(file(path));
const hash = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const b64 = (data: string | Buffer) => Buffer.from(data).toString("base64");
/** Kitty clipboard packets as Ghostty sends them. */
const packet = (status: string, rest = "") =>
  `\x1b]5522;type=read:status=${status}${rest}\x1b\\`;
const paste = (pw: string, listing: string) =>
  packet("OK", `:pw=${b64(pw)}`) +
  packet("DATA", `:mime=Lg==:pw=${b64(pw)};${b64(listing)}`) +
  packet("DONE", `:pw=${b64(pw)}`);
/** The read a viewer sends with a paste's password. */
const read = (pw: string, types: string) =>
  `\x1b]5522;type=read:id=corgi:pw=${b64(pw)}:name=${b64("Corgi")};${b64(types)}\x1b\\`;

class SmokeTerminal extends Runtime {
  async test_kitty_badge_confirms_chunked_upload_after_wrong_id_acknowledgement() {
    const received = join(this.temp.name, "badge-input");
    await this.open_pane({
      command: `stty -echo; printf INPUT_READY; IFS= read -r line; printf %s "$line" > ${quote(received)}; sleep 30`,
    });
    const pty = await Pty.spawn([EXE, "attach"], {
      env: this.env,
      cwd: this.temp.name,
      cols: 100,
      rows: 30,
    });
    this.pty = pty;
    await pty.waitFor("\x1b_Ga=q,i=730031");
    await pty.waitFor("INPUT_READY");
    pty.write("\x1b_Gi=730031;OK\x1b\\");
    await pty.waitFor("\x1b_Gm=0;");
    // Styling becomes available as soon as the capability probe succeeds.
    await pty.waitFor(`\x1b[0;38;2;${PALETTE.accent};48;2;${PALETTE.selected}m▌`);
    const placement = "\x1b_Ga=p,i=730031,p=1,c=3,z=1,C=1,q=";
    this.assertNotIn(placement + "1", pty.output);
    // Simulate iTerm2's final-chunk acknowledgement, then its reordered
    // placement response. The viewer must recover without another upload.
    pty.write("\x1b_Gi=0;OK\x1b\\");
    await pty.waitFor(placement + "0");
    const offset = pty.output.length;
    pty.write("\x1b_Gp=1,i=730031;OK\x1b\\");
    await pty.waitFor((output) => output.slice(offset).includes(placement + "1"));
    this.assertEqual(pty.output.split("\x1b_Ga=t,").length - 1, 1);
    pty.write("badge-input-ok\r");
    await this.until(() => existsSync(received));
    this.assertEqual(file(received), "badge-input-ok");
  }

  /** Plays Ghostty for a viewer over SSH: paste events and reads allowed. */
  async pasteEventsOn(pty: Pty) {
    await pty.waitFor("\x1b[?5522$p");
    pty.write("\x1b[?5522;2$y");
    await pty.waitFor("\x1b]5522;type=read:id=corgi-probe;Lg==\x1b\\");
    pty.write(
      packet("OK", ":id=corgi-probe") +
        packet("DATA", `:id=corgi-probe:mime=Lg==;${b64("image/png\n")}`) +
        packet("DONE", ":id=corgi-probe"),
    );
    await pty.waitFor("\x1b[?5522h");
  }
  async sshViewer() {
    const pty = await Pty.spawn([EXE, "attach"], {
      env: { ...this.env, SSH_CONNECTION: "192.0.2.1 50000 192.0.2.2 22" },
      cwd: this.temp.name,
      cols: 100,
      rows: 30,
    });
    this.pty = pty;
    await this.pasteEventsOn(pty);
    return pty;
  }
  async test_cmd_v_without_paste_events_opens_a_card_at_the_caret() {
    const received = join(this.temp.name, "card-input");
    await this.open_pane({
      command: `stty raw -echo; printf CARD_READY; exec cat > ${quote(received)}`,
    });
    const pty = await Pty.spawn([EXE, "attach"], {
      env: { ...this.env, SSH_CONNECTION: "192.0.2.1 50000 192.0.2.2 22" },
      cwd: this.temp.name,
      cols: 100,
      rows: 30,
    });
    this.pty = pty;
    // Play Ghostty 1.3.1: it names itself and has no paste events.
    await pty.waitFor("\x1b[>0q");
    pty.write("\x1bP>|ghostty 1.3.1\x1b\\\x1b[?5522;0$y");
    await pty.waitFor("CARD_READY");
    // Ghostty passes Cmd+V on as a key when it had no text to paste.
    pty.write("\x1b[118;9u");
    await pty.waitFor("Ghostty 1.3.1 can't send images over SSH.");
    this.assertIn("Image not pasted", pty.output);
    this.assertIn("⇧⌘-click opens · click copies", pty.output);
    this.assertRegex(
      pty.output,
      /\x1b\]8;;https:\/\/github\.com\/ghostty-org\/ghostty\/releases\/tag\/tip\x1b\\(?:\x1b\[[0-9;:]*m)*\x1b\[4m(?:\x1b\[[0-9;:]*m)*Ghostty Nightly/,
    );
    // A plain click on the download link copies it; the card stays open.
    // (Cmd+Shift-click opens it in the terminal, which never tells Corgi.)
    const url = "https://github.com/ghostty-org/ghostty/releases/tag/tip";
    // The row may be redrawn from its border: count what precedes the label.
    const link = /\x1b\[(\d+);(\d+)H((?:(?!\x1b\[\d+;\d+H)[^])*?)Download: /.exec(pty.output)!;
    const before = [...link[3].replace(/\x1b\[[0-9;:]*m|\x1b\]8;[^\x1b]*\x1b\\/g, "")].length;
    const [row, column] = [Number(link[1]), Number(link[2]) + before + "Download: ".length + 2];
    let offset = pty.output.length;
    pty.write(`\x1b[<0;${column};${row}M\x1b[<0;${column};${row}m`);
    await pty.waitFor((output) => output.slice(offset).includes("Copied to clipboard"));
    this.assertIn(`\x1b]52;c;${b64(url)}\x07`, pty.output.slice(offset));
    // The viewer sends only changed cells; a resize redraws the whole screen.
    const wholeFrame = async (rows: number) => {
      const start = pty.output.length;
      pty.resize(100, rows);
      await pty.waitFor((output) => /\x1b\[H\x1b\[J[^]*\x1b\[\?2026l/.test(output.slice(start)));
      const frame = pty.output.slice(start);
      return frame.slice(frame.lastIndexOf("\x1b[H\x1b[J"));
    };
    this.assertIn("Image not pasted", await wholeFrame(31));
    // Esc closes the card and reaches nothing else; the next key goes through.
    offset = pty.output.length;
    pty.write("\x1b[27u");
    await pty.waitFor((output) => output.slice(offset).includes("\x1b[?2026l"));
    this.assertNotIn("Image not pasted", await wholeFrame(30));
    pty.write("x");
    await this.until(() => existsSync(received) && file(received) === "x");
  }
  async test_relays_a_paste_to_a_program_that_takes_paste_events() {
    const received = join(this.temp.name, "relayed");
    const program = join(this.temp.name, "paste_events.ts");
    // Takes a paste event, then reads the image with the event's password.
    writeFileSync(
      program,
      `const fs = require("fs");
process.stdin.setRawMode(true);
process.stdout.write("\\x1b[?5522hRELAY_READY");
let input = "";
let asked = false;
process.stdin.on("data", (chunk) => {
  input += chunk.toString("latin1");
  const event = input.match(/status=OK:pw=([^\\x1b]+)\\x1b\\\\[\\s\\S]*status=DONE/);
  if (!asked && event) {
    asked = true;
    input = "";
    process.stdout.write("\\x1b]5522;type=read:pw=" + event[1] + ":name=YXBw;aW1hZ2UvcG5n\\x1b\\\\");
  } else if (asked && input.includes("status=DONE")) {
    const chunks = [...input.matchAll(/status=DATA[^;]*;([A-Za-z0-9+/=]+)/g)];
    fs.writeFileSync(process.argv[2], Buffer.concat(chunks.map((m) => Buffer.from(m[1], "base64"))));
  }
});
`,
    );
    await this.open_pane({
      command: shellJoin([process.execPath, program, received]),
    });
    const pty = await this.sshViewer();
    await pty.waitFor("RELAY_READY");
    pty.write(paste("relay", "text/plain image/png\n"));
    await pty.waitFor(read("relay", "text/plain image/png"));
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("relayed image"),
    ]);
    pty.write(
      packet("OK", ":id=corgi") +
        packet("DATA", `:id=corgi:mime=${b64("text/plain")};${b64("caption")}`) +
        packet("DATA", `:id=corgi:mime=${b64("image/png")};${b64(png)}`) +
        packet("DONE", ":id=corgi"),
    );
    await this.until(() => existsSync(received) && readFileSync(received).equals(png));
  }
  async test_image_paste_over_ssh_saves_the_image_and_pastes_its_path() {
    const received = join(this.temp.name, "paste-input");
    await this.open_pane({
      command: `stty raw -echo; printf PASTE_READY; exec cat > ${quote(received)}`,
    });
    const pty = await this.sshViewer();
    await pty.waitFor("PASTE_READY");
    pty.write(paste("first", "image/png\n"));
    await pty.waitFor(read("first", "image/png"));
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("image bytes"),
    ]);
    const mime = `:id=corgi:mime=${b64("image/png")}`;
    pty.write(
      packet("OK", ":id=corgi") +
        packet("DATA", `${mime};${b64(png.subarray(0, 9))}`) +
        packet("DATA", `${mime};${b64(png.subarray(9))}`) +
        packet("DONE", ":id=corgi"),
    );
    const name = createHash("sha256").update(png).digest("hex").slice(0, 32);
    const saved = join(dirname(this.path), "paste", `${name}.png`);
    await this.until(() => existsSync(received) && file(received) === saved);
    this.assertTrue(readFileSync(saved).equals(png));
    this.assertEqual(statSync(saved).mode & 0o777, 0o600);
    // With text on the clipboard too, the text is what pastes.
    pty.write(paste("second", "text/plain image/png\n"));
    await pty.waitFor(read("second", "text/plain"));
    pty.write(
      packet("OK", ":id=corgi") +
        packet("DATA", `:id=corgi:mime=${b64("text/plain")};${b64(" and text")}`) +
        packet("DONE", ":id=corgi"),
    );
    await this.until(() => file(received) === saved + " and text");
  }

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
    const session = "01901234-1234-1234-1234-123456789abc";
    const transcript = join(this.temp.name, "sounds.jsonl");
    writeFileSync(
      transcript,
      JSON.stringify({ type: "session_meta", payload: { id: session } }) +
        "\n",
    );
    const terminal = write_codex_terminal(join(this.temp.name, "codex"), session);
    const observer = new CodexObserver(this.env.CODEX_HOME!, [session]);
    observer.paths[session] = transcript;
    try {
      await this.command("pane.input", { target: pane, data: `exec ${quote(terminal)}\r` });
      await this.until(async () => (await this.panes()).find((p: any) => p.id === pane).session === session);
    } finally {
      await observer.close();
    }
    let turn = "initial";
    const hook = async (event: string, seq: number) => {
      if (event === "UserPromptSubmit") turn = String(seq);
      await this.rpc({
        op: "hook",
        pane,
        provider: "codex",
        seq: Date.now() * 1000 + seq,
        event: {
          hook_event_name: event,
          session_id: session,
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
    // Run the hook inside the pane, as Claude does. Spawned from Bun, its
    // ancestry would include whatever runs the tests, and a background
    // Claude session there makes the hook count as background.
    const [input, out, err, code] = ["input", "out", "err", "code"].map(
      (name) => join(this.temp.name, `hook-${name}`),
    );
    writeFileSync(
      input,
      JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "session",
      }),
    );
    const pane = (
      await this.open_pane({
        cwd: this.temp.name,
        command: `${quote(EXE)} hook claude <${quote(input)} >${quote(out)} 2>${quote(err)}; echo $? >${quote(code)}; exec /bin/sh`,
      })
    ).pane;
    await this.until(() => existsSync(code) && file(code).endsWith("\n"));
    this.assertEqual([file(code), file(out), file(err)], ["0\n", "", ""]);
    await this.until(
      async () =>
        (await this.panes()).find((p: any) => p.id === pane)?.state ===
        "working",
    );
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
          (provider === "codex" ? "" : "ordinary-" + provider),
      );
      if (provider === "codex") {
        await this.settle();
        this.assertEqual((await this.panes()).find((p: any) => p.id === pane).session, "");
        await this.command("pane.input", { target: pane, data: "exit\r" });
        await this.assertAgentExited(pane);
        continue;
      }
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
      await this.agent_frame("codex", "▶", icon);
    }
    await this.command("pane.input", { target: pane, data: "stop\r" });
    await this.agent_frame("codex", "○", "");
  }
  async test_agent_startup_has_its_own_indicator_and_never_thinks() {
    const pane = await this.ordinary_agent("codex", false, true);
    await this.attach();
    const screen = await this.agent_frame("codex", "◌", "", PALETTE.muted);
    this.assertIn("Starting session", screen[14]);
    await sleep(0.8);
    this.assertEqual((await this.panes())[0].state, "initializing");
    await this.command("pane.input", { target: pane, data: "ready\r" });
    await this.agent_frame("codex", "○", "", PALETTE.muted);
    await this.command("pane.input", { target: pane, data: "work\r" });
    await this.agent_frame("codex", "▶", "thinking", PALETTE.accent);
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
  async test_native_acknowledgement_clears_attention_without_dropping_requests() {
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
    await this.until(async () =>
      (await this.rpc({ op: "native.list" })).sessions[0].attention ===
      "needs_input",
    );
    await this.rpc({ op: "native.events", session: ident });
    const session = (await this.rpc({ op: "native.list" })).sessions[0];
    this.assertEqual(session.attention, "none");
    this.assertEqual(session.pending_requests, 1);
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
    this.assertEqual((await this.session()).closed_panes, 0);
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
    this.assertEqual((await this.session()).closed_panes, 0);
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
    this.env = {
      ...process.env,
      HOME: this.root,
      PATH: "",
      CORGI_TEST_SYSTEM_ROOT: join(this.root, "system"),
    };
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
