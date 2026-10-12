/** PTY titles bind sessions; a read-only WebSocket observer supplies state. */
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { Runtime, screen_text } from "./runtime";
import { Viewer } from "./viewer_client";
import { sleep, shellJoin, run } from "./support";
import { CodexObserver, TerminalAttachment, write_codex_terminal } from "./provider_sim";

export const A = "01901234-1234-1234-1234-123456789abc";
export const B = "01911234-1234-1234-1234-123456789abc";
export class Titles extends Runtime {
  sim!: CodexObserver;
  attachment!: TerminalAttachment;
  attachments: TerminalAttachment[] = [];
  pane!: number;
  get errors() {
    return this.sim.errors;
  }
  set errors(v: any) {
    this.sim.errors = v;
  }
  get methods() {
    return this.sim.methods;
  }
  set methods(v: any) {
    this.sim.methods = v;
  }
  get ids() {
    return this.sim.ids;
  }
  set ids(v: any) {
    this.sim.ids = v;
  }
  get states() {
    return this.sim.states;
  }
  set states(v: any) {
    this.sim.states = v;
  }
  get turns() {
    return this.sim.turns;
  }
  set turns(v: any) {
    this.sim.turns = v;
  }
  get items() {
    return this.sim.items;
  }
  set items(v: any) {
    this.sim.items = v;
  }
  get paths() {
    return this.sim.paths;
  }
  set paths(v: any) {
    this.sim.paths = v;
  }
  get children() {
    return this.sim.children;
  }
  set children(v: any) {
    this.sim.children = v;
  }
  get wait_items() {
    return this.sim.wait_items;
  }
  set wait_items(v: any) {
    this.sim.wait_items = v;
  }
  get child_error() {
    return this.sim.child_error;
  }
  set child_error(v: any) {
    this.sim.child_error = v;
  }
  get waiting() {
    return this.sim.waiting;
  }
  set waiting(v: any) {
    this.sim.waiting = v;
  }
  async setUp() {
    await super.setUp();
    this.sim = new CodexObserver(this.env.CODEX_HOME!, [A, B]);
    this.turns[A] = ["old", "completed"];
    this.turns[B] = ["old-b", "completed"];
    this.attachments = [];
    this.attachment = await this.create_attachment(A);
    this.pane = this.attachment.pane;
    await this.until(async () => (await this.state())?.session === A || this.errors.length);
    this.assertEqual(this.errors, []);
    await this.command("pane.create", { workspace: 1, command: "sleep 60" });
  }
  async tearDown() {
    try {
      if (this.sim) await this.sim.close();
    } finally {
      await super.tearDown();
    }
  }
  async create_attachment(session: string, arguments_: string[] | null = null) {
    const fake = write_codex_terminal(join(this.temp.name, "attachment-" + this.attachments.length, "codex"), session);
    const args = arguments_ ?? ["--dangerously-bypass-approvals-and-sandbox", "resume"];
    const pane = (
      await this.command("pane.create", {
        workspace: 1,
        command: shellJoin([fake, ...args]),
      })
    ).pane;
    const attachment = new TerminalAttachment(this, pane);
    this.attachments.push(attachment);
    return attachment;
  }
  state() {
    return this.attachment.state();
  }
  title(value: string) {
    return this.attachment.send(value);
  }
  async test_resume_passthrough_and_focus_completion() {
    const text = (await this.command("pane.read", { target: this.pane, view: "screen" })).text;
    this.assertIn('ARGS:["--dangerously-bypass-approvals-and-sandbox", "resume"]', text);
    this.assertNotIn("--remote", text);
    this.assertEqual((await this.state()).completed, 0);
    this.states[A] = "active";
    this.turns[A] = ["new", "inProgress"];
    await this.until(async () => (await this.state()).state === "working");
    this.waiting = true;
    await this.until(async () => (await this.state()).state === "blocked");
    this.waiting = false;
    this.states[A] = "idle";
    this.turns[A] = ["new", "completed"];
    await this.until(async () => (await this.state()).completed === 1);
    await this.settle();
    this.assertEqual((await this.state()).completed, 1);
    await this.title(B.slice(0, 29) + "...");
    await this.until(async () => (await this.state()).session === B);
    this.assertEqual((await this.state()).completed, 0);
    this.turns[A] = ["unrelated", "completed"];
    await this.settle();
    this.assertEqual((await this.state()).completed, 0);
    this.assertEqual(this.errors, []);
  }
  async test_ambiguous_prefix_does_not_rebind() {
    this.ids.push(B.slice(0, -3) + "def");
    await this.title(B.slice(0, 29) + "...");
    await this.settle();
    this.assertNotEqual((await this.state()).session, B);
    this.ids.pop();
    await this.until(async () => (await this.state()).session === B);
  }
  async test_missing_title_prevents_updates() {
    await this.title("shell");
    await this.settle();
    this.turns[A] = ["after-title-gone", "completed"];
    await this.settle();
    this.assertEqual((await this.state()).completed, 0);
  }
  async test_resumed_work_does_not_freeze_after_protocol_falls_back_to_screen() {
    this.assertEqual((await this.state()).state, "idle");
    this.ids = [];
    await this.attachment.send("screen:idle");
    // Protocol evidence stays authoritative for five seconds.
    await this.advance(5);
    await this.until(async () => (await this.state()).source === "screen");
    await this.attachment.send("screen:working");
    await this.until(async () => (await this.state()).state === "working");
    await this.attachment.send("screen:idle");
    await this.until(async () => (await this.state()).state === "idle");
    this.assertEqual((await this.state()).completed, 0);
    this.sim.set_turn(A, "resumed-turn", "inProgress");
    this.ids = [A, B];
    await this.until(async () => {
      const s = await this.state();
      return s.source === "protocol" && s.state === "working";
    });
  }
  async test_subagent_counts_waits_and_viewer_layout() {
    const child = (id: string, parent = A, status = "active", flags: string[] = []) => ({
      id,
      parentThreadId: parent,
      status: { type: status, activeFlags: flags },
    });
    const wait = (turn = "new", status = "inProgress", sender = A) => ({
      turnId: turn,
      item: {
        type: "collabAgentToolCall",
        tool: "wait",
        status,
        senderThreadId: sender,
      },
    });
    this.children = [
      child("c1"),
      child("c2"),
      child("old", A, "idle"),
      child("unrelated", B),
      child("c3", A, "active", ["waitingOnApproval"]),
    ];
    this.states[A] = "active";
    this.turns[A] = ["new", "inProgress"];
    this.wait_items = [wait("old"), wait("new", "inProgress", B), wait()];
    const expected = { running: 2, blocked: 1, waiting: true };
    await this.until(async () => JSON.stringify((await this.state()).subagents) === JSON.stringify(expected));
    this.assertEqual((await this.state()).activity, "");
    const session = await this.rpc({ op: "session.snapshot", protocol: 1 });
    this.assertEqual(session.panes.find((p: any) => p.id === this.pane).agent.subagents, expected);
    const viewer = await Viewer.create(this);
    try {
      await this.until(async () => (await viewer.poll()).data.includes("↳2 !1"));
      const rows = screen_text(viewer.state.data, 100, 30);
      const line = rows.findIndex(r => r.includes("↳2 !1"));
      this.assertIn("Waiting on", rows[line]);
      this.assertEqual(rows[line].slice(21, 26), "↳2 !1");
      this.wait_items = [wait("new", "completed")];
      expected.waiting = false;
      await this.until(async () => JSON.stringify((await this.state()).subagents) === JSON.stringify(expected));
      await this.until(async () => {
        const data = (await viewer.poll()).data;
        return !data.includes("Waiting on agents") && !viewer.state.data.includes("◷");
      });
      this.children = [child("c1"), child("c2")];
      expected.blocked = 0;
      await this.until(async () => JSON.stringify((await this.state()).subagents) === JSON.stringify(expected));
      this.children = [child("c1", A, "idle"), child("c2", A, "idle")];
      await this.until(async () => {
        const s = (await this.state()).subagents;
        return s.running === 0 && s.blocked === 0 && !s.waiting;
      });
      await this.until(async () => !(await viewer.poll()).data.includes("↳"));
      const plain = screen_text(viewer.state.data, 100, 30);
      this.assertEqual(rows[line - 1], plain[line - 1]);
      this.children = [];
      await this.until(async () => (await this.state()).subagents.running === 0);
      await this.settle();
      const waitRequests = () =>
        this.sim.requests.filter(r => r.method === "thread/items/list" && r.params.turnId).length;
      const before = waitRequests();
      await this.settle();
      this.assertEqual(waitRequests(), before);
    } finally {
      await viewer.close();
    }
    this.assertEqual(this.errors, []);
  }
  async test_partial_child_page_does_not_publish_partial_count_or_lose_completion() {
    this.children = Array.from({ length: 3 }, (_, i) => ({
      id: String(i),
      parentThreadId: A,
      status: { type: "active" },
    }));
    await this.until(async () => (await this.state()).subagents.running === 3);
    this.child_error = true;
    this.turns[A] = ["new", "completed"];
    await this.until(async () => {
      const s = await this.state();
      return s.completed === 1 && s.subagents.running === 0;
    });
    this.child_error = false;
    await this.until(async () => (await this.state()).subagents.running === 3);
    await this.title(B.slice(0, 29) + "...");
    await this.until(async () => {
      const s = await this.state();
      return s.session === B && s.subagents.running === 0;
    });
    this.assertEqual(this.errors, []);
  }
  async test_worktree_location_follows_full_items_across_turns_and_command_directories() {
    const repo = realpathSync(this.temp.name),
      one = join(repo, "one"),
      two = join(repo, "two");
    const git = (...args: string[]) => run(["git", "-C", repo, ...args], { env: this.env });
    await git("init", "-b", "main");
    await git("config", "user.name", "Test");
    await git("config", "user.email", "test@example.invalid");
    await git("config", "commit.gpgsign", "false");
    await git("commit", "--allow-empty", "-m", "base");
    await git("worktree", "add", "-b", "one", one);
    await git("worktree", "add", "-b", "two", two);
    const fake = write_codex_terminal(join(repo, "worktree-agent", "codex"), A),
      opened = await this.command("workspace.create", { cwd: repo }),
      pane = await this.command("pane.create", { workspace: opened.workspace, cwd: repo, command: shellJoin([fake]) });
    this.pane = pane.pane;
    this.attachment = new TerminalAttachment(this, this.pane);
    this.attachments.push(this.attachment);
    this.sim.cwds[A] = repo;
    this.sim.cwds[B] = repo;
    this.states[A] = "active";
    this.turns[A] = ["new", "inProgress"];
    this.items[A] = [{ type: "userMessage", content: [{ type: "text", text: "continue" }] }];
    const edit = { type: "fileChange", status: "completed", changes: [{ path: join(one, "file") }] };
    this.sim.history_items[A] = [
      { turnId: "old", item: { type: "agentMessage", text: "done" } },
      { turnId: "old", item: edit },
    ];
    const association = async () =>
      (await this.session()).workspaces
        .find((w: any) => w.id === opened.workspace)
        .worktrees?.agents.find((a: any) => a.target.pane === this.pane);
    await this.untilAdvancing(4, async () => (await association())?.path === one);
    this.assertEqual((await association()).source, "write");
    this.items[A].push({ type: "commandExecution", status: "completed", cwd: two, command: "pwd" });
    await this.untilAdvancing(4, async () => (await association())?.path === two);
    this.assertEqual((await association()).source, "cwd");
    this.assertEqual((await this.state()).cwd, repo);
    this.items[A].push(edit, {
      type: "commandExecution",
      status: "completed",
      cwd: repo,
      command: "cat " + join(two, "file"),
    });
    await this.untilAdvancing(4, async () => (await association())?.path === one);
    this.assertEqual((await association()).source, "write");
    this.sim.history_items[A] = this.items[A].toReversed().map(item => ({ turnId: "new", item }));
    this.turns[A] = ["next", "inProgress"];
    this.items[A] = [{ type: "userMessage", content: [{ type: "text", text: "continue again" }] }];
    await this.sim.wait_for_request("thread/items/list", { session: A, after: this.sim.requests.length });
    await this.advance(4);
    this.assertEqual((await association()).path, one);
    await this.title(B.slice(0, 29) + "...");
    await this.untilAdvancing(
      4,
      async () => (await this.state()).session === B && (await association())?.path === repo,
    );
    this.assertEqual((await association()).source, "cwd");
    this.assertEqual(this.errors, []);
  }
}
