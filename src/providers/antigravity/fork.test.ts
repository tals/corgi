import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Terminal } from "../../pane/terminal";
import { Launch } from "../../runtime";
import { directory } from "./config";
import { interactiveFork } from "./fork";
import { rename } from "./screen";

const source = "11111111-1111-4111-8111-111111111111",
  child = "22222222-2222-4222-8222-222222222222";

test("a shell-started Antigravity keeps relative settings from the process directory and preserves inline JSON", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "corgi-fork-settings-"))),
    script = join(dir, "agy"),
    json = ' {"editorMode":"vim"}';
  try {
    writeFileSync(script, "console.log('ready'); setInterval(() => {}, 60000);");
    for (const [args, value] of [
      [["--settings", "custom settings.json"], join(dir, "custom settings.json")],
      [["--settings=" + json], json],
    ] as const) {
      const cli = Bun.spawn([process.execPath, script, ...args], { cwd: dir, stdout: "pipe" });
      try {
        await cli.stdout.getReader().read();
        expect(Launch.observed("antigravity", cli.pid, "/elsewhere").agent?.args).toEqual(["--settings", value]);
      } finally {
        cli.kill();
        await cli.exited;
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the fork callback preserves launch overrides and the original title after confirmation", () => {
  const home = mkdtempSync(join(tmpdir(), "corgi-fork-title-"));
  try {
    mkdirSync(directory(home), { recursive: true });
    const saved = JSON.stringify({ title: { command: "cat", enabled: true } });
    writeFileSync(join(directory(home), "settings.json"), saved);
    writeFileSync(join(home, "custom settings.json"), '\uFEFF{"editorMode":"vim"}');
    const fork = interactiveFork(
      source,
      {
        args: ["--settings", '{"editorMode":"default"}', "--settings=custom settings.json"],
        cwd: home,
      },
      home,
    );
    const file = fork.args[1],
      config = JSON.parse(readFileSync(file, "utf8")),
      payload = JSON.stringify({ conversation_id: source, agent_state: "idle" }),
      title = () => spawnSync("/bin/sh", ["-c", config.title.command], { input: payload, encoding: "utf8" }).stdout;
    try {
      expect(fork.env).toEqual([["AGY_CLI_DISABLE_AUTO_UPDATE", "true"]]);
      expect(config.editorMode).toBe("vim");
      expect(title()).toBe(payload);
      expect(readFileSync(join(dirname(file), "state.json"), "utf8")).toBe(payload);
    } finally {
      fork.close();
    }
    expect(title()).toBe(payload);
    expect(existsSync(dirname(file))).toBe(false);
    expect(readFileSync(join(directory(home), "settings.json"), "utf8")).toBe(saved);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Antigravity only accepts input at the focused composer", () => {
  const terminal = new Terminal(60, 12);
  try {
    terminal.feed("────────────\r\n> \r\n────────────\x1b[2;3H");
    expect(rename.empty(terminal)).toBe(true);
    terminal.feed("\x1b[?25l");
    expect(rename.empty(terminal)).toBe(false);
    terminal.feed("\x1b[?25h\x1b[5;3H");
    expect(rename.empty(terminal)).toBe(false);
    const command = "/rename 設計";
    terminal.feed("\x1b[2;3H" + command);
    expect(rename.holds(terminal, command)).toBe(true);
    terminal.feed("\x1b[D");
    expect(rename.holds(terminal, command)).toBe(false);
  } finally {
    terminal.destroy();
  }
});

test("a lost confirmation after Enter never submits /fork a second time", async () => {
  const home = mkdtempSync(join(tmpdir(), "corgi-fork-ack-")),
    fork = interactiveFork(source, { args: [], cwd: home }, home),
    terminal = new Terminal(60, 12),
    input: string[] = [];
  let live = true;
  const report = (id: string, state: string) =>
      writeFileSync(
        join(dirname(fork.args[1]), "state.json"),
        JSON.stringify({ conversation_id: id, agent_state: state }),
      ),
    draw = (draft: string) =>
      terminal.feed(
        "\x1b[?2004h\x1b[2J\x1b[H────────────\r\n> " + draft + "\r\n────────────\x1b[2;" + (3 + draft.length) + "H",
      );
  terminal.send = bytes => {
    input.push(bytes.toString());
    terminal.input_revision++;
    if (input.length === 1) draw("/fork");
    else live = false;
  };
  try {
    draw("");
    report(child, "idle");
    const finishing = fork.finish(terminal, () => live);
    await Bun.sleep(65);
    expect(input).toEqual([]);
    report(source, "working");
    await Bun.sleep(65);
    expect(input).toEqual([]);
    report(source, "idle");
    await expect(finishing).rejects.toThrow("ForkUnconfirmed");
    expect(input).toEqual(["\x1b[200~/fork\x1b[201~", "\r"]);
  } finally {
    live = false;
    terminal.destroy();
    fork.close();
    rmSync(home, { recursive: true, force: true });
  }
});
