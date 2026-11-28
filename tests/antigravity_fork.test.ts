import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Viewers } from "./viewers";
import { screen_text } from "./runtime";
import { mouse, registerCase, shellJoin, writeExecutable } from "./support";

class AntigravityFork extends Viewers {
  async test_fork_preserves_launcher_options_and_stops_before_a_dialog() {
    await this.forkFrom("launcher");
  }

  async test_fork_and_resume_preserve_the_saved_shell_command_and_its_environment() {
    await this.forkFrom("command");
  }

  private async forkFrom(entry: "launcher" | "command") {
    const parent = "33333333-3333-4333-8333-333333333333",
      child = "55555555-5555-4555-8555-555555555555",
      grandchild = "66666666-6666-4666-8666-666666666666",
      presence = join(this.temp.name, ".gemini/antigravity-cli/presence"),
      log = join(this.temp.name, "submissions"),
      wake = join(this.temp.name, "wake.json"),
      modal = join(this.temp.name, "dialog"),
      sourceDir = realpathSync(this.temp.name),
      destination = join(sourceDir, "project");
    mkdirSync(presence, { recursive: true });
    mkdirSync(destination);
    writeFileSync(join(sourceDir, "settings.json"), '{"editorMode":"vim"}');
    writeFileSync(join(destination, "settings.json"), '{"editorMode":"default"}');
    this.env.CORGI_ANTIGRAVITY_BIN = writeExecutable(
      join(this.temp.name, "agy"),
      `
const fs = require('node:fs'), cp = require('node:child_process');
const parent = ${JSON.stringify(parent)}, child = ${JSON.stringify(child)}, presence = ${JSON.stringify(presence)};
const resumed = process.argv.includes('--conversation');
let id = resumed ? process.argv[process.argv.lastIndexOf('--conversation')+1] : parent, draft = '', lock;
const cfg = resumed ? JSON.parse(fs.readFileSync(process.argv[process.argv.lastIndexOf('--settings')+1], 'utf8')) : {};
function report(state) {
  if (cfg.title?.command) cp.execSync(cfg.title.command, { input: JSON.stringify({ conversation_id: id, agent_state: state }) });
}
function draw() {
  process.stdout.write('\\x1b[?2004h\\x1b[2J\\x1b[H────────────\\r\\n> ' + draft + '\\r\\n────────────\\x1b[2;' + (3+draft.length) + 'H');
}
function select(session) {
  id = session;
  lock = fs.openSync(presence + '/' + id + '.lock', 'a');
}
process.stdin.setRawMode(true);
process.stdin.on('data', data => {
  if (!resumed) { if (lock === undefined) select(parent); return; }
  for (const c of data.toString().replace(/\\x1b\\[20[01]~/g,'')) {
    if (c === '\\r') {
      fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify([id, draft, process.env.AGY_CLI_DISABLE_AUTO_UPDATE, cfg.editorMode, process.cwd(), process.env.FORK_TEST_TAG, process.env.WRAPPER_TEST_TAG])+'\\n');
      if (draft === '/fork') select(id === parent ? child : ${JSON.stringify(grandchild)});
      draft = '';
      report('idle');
    } else if (!fs.existsSync(${JSON.stringify(modal)})) draft += c;
  }
  draw();
});
draw();
if (resumed && !cfg.title?.command) {
  select(id);
  fs.writeFileSync(${JSON.stringify(wake)}, JSON.stringify([id, cfg.editorMode, process.cwd(), process.env.FORK_TEST_TAG, process.env.WRAPPER_TEST_TAG]));
} else if (resumed) { report('initializing'); setTimeout(() => report('idle'), 200); }
`,
    );
    await this.restart_runtime();
    const wrapper = join(sourceDir, "work-agent");
    writeFileSync(
      wrapper,
      "#!/bin/sh\nexport WRAPPER_TEST_TAG=wrapped\nexec " +
        shellJoin([this.env.CORGI_ANTIGRAVITY_BIN]) +
        ' --settings=settings.json "$@"\n',
      { mode: 0o755 },
    );
    const custom = entry === "command";
    if (custom) await this.command("agent.command", { index: 0, command: "FORK_TEST_TAG=blue ./work-agent" });
    else await this.command("agent.launcher.configure", { row: "antigravity", flags: "--settings=settings.json" });
    const { pane: source } = custom
        ? await this.command("agent.command.create", { workspace: 1, index: 0, cwd: sourceDir })
        : await this.command("agent.create", { workspace: 1, provider: "antigravity", cwd: sourceDir }),
      markers = custom ? ["blue", "wrapped"] : [null, null],
      state = async (id: number) => (await this.session()).panes.find((p: any) => p.id === id)?.agent;
    await this.until(async () => (await state(source))?.provider === "antigravity");
    this.assertEqual(
      (await this.raw_rpc({ op: "session.command", command: { "agent.fork": { target: source, check: true } } })).err,
      "NoConversation",
    );
    await this.command("pane.input", { target: source, data: "\r" });
    await this.until(async () => (await state(source))?.session === parent);
    await this.rpc({
      op: "hook",
      pane: source,
      provider: "antigravity",
      event: { hookEventName: "SessionStart", conversationId: parent, cwd: destination },
    });
    await this.until(async () => (await state(source))?.cwd === destination);
    const viewer = await this.newViewer();
    await viewer.input(mouse(2, 6, 16));
    this.assertTrue(screen_text(viewer.state.data, 100, 30).some(row => row.includes("Fork")));

    const { pane } = await this.command("agent.fork", { target: source, name: "Copy" });
    await this.until(() => existsSync(log) && readFileSync(log, "utf8").includes("/rename Copy"));
    const submissions = () =>
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map(line => JSON.parse(line));
    this.assertEqual(submissions(), [
      [parent, "/fork", "true", "vim", destination, ...markers],
      [child, "/rename Copy", "true", "vim", destination, ...markers],
    ]);
    this.assertEqual((await state(pane)).session, child);
    this.assertEqual((await state(source)).session, parent);

    const nested = await this.command("agent.fork", { target: pane });
    this.assertEqual((await state(nested.pane)).session, grandchild);
    this.assertEqual((await state(pane)).session, child);
    this.assertEqual(submissions().at(-1), [child, "/fork", "true", "vim", destination, ...markers]);
    await this.command("pane.hibernate", { targets: [pane] });
    await this.command("pane.wake", { target: pane });
    await this.until(() => existsSync(wake));
    this.assertEqual(JSON.parse(readFileSync(wake, "utf8")), [child, "vim", destination, ...markers]);
    if (custom) return;
    writeFileSync(modal, "");
    this.assertEqual(
      (await this.raw_rpc({ op: "session.command", command: { "agent.fork": { target: source, name: "Blocked" } } }))
        .err,
      "ForkNotReady",
    );
    this.assertEqual(submissions().length, 3);
  }
}
registerCase("Antigravity fork", AntigravityFork);
