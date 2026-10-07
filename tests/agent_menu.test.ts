import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Viewers } from "./viewers";
import { PALETTE, screen_text } from "./runtime";
import { registerCase, writeExecutable } from "./support";

const mouse = (button: number, x: number, y: number, release = false) =>
  `\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`;
const CLAUDE_ID = "11111111-1111-4111-8111-111111111111";
const CODEX_ID = "22222222-2222-4222-8222-222222222222";

/** A Codex input box: a bold `›`, a dim placeholder while empty, and the
 * "? for shortcuts" footer. It takes pastes and typing, and logs what Enter
 * submits to `log`. */
const codexScreen = (log: string) => `
const out = (s) => process.stdout.write(s);
let text = '';
const draw = () => {
  out('\\x1b[2J\\x1b[H\\x1b[1;2m› \\x1b[0mearlier prompt\\r\\n\\r\\n');
  out(text ? '\\x1b[1m›\\x1b[0m ' + text : '\\x1b[1m›\\x1b[0m \\x1b[2mAsk Codex to do anything\\x1b[0m');
  out('\\r\\n  gpt · /tmp\\r\\n  ' + (text ? '' : '\\x1b[1m?\\x1b[0m for shortcuts'));
  out('\\x1b[3;' + (3 + [...text].length) + 'H');
};
process.stdin.setRawMode(true);
process.stdin.on('data', (data) => {
  for (const part of data.toString().split(/\\x1b\\[20[01]~/)) for (const ch of part) {
    if (ch === '\\r') { require('node:fs').appendFileSync(${JSON.stringify(log)}, text + '\\n'); text = ''; }
    else if (ch === '\\x7f') text = [...text].slice(0, -1).join('');
    else if (ch >= ' ') text += ch;
  }
  draw();
});
out('\\x1b[?2004h');
draw();
`;

class AgentMenu extends Viewers {
  async hook(pane: number, provider: string, session: string) {
    await this.rpc({
      op: "hook",
      pane,
      provider,
      seq: 1,
      event: { hook_event_name: "SessionStart", session_id: session },
    });
  }
  async screen(pane: number) {
    return (await this.command("pane.read", { target: pane, view: "screen" }))
      .text as string;
  }
  /** A command whose refusal the test expects: the reply, `err` and all. */
  async attempt(operation: string, payload: any) {
    return this.raw_rpc({
      op: "session.command",
      protocol: 1,
      command: { [operation]: payload },
    });
  }

  async test_fork_copies_the_conversation_into_a_tab_under_its_source() {
    writeExecutable(
      join(this.temp.name, "provider"),
      "for (const arg of process.argv.slice(2)) console.log('ARG ' + arg);\nsetInterval(() => {}, 1000);\n",
    );
    const source = await this.new(),
      after = await this.new();
    this.assertEqual(
      (await this.attempt("agent.fork", { target: source })).err,
      "NoConversation",
    );
    // Claude writes the transcript with the first message; until then
    // there is nothing to copy.
    const transcript = join(this.temp.name, "transcript.jsonl");
    await this.rpc({
      op: "hook",
      pane: source,
      provider: "claude",
      seq: 1,
      event: { hook_event_name: "SessionStart", session_id: CLAUDE_ID, transcript_path: transcript },
    });
    this.assertEqual(
      (await this.attempt("agent.fork", { target: source, check: true })).err,
      "NoConversation",
    );
    writeFileSync(transcript, "");
    this.assertTrue((await this.attempt("agent.fork", { target: source, check: true })).ok);
    const { pane } = await this.command("agent.fork", { target: source, name: "Source (fork)" });
    const snapshot = await this.session();
    const tab = (id: number) => snapshot.panes.find((p: any) => p.id === id).tab;
    const tabs = snapshot.workspaces[0].model.tabs.map((t: any) => t.id);
    this.assertEqual(
      [tabs.indexOf(tab(source)), tabs.indexOf(tab(pane)), tabs.indexOf(tab(after))],
      [0, 1, 2],
    );
    // Until the fork draws, its source's screen shows under "Forking…" and
    // the command it runs.
    const forked = snapshot.panes.find((p: any) => p.id === pane);
    this.assertTrue(forked.forking);
    this.assertIn(`--resume '${CLAUDE_ID}' --fork-session`, forked.restoring);
    const args = await this.until(async () => {
      const found = (await this.screen(pane))
        .split("\n")
        .filter((line) => line.startsWith("ARG "))
        .map((line) => line.slice(4).trim());
      return found.length === 7 && found;
    });
    this.assertEqual(args.slice(0, 4), [
      "--resume",
      CLAUDE_ID,
      "--fork-session",
      "--session-id",
    ]);
    // Claude takes the name at launch.
    this.assertEqual(args.slice(5), ["--name", "Source (fork)"]);
    // The fork shows as its own conversation, by its new name, before the
    // agent reports in.
    const fork = (await this.session()).panes.find((p: any) => p.id === pane).agent;
    this.assertEqual([fork.provider, fork.session, fork.name], ["claude", args[4], "Source (fork)"]);
  }

