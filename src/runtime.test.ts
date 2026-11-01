import { test, expect } from "bun:test";
import { Runtime, Pane, Launch, Ghost, ending } from "./runtime";
import { program } from "./process_name";
import { Terminal } from "./pane/terminal";
import { n, ptr, waitpid } from "./native_bridge";
import { Text } from "./providers";
import { Workspace } from "./workspace";
import { Attachment } from "./conversations";
import { Agent } from "./agents";
import { ResumeHint } from "./resume_hint";
import type { Session } from "./headless";
function add(r: Runtime, w: Workspace, split: number | null = null) {
  w.model.next_id = r.workspaces.next_pane_id;
  const id = split === null ? w.model.newTab("") : w.model.split(split, "horizontal");
  r.workspaces.next_pane_id = w.model.next_id;
  const p = new Pane(id, Terminal.create(20, 4), "/tmp");
  r.panes.push(p);
  return p;
}
function setup() {
  const r = new Runtime(),
    w = new Workspace(1, "/tmp");
  r.workspaces.items = [w];
  return { r, w };
}
test("stars follow conversations after closing and reopening, until explicitly removed", () => {
  const { r, w } = setup();
  try {
    const actor = r.conversations.get("claude", "starred-session"),
      first = add(r, w);
    first.attachment.select(actor);
    r.starAgent(w, { pane: first.id }, true);
    r.raiseEntered();
    actor.state.state = "done";
    r.raiseEntered();
    expect(w.pinned_agents.has({ pane: first.id })).toBe(true);
    r.close(first.id);
    // Another star change can discard the old pane's saved order.
    const other = add(r, w);
    other.attachment.select(r.conversations.get("claude", "other"));
    r.starAgent(w, { pane: other.id }, true);
    expect(w.pinned_agents.has({ pane: first.id })).toBe(false);
    expect(w.starred_sessions.has("claude", "starred-session")).toBe(true);
    const reopened = add(r, w);
    reopened.attachment.select(r.conversations.get("claude", "starred-session"));
    r.raiseEntered();
    expect(w.pinned_agents.has({ pane: reopened.id })).toBe(true);
    r.starAgent(w, { pane: reopened.id }, false);
    r.raiseEntered();
    expect(w.pinned_agents.has({ pane: reopened.id })).toBe(false);
    expect(w.starred_sessions.has("claude", "starred-session")).toBe(false);
    // A different conversation in a starred pane does not inherit its star.
    other.attachment.select(r.conversations.get("claude", "replacement"));
    r.raiseEntered();
    expect(w.pinned_agents.has({ pane: other.id })).toBe(false);
    expect(w.starred_sessions.has("claude", "other")).toBe(true);
  } finally {
    r.destroy();
  }
});
test("an explicit star during replacement startup follows the new conversation", () => {
  const { r, w } = setup();
  try {
    const p = add(r, w),
      target = { pane: p.id };
    p.attachment.select(r.conversations.get("claude", "previous"));
    r.raiseEntered();
    p.attachment.deselect();
    p.agent().provider = "claude";
    r.raiseEntered();
    r.starAgent(w, target, true);
    r.raiseEntered();
    expect(w.pinned_agents.has(target)).toBe(true);
    expect(w.starred_sessions.slice()).toEqual([]);
    p.attachment.select(r.conversations.get("claude", "replacement"));
    r.raiseEntered();
    expect(w.pinned_agents.has(target)).toBe(true);
    expect(w.starred_sessions.slice()).toEqual([{ provider: "claude", session: "replacement" }]);
    r.starAgent(w, target, false);
    r.raiseEntered();
    expect(w.pinned_agents.has(target)).toBe(false);
    expect(w.starred_sessions.slice()).toEqual([]);
  } finally {
    r.destroy();
  }
});
test("a star does not pass to a replacement through an unidentified startup", () => {
  const { r, w } = setup();
  try {
    const p = add(r, w),
      target = { pane: p.id };
    p.attachment.select(r.conversations.get("claude", "previous"));
    r.starAgent(w, target, true);
    r.raiseEntered();
    p.attachment.deselect();
    p.agent().provider = "claude";
    r.raiseEntered();
    p.attachment.select(r.conversations.get("claude", "replacement"));
    r.raiseEntered();
    expect(w.pinned_agents.has(target)).toBe(false);
    expect(w.starred_sessions.slice()).toEqual([{ provider: "claude", session: "previous" }]);
  } finally {
    r.destroy();
  }
});
test("unstarring during an unidentified startup forgets the last conversation's star", () => {
  const { r, w } = setup();
  try {
    const p = add(r, w),
      target = { pane: p.id };
    p.attachment.select(r.conversations.get("claude", "previous"));
    r.starAgent(w, target, true);
    r.raiseEntered();
    p.attachment.deselect();
    p.agent().provider = "claude";
    r.raiseEntered();
    r.starAgent(w, target, false);
    r.raiseEntered();
    expect(w.starred_sessions.slice()).toEqual([]);
    p.attachment.select(r.conversations.get("claude", "previous"));
    r.raiseEntered();
    expect(w.pinned_agents.has(target)).toBe(false);
  } finally {
    r.destroy();
  }
});
test("a star dropped just after the conversation changes stays where it was dropped", () => {
  const { r, w } = setup();
  try {
    const first = add(r, w),
      p = add(r, w),
      target = { pane: p.id };
    first.attachment.select(r.conversations.get("claude", "first"));
    p.attachment.select(r.conversations.get("claude", "previous"));
    r.starAgent(w, { pane: first.id }, true);
    r.raiseEntered();
    p.attachment.select(r.conversations.get("claude", "replacement"));
    r.starAgent(w, target, true, { pane: first.id });
    expect(r.raiseEntered()).toBe(false);
    expect(w.pinned_agents.slice()).toEqual([target, { pane: first.id }]);
    expect(w.starred_sessions.has("claude", "replacement")).toBe(true);
  } finally {
    r.destroy();
  }
});
test("stopping a Bun-owned shell leaves child collection to Bun", async () => {
  const r = new Runtime(),
    terminal = Terminal.create(20, 4);
  const child = Bun.spawn(["/bin/sleep", "30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  terminal.child = child;
  terminal.pid = child.pid;
  try {
    r.stopShell(terminal);
    expect(r.stopped).toEqual([]);
    r.reapStopped();
    expect(await child.exited).toBeGreaterThan(0);
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
    terminal.destroy();
    r.destroy();
  }
});
test("only attached conversations and their subagents are followed", () => {
  const { r, w } = setup();
  try {
    const parent = r.conversations.get("claude", "parent"),
      child = r.conversations.get("claude", "child");
    r.conversations.get("claude", "other");
    child.parent = parent.id;
    const p = add(r, w);
    p.attachment.select(parent);
    expect(r.followed()).toEqual(new Set([parent, child]));
    parent.parent = child.id;
    expect(r.followed()).toEqual(new Set([parent, child]));
    p.terminal.exited = true;
    expect(r.followed().size).toBe(0);
  } finally {
    r.destroy();
  }
});
test("conversations nothing refers to are forgotten; panes, closed agents and headless sessions keep theirs", () => {
  const { r, w } = setup();
  try {
    const shown = r.conversations.get("claude", "shown"),
      earlier = r.conversations.get("claude", "earlier"),
      reopenable = r.conversations.get("codex", "reopenable"),
      quit = r.conversations.get("codex", "quit"),
      resumable = r.conversations.get("claude", "resumable"),
      headless = r.conversations.get("codex", "headless"),
      approving = r.conversations.get("codex", "approving");
    r.conversations.get("claude", "never shown");
    const p = add(r, w);
    p.attachment.select(earlier);
    p.attachment.select(shown);
    const closed = add(r, w);
    closed.attachment.select(reopenable);
    r.close(closed.id);
    const exited = add(r, w);
    exited.attachment.select(quit);
    exited.terminal.exited = true;
    r.close(exited.id);
    const asleep = add(r, w);
    asleep.resume_hint.provider = "claude";
    asleep.resume_hint.session = new Text("resumable");
    r.sessions.push({
      attachment: new Attachment(),
      members: [headless],
      approvals: [{ id: "1", actor: approving, ask: { tool: true, name: "Bash", summary: "" } }],
      destroy() {},
    } as unknown as Session);
    expect(r.pruneConversations()).toBe(true);
    expect(r.conversations.items).toEqual([shown, earlier, reopenable, resumable, headless, approving]);
    expect(r.pruneConversations()).toBe(false);
  } finally {
    r.destroy();
  }
});
test("output and readings bump only the revisions that hold them", () => {
  const r = new Runtime();
  r.wrote();
  expect([r.revision, r.durable, r.shown]).toEqual([2n, 2n, 1n]);
  r.refreshed();
  expect([r.revision, r.durable, r.shown]).toEqual([3n, 2n, 2n]);
  r.changed();
  expect([r.revision, r.durable, r.shown]).toEqual([4n, 3n, 3n]);
  r.destroy();
});
test("detection reads a quiet pane only every few seconds", () => {
  const { r, w } = setup();
  try {
    const p = add(r, w);
    p.detected = { output: p.terminal.surface_revision, at: 10000 };
    expect(p.detectionDue(10250)).toBe(false);
    expect(p.detectionDue(12000)).toBe(true);
    p.agent().state = "working";
    expect(p.detectionDue(10250)).toBe(true);
    p.agent().state = "idle";
    p.detection.missing = 1;
    expect(p.detectionDue(10250)).toBe(true);
  } finally {
    r.destroy();
  }
});
test("a program in front of the shell shows on a second look, and the prompt at once", () => {
  const { r, w } = setup();
  try {
    const p = add(r, w);
    const front = (pgid: number, name: string) => ({ pgid, program: program([name]), job: null });
    p.detected = { output: p.terminal.surface_revision, at: 10000 };
    // A quick command seen once never shows, and a forked shell's first look is the shell's.
    expect(p.observeFront(front(7, "ls"))).toBe(false);
    expect(p.detectionDue(10250)).toBe(true);
    expect(p.observeFront(front(1, "-zsh"))).toBe(false);
    expect(p.detectionDue(10250)).toBe(false);
    expect(p.observeFront(front(8, "-zsh"))).toBe(false);
    expect(p.observeFront(front(8, "vim"))).toBe(false);
    expect(p.observeFront(front(8, "vim"))).toBe(true);
    expect([p.command, p.brand]).toEqual(["vim", "vim"]);
    expect(p.detectionDue(10250)).toBe(false);
    // Another program waits for its own second look; the prompt or nothing in front clears it.
    expect(p.observeFront(front(9, "htop"))).toBe(false);
    expect(p.command).toBe("vim");
    expect(p.observeFront(front(1, "-zsh"))).toBe(true);
    expect([p.command, p.brand]).toEqual(["", null]);
    p.observeFront(front(9, "htop"));
    p.observeFront(front(9, "htop"));
    expect(p.observeFront(null)).toBe(true);
    expect(p.command).toBe("");
  } finally {
    r.destroy();
  }
});
test("closing a running agent keeps it for its own workspace; shells and agents that quit are not kept", () => {
  const { r, w } = setup();
  try {
    const p = add(r, w);
    p.attachment.select(r.conversations.get("codex", "agent-session"));
    p.terminal.exited = false;
    r.close(p.id);
    expect(r.closedCount(w.id)).toBe(1);
    const shell = add(r, w);
    r.close(shell.id);
    expect(r.closedCount(w.id)).toBe(1);
    const exited = add(r, w);
    exited.attachment.select(r.conversations.get("codex", "exited"));
    exited.terminal.exited = true;
    r.close(exited.id);
    expect(r.closedCount(w.id)).toBe(1);
  } finally {
    r.destroy();
  }
});
test("an agent that failed stays with how it ended; one that quit, a shell and a script do not", () => {
  const { r, w } = setup();
  try {
    const p = add(r, w);
    p.launch = new Launch({ provider: "codex" });
    p.terminal.runs_command = true;
    p.terminal.exited = true;
    p.terminal.exit_status = 2 << 8;
    expect(p.failed()).toBe(true);
    p.terminal.exit_status = 0;
    expect(p.failed()).toBe(false);
    p.launch = null;
    p.terminal.exit_status = 2 << 8;
    expect(p.failed()).toBe(false);
    expect(ending(2 << 8)).toContain("Exited with code 2");
    expect(ending(15)).toContain("Ended by signal 15");
  } finally {
    r.destroy();
  }
});
test("a fork's ghost shows the command it runs, not a resume", () => {
  const { r, w } = setup();
  try {
    const p = add(r, w),
      frozen = Terminal.create(20, 4);
    p.ghost = new Ghost(frozen, p.terminal.surface_revision, "");
    p.ghost.fork = "codex fork source";
    expect(p.restoring()).toBe("codex fork source");
  } finally {
    r.destroy();
  }
});
test("a reopened agent that Claude's daemon runs shows the attach it runs", () => {
  const { r, w } = setup();
  try {
    const p = add(r, w);
    p.ghost = new Ghost(Terminal.create(20, 4), p.terminal.surface_revision, "");
    p.attached = "claude attach job";
    expect(p.restoring()).toBe("claude attach job");
  } finally {
    r.destroy();
  }
});
test("each workspace keeps its newest closed agents, and closing it drops them", () => {
  const { r, w } = setup();
  try {
    r.workspaces.items.push(new Workspace(2, "/tmp"));
    for (let i = 0; i < 10; i++) {
      const p = add(r, w);
      p.attachment.select(r.conversations.get("codex", "session-" + i));
      r.close(p.id);
    }
    expect(r.closedCount(1)).toBe(8);
    expect(r.closed[0].resume_hint.session.text()).toBe("session-2");
    r.closeWorkspace(1, true);
    expect(r.closed.length).toBe(0);
  } finally {
    r.destroy();
  }
});
test("resuming a conversation finds the newest agent closed with it, in any workspace", () => {
  const { r, w } = setup();
  try {
    for (let i = 0; i < 2; i++) {
      const p = add(r, w);
      p.attachment.select(r.conversations.get("codex", "same"));
      r.close(p.id);
    }
    expect(r.closedConversation("codex", "same")).toBe(1);
    expect(r.closedConversation("claude", "same")).toBeNull();
  } finally {
    r.destroy();
  }
});
test("a fork starts the way its source did, copying the conversation", () => {
  expect(new Launch({ provider: "codex", yolo: true }).typed(["fork", "session"])).toBe(
    "codex --dangerously-bypass-approvals-and-sandbox fork session",
  );
  expect(new Launch(undefined, "custom --model opus").typed(["--resume", "old", "--name", "Two words"])).toBe(
    "custom --model opus --resume old --name 'Two words'",
  );
});
test("a Codex fork explicitly selects its destination instead of the saved session's cwd", () => {
  const { r, w } = setup();
  try {
    const p = add(r, w),
      session = "11111111-1111-4111-8111-111111111111";
    p.attachment.select(r.conversations.get("codex", session));
    const { branch } = Runtime.forkSource(p, null, "/tmp/linked worktree");
    expect(branch.args).toEqual(["fork", session, "--cd", "/tmp/linked worktree"]);
    expect(new Launch({ provider: "codex" }).typed(branch.args)).toBe(
      `codex fork ${session} --cd '/tmp/linked worktree'`,
    );
  } finally {
    r.destroy();
  }
});
test("a launch resumes the way it started, quoting what needs it", () => {
  expect(new Launch({ provider: "codex" }).typed(["resume", "session'quote"])).toBe("codex resume 'session'\\''quote'");
  expect(new Launch({ provider: "claude" }).typed(["--resume", "4ee5c02d-691c-4045-8744-930f330494fd"])).toBe(
    "claude --resume 4ee5c02d-691c-4045-8744-930f330494fd",
  );
  expect(new Launch(undefined, "custom").run("/bin/corgi", "custom").command).toBe("custom");
});
test("a resume comes back with the agent's live settings and the options it was typed with", () => {
  const agent = new Agent({ provider: "claude", session: new Text("s1") }),
    hint = new ResumeHint();
  agent.permissions = "default";
  agent.model = new Text("claude-opus-5-5");
  hint.observe(agent);
  const launch = new Launch({
    provider: "claude",
    yolo: true,
    args: ["--mcp-config", "a.json"],
    env: [["CLAUDE_CONFIG_DIR", "/work/.claude"]],
    observed: true,
  });
  expect(launch.typed(["--resume", "s1"], hint)).toBe("claude --model claude-opus-5-5 --mcp-config a.json --resume s1");
  expect(launch.typed(["--resume", "s1"])).toBe(
    "claude --dangerously-skip-permissions --mcp-config a.json --resume s1",
  );
  expect(launch.run("/bin/corgi", "claude").env).toEqual([["CLAUDE_CONFIG_DIR", "/work/.claude"]]);
  hint.observe(new Agent({ provider: "claude", session: new Text("s2") }));
  expect(hint.permissions).toBeNull();
  expect(hint.model.len).toBe(0);
});
function dormant(r: Runtime, w: Workspace, launch: Launch | null) {
  const p = add(r, w);
  p.terminal.feed("OLD SCREEN");
  p.launch = launch;
  p.attachment.select(r.conversations.get("codex", "agent-session"));
  p.resume_hint.observe(p.agent());
  return p;
}
const wakeOptions = { socket: "/tmp/unused-wake.sock", executable: process.execPath, theme: {} };
test("a dormant agent keeps its old screen with nothing running, and closing it keeps it to reopen", async () => {
  const { r, w } = setup();
  try {
    const p = dormant(r, w, null),
      actor = p.attachment.actor;
    await p.sleep();
    expect([p.dormant, p.terminal.exited, p.terminal.pid]).toEqual([true, true, -1]);
    expect(p.terminal.text()).toContain("OLD SCREEN");
    expect(p.restoring()).toBe("codex resume agent-session");
    expect(r.attachments(actor)).toBe(1);
    r.close(p.id);
    expect(r.closedCount(w.id)).toBe(1);
  } finally {
    r.destroy();
  }
});
test("waking a dormant agent starts it in its own pane behind its old screen", async () => {
  const { r, w } = setup();
  try {
    const p = dormant(r, w, new Launch(undefined, "true")),
      actor = p.attachment.actor!;
    await p.sleep();
    expect(actor.state.state).toBe("unknown");
    const asleep = p.terminal;
    await r.wake(p.id, wakeOptions, false);
    expect(r.pane(p.id)).toBe(p);
    expect(p.dormant).toBe(false);
    expect(p.terminal).not.toBe(asleep);
    expect(p.terminal.pid).toBeGreaterThan(0);
    expect(p.ghost?.terminal.text()).toContain("OLD SCREEN");
    expect(p.restoring()).toBe("true resume agent-session");
    expect(actor.state.state).toBe("idle");
    await expect(r.wake(p.id, wakeOptions, false)).rejects.toThrow("NotDormant");
  } finally {
    r.destroy();
  }
});
test("waking a dormant agent into a shell types its command without running it", async () => {
  const { r, w } = setup();
  try {
    const p = dormant(r, w, new Launch({ provider: "codex", yolo: true }));
    await p.sleep();
    await r.wake(p.id, wakeOptions, true);
    expect(p.dormant).toBe(false);
    expect(p.ghost).toBeNull();
    expect(p.terminal.pid).toBeGreaterThan(0);
    expect(p.terminal.text()).toContain("OLD SCREEN");
    expect(p.terminal.initial_input).toBe(`codex --dangerously-bypass-approvals-and-sandbox resume agent-session`);
  } finally {
    r.destroy();
  }
});
function ghost(r: Runtime, p: Pane, old: string | null) {
  const frozen = Terminal.create(20, 4);
  if (old) frozen.feed(old);
  r.haunt(p, frozen, old, null);
}
test("a reopened agent's ghost shows until the agent draws and holds still", () => {
  const { r, w } = setup();
  try {
    const p = add(r, w);
    ghost(r, p, "OLD");
    expect(p.watchGhost(10000)).toBe(false);
    p.terminal.feed("NEW");
    expect(p.watchGhost(100)).toBe(false);
    expect(p.watchGhost(399)).toBe(false);
    expect(p.watchGhost(400)).toBe(true);
  } finally {
    r.destroy();
  }
});
test("a ghost goes as soon as the agent repaints the old screen, or after the longest wait", () => {
  const { r, w } = setup();
  try {
    const p = add(r, w);
    ghost(r, p, "SCROLLED\r\n\r\n\r\n\r\nOLD");
    expect(p.terminal.liveText().trim()).toBe("");
    expect(p.terminal.history()).toContain("SCROLLED");
    expect(p.terminal.history()).not.toContain("OLD");
    p.terminal.feed("\x1b[4;1HOLD");
    expect(p.watchGhost(100)).toBe(true);
    const busy = add(r, w);
    ghost(r, busy, "OLD");
    for (let now = 100; now < 2100; now += 100) {
      busy.terminal.feed("x");
      expect(busy.watchGhost(now)).toBe(false);
    }
    busy.terminal.feed("x");
    expect(busy.watchGhost(2100)).toBe(true);
  } finally {
    r.destroy();
  }
});
test("a restored agent shows once it has drawn about as much as its old screen", () => {
  const { r, w } = setup();
  try {
    const p = add(r, w);
    ghost(r, p, "header\r\none\r\ntwo\r\n> ");
    // A startup screen holds still, but it isn't the conversation.
    p.terminal.feed("header\r\n> ");
    expect(p.watchGhost(100)).toBe(false);
    expect(p.watchGhost(5000)).toBe(false);
    p.terminal.feed("\x1b[Hheader\r\nuno\r\ndos\r\n> ");
    expect(p.watchGhost(5100)).toBe(false);
    expect(p.watchGhost(5400)).toBe(true);
    const stuck = add(r, w);
    ghost(r, stuck, "header\r\none\r\ntwo\r\n> ");
    stuck.terminal.feed("header");
    expect(stuck.watchGhost(100)).toBe(false);
    expect(stuck.watchGhost(99 + Ghost.give_up_ms)).toBe(false);
    expect(stuck.watchGhost(100 + Ghost.give_up_ms)).toBe(true);
  } finally {
    r.destroy();
  }
});
test("a Codex agent shows only once it has titled its terminal", () => {
  const { r, w } = setup();
  try {
    const p = add(r, w);
    p.launch = new Launch({ provider: "codex" });
    ghost(r, p, "OLD");
    p.terminal.feed("NEW");
    expect(p.watchGhost(100)).toBe(false);
    expect(p.watchGhost(1000)).toBe(false);
    p.terminal.feed("\x1b]0;codex\x07");
    expect(p.watchGhost(1100)).toBe(true);
  } finally {
    r.destroy();
  }
});
test("typing into a restored agent shows it, and the mouse doesn't", () => {
  const { r, w } = setup();
  try {
    const p = add(r, w);
    ghost(r, p, "OLD");
    expect(p.typed("\x1b[<35;5;2M")).toBe(false);
    expect(p.ghost).not.toBeNull();
    expect(p.typed("a")).toBe(true);
    expect(p.ghost).toBeNull();
    expect(p.typed("b")).toBe(false);
  } finally {
    r.destroy();
  }
});
test("a blank ghost waits for the agent to hold still, even on a cleared screen", () => {
  const { r, w } = setup();
  try {
    const p = add(r, w);
    ghost(r, p, null);
    p.terminal.feed("x");
    expect(p.watchGhost(100)).toBe(false);
    p.terminal.feed("\x1b[2J\x1b[H");
    expect(p.watchGhost(200)).toBe(false);
    expect(p.watchGhost(500)).toBe(true);
  } finally {
    r.destroy();
  }
});
test("a closed split's tab goes back after the tab it shared", () => {
  const { r, w } = setup();
  try {
    add(r, w);
    const left = add(r, w);
    const right = add(r, w, left.id);
    right.attachment.select(r.conversations.get("claude", "split"));
    r.close(right.id);
    expect(r.closed[0].tab_index).toBe(2);
  } finally {
    r.destroy();
  }
});
test("reapStopped collects exited shells and forgets processes that are not ours", () => {
  const r = new Runtime();
  const pids = new Int32Array(2);
  expect(n.probe_fixture_children(ptr(pids))).toBe(0);
  const [exited, running] = pids;
  try {
    r.stopped.push(exited, 1, running);
    r.reapStopped();
    expect(r.stopped).toEqual([running]);
    expect(waitpid(exited)).toBeLessThan(0);
  } finally {
    process.kill(running, "SIGKILL");
    n.probe_wait_child(running);
    r.stopped = [];
    r.destroy();
  }
});
test("idle shells come by workspace then tab, narrowed to a workspace or folder", () => {
  const { r, w } = setup(),
    other = new Workspace(2, "/tmp");
  r.workspaces.items.push(other);
  const [a, b, c, d] = [add(r, w), add(r, w), add(r, w), add(r, other)];
  b.cwd = "/repo";
  d.cwd = "/repo";
  let checked = 0;
  for (const p of [a, b, d])
    p.idleShell = () => {
      checked++;
      return true;
    };
  w.model.moveTab(w.model.tabs[w.model.tabForPane(b.id)!].id, 0);
  try {
    expect([...r.idleShells()].map(p => p.id)).toEqual([b.id, a.id, d.id]);
    expect([...r.idleShells({ workspace: 2 })].map(p => p.id)).toEqual([d.id]);
    expect([...r.idleShells({ cwd: "/repo" })].map(p => p.id)).toEqual([b.id, d.id]);
    checked = 0;
    expect(r.idleShells({ cwd: "/repo" }).next().value?.id).toBe(b.id);
    expect(checked).toBe(1);
    expect([...r.idleShells({ workspace: 1, cwd: "/elsewhere" })]).toEqual([]);
    // A shell that never started never waits.
    expect(c.idleShell()).toBe(false);
  } finally {
    r.destroy();
  }
});

test("resume without a reported model leaves the conversation's saved model alone", () => {
  const launch = Launch.in("claude", "", false, { flags: "--verbose", env: [], model: "sonnet" }),
    hint = new ResumeHint();
  expect(launch.typed()).toBe("claude --model sonnet --verbose");
  expect(launch.typed(["--resume", "s1"], hint)).toBe("claude --verbose --resume s1");
  const agent = new Agent({ provider: "claude", session: new Text("s1") });
  agent.model = new Text("opus");
  hint.observe(agent);
  expect(launch.typed(["--resume", "s1"], hint)).toBe("claude --model opus --verbose --resume s1");
});
test("a new agent goes on top though another changes section as it appears", () => {
  const { r, w } = setup();
  try {
    const old = [add(r, w), add(r, w)];
    old.forEach((p, i) => p.attachment.select(r.conversations.get("claude", `old-${i}`)));
    r.raiseEntered();
    const created = add(r, w);
    created.attachment.select(r.conversations.get("claude", "new"));
    // Raising the earlier tab fills the order with every live agent, the new one too.
    old[0].agent().state = "done";
    r.raiseEntered();
    expect(w.activity_order.slice()).toEqual([{ pane: created.id }, { pane: old[0].id }, { pane: old[1].id }]);
    expect(w.starting.has(`pane:${created.id}`)).toBe(true);
  } finally {
    r.destroy();
  }
});
test("a new agent goes on top though another was dragged before it was seen", () => {
  const { r, w } = setup();
  try {
    const old = [add(r, w), add(r, w)];
    old.forEach((p, i) => p.attachment.select(r.conversations.get("claude", `old-${i}`)));
    r.raiseEntered();
    const created = add(r, w);
    created.attachment.select(r.conversations.get("claude", "new"));
    // As agent.place does; the move fills the order with the new agent too.
    w.activity_order.move(r.agentTargets(w), { pane: old[0].id }, null);
    r.raiseEntered();
    expect(w.activity_order.slice()[0]).toEqual({ pane: created.id });
    expect(w.starting.has(`pane:${created.id}`)).toBe(true);
  } finally {
    r.destroy();
  }
});