  async test_a_codex_fork_takes_its_name_once_its_input_box_is_empty() {
    const log = join(this.temp.name, "submitted.txt");
    writeExecutable(join(this.temp.name, "provider"), codexScreen(log));
    const source = await this.new();
    await this.hook(source, "codex", CODEX_ID);
    const { pane } = await this.command("agent.fork", { target: source, name: "Copy" });
    // Before Codex reports the fork, its row already says what it is.
    const early = (await this.session()).panes.find((p: any) => p.id === pane).agent;
    this.assertEqual([early.provider, early.name], ["codex", "Copy"]);
    // Codex picks the fork's id itself and reports it once it runs.
    await this.hook(pane, "codex", "44444444-4444-4444-8444-444444444444");
    const submitted = await this.until(() => existsSync(log) && readFileSync(log, "utf8"));
    this.assertEqual(submitted, "/rename Copy\n");
  }

  async test_claude_renames_itself_when_its_messaging_socket_asks() {
    const pane = await this.new();
    await this.hook(pane, "claude", CLAUDE_ID);
    await this.command("pane.rename", { target: pane, name: "Pane name" });
    // Without a live session record, Claude offers no way in.
    this.assertEqual(
      (await this.attempt("agent.rename", { target: pane })).err,
      "RenameUnavailable",
    );
    const socket = join(this.temp.name, "peer.sock");
    const received: string[] = [];
    const server = createServer((connection) => {
      let lines = "";
      connection.on("data", (data) => (lines += data));
      connection.on("end", () => received.push(lines));
    });
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      const sessions = join(this.temp.name, ".claude/sessions");
      mkdirSync(sessions, { recursive: true });
      writeFileSync(
        join(sessions, `${process.pid}.json`),
        JSON.stringify({ pid: process.pid, sessionId: CLAUDE_ID, peerProtocol: 1, messagingSocketPath: socket }),
      );
      const hash = createHash("sha256").update(socket).digest("hex");
      writeFileSync(join(sessions, `${process.pid}.${hash}.key`), JSON.stringify({ peerToken: "secret" }));
      this.assertTrue((await this.attempt("agent.rename", { target: pane })).ok);
      this.assertEqual(
        (await this.attempt("agent.rename", { target: pane, name: "two\nlines" })).err,
        "InvalidName",
      );
      this.assertTrue(
        (await this.attempt("agent.rename", { target: pane, name: " Native name " })).ok,
      );
      const lines = (await this.until(() => received[0]))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      this.assertEqual(lines[0], { type: "auth", token: "secret" });
      this.assertEqual(
        [lines[1].type, lines[1].action, lines[1].name, lines[1].session_id],
        ["control", "rename", "Native name", CLAUDE_ID],
      );
      // The name shows at once, and the pane name that would hide it goes.
      const shown = (await this.session()).panes.find((p: any) => p.id === pane);
      this.assertEqual([shown.name, shown.agent.name], ["", "Native name"]);
    } finally {
      server.close();
    }
  }

  async test_codex_without_its_daemon_takes_rename_typed_into_an_empty_box() {
    const log = join(this.temp.name, "submitted.txt");
    const script = writeExecutable(join(this.temp.name, "codex-screen"), codexScreen(log));
    const pane = await this.new(script);
    await this.hook(pane, "codex", CODEX_ID);
    await this.until(async () => (await this.screen(pane)).includes("Ask Codex"));
    // A draft blocks it, and stays as typed.
    await this.command("pane.input", { target: pane, data: "draft" });
    await this.until(async () => (await this.screen(pane)).includes("› draft"));
    this.assertEqual(
      (await this.attempt("agent.rename", { target: pane, name: "nope" })).err,
      "AgentBusy",
    );
    await this.command("pane.input", { target: pane, data: "\x7f".repeat(5) });
    await this.until(async () => (await this.screen(pane)).includes("Ask Codex"));
    this.assertFalse(existsSync(log));
    this.assertTrue((await this.attempt("agent.rename", { target: pane, name: "typed name" })).ok);
    const submitted = await this.until(() => existsSync(log) && readFileSync(log, "utf8"));
    this.assertEqual(submitted, "/rename typed name\n");
    await this.until(async () =>
      (await this.session()).panes.find((p: any) => p.id === pane).agent.name === "typed name",
    );
  }

  async test_menu_crosses_out_what_the_agent_cannot_do() {
    const pane = await this.new();
    // A short session id is no conversation to fork, and no Claude session
    // record offers a rename.
    await this.mark_agent(pane, "Agent-0");
    const viewer = await this.newViewer();
    await viewer.input(mouse(2, 6, 16));
    const struck = `\x1b[0;9;38;2;${PALETTE.faint};48;2;${PALETTE.surface}m`;
    this.assertIn(struck + "Rename", viewer.state.data);
    this.assertIn(struck + "Fork", viewer.state.data);
    this.assertTrue(screen_text(viewer.state.data, 100, 30).some((row) => row.includes("Close")));
    // Crossed-out rows take no key; Close closes the pane.
    await viewer.input("r");
    this.assertFalse(screen_text(viewer.state.data, 100, 30).some((row) => row.includes("Rename agent")));
    await viewer.input("x");
    await this.until(async () => !(await this.panes()).some((p: any) => p.id === pane));
  }
}
registerCase("Agent menu", AgentMenu);
