import { Terminal, closeReadiness } from "./pane/terminal";
import { n, ptr } from "./native_bridge";
import { test, expect, spyOn } from "bun:test";
import { identify, backgroundJob, foreground, foregrounds, Tracker, interruptKey, type Job } from "./detection";
import { Agent } from "./agents";
import { adapter } from "./providers";
import { screen as claudeScreen, interrupted } from "./providers/claude/screen";
import * as os from "./os";
import * as nativeBridge from "./native_bridge";
/** A tick of a pane's detection: follow its process, then show what its watcher confirms. */
function look(tracker: Tracker, agent: Agent, job: Job | null, title: string, text: string, watched: boolean) {
  const speaks = tracker.claim ? true : tracker.update(agent, job);
  const provider = tracker.claim?.provider ?? job?.provider;
  if (!provider) return false;
  const seen = adapter(provider)
    .watch("")
    .read({ id: 1, title, text: () => text }, tracker, null, 0);
  return !!seen.shown && speaks && tracker.show(agent, seen.shown, watched);
}
test("identify actual executables and scripts, not arguments or shell text", () => {
  for (const args of [
    ["/usr/bin/codex"],
    ["bun", "/a/node_modules/@openai/codex/bin/codex.js"],
    ["python3", "/tmp/codex"],
    ["/Frameworks/Python", "/tmp/codex"],
  ])
    expect(identify(args)).toBe("codex");
  expect(identify(["bun", "run", "--bun", "/a/node_modules/@anthropic-ai/claude-code/cli.js"])).toBe("claude");
  expect(identify(["/Users/a/.local/share/claude/versions/2.1.282", "--session-id", "x"])).toBe("claude");
  for (const args of [
    ["sh", "-c", "codex"],
    ["node", "-e", "codex"],
    ["bun", "-e", "codex"],
    ["vim", "codex"],
  ])
    expect(identify(args)).toBeNull();
});
test.skipIf(process.platform !== "linux")(
  "a known agent must still belong to the foreground group and run an agent",
  () => {
    let group = 100,
      program = "codex";
    const front = spyOn(n, "probe_foreground").mockReturnValue(100),
      args = spyOn(nativeBridge, "processArgs").mockImplementation(pid => ({
        argv: [pid === 101 ? program : pid === 102 ? "claude" : "sh"],
        complete: true,
      })),
      membership = spyOn(os, "processGroup").mockImplementation(pid => (pid === 101 ? group : 100)),
      tree = spyOn(os, "processTree").mockReturnValue([100, 101, 102]);
    try {
      const read = () => foregrounds([{ fd: 3, pid: 100, agent: 101 }]).get(3);
      expect(read()?.job).toEqual({ pid: 101, provider: "codex" });
      expect(tree).not.toHaveBeenCalled();
      group = 200;
      expect(read()?.job).toEqual({ pid: 102, provider: "claude" });
      group = 100;
      program = "sleep";
      args.mockClear();
      expect(read()?.job).toEqual({ pid: 102, provider: "claude" });
      expect(args.mock.calls.some(([pid]) => pid === 101)).toBe(true);
    } finally {
      front.mockRestore();
      args.mockRestore();
      membership.mockRestore();
      tree.mockRestore();
    }
  },
);
test.skipIf(process.platform !== "linux")("foreground discovery reads argv only for live group members", () => {
  const front = spyOn(n, "probe_foreground").mockReturnValue(100),
    tree = spyOn(os, "processTree").mockReturnValue([100, 101, 102, 103]),
    membership = spyOn(os, "processGroup").mockImplementation(pid => (pid === 101 ? 200 : pid === 102 ? null : 100)),
    job = spyOn(os, "processJob"),
    args = spyOn(nativeBridge, "processArgs").mockImplementation(pid => ({
      argv: [pid === 100 ? "sh" : pid === 103 ? "claude" : "codex"],
      complete: true,
    }));
  try {
    expect(foregrounds([{ fd: 3, pid: 100 }]).get(3)?.job).toEqual({ pid: 103, provider: "claude" });
    expect(membership.mock.calls).toEqual([[100], [101], [102], [103]]);
    expect(args.mock.calls).toEqual([[100], [103]]);
    expect(job).not.toHaveBeenCalled();
  } finally {
    front.mockRestore();
    tree.mockRestore();
    membership.mockRestore();
    job.mockRestore();
    args.mockRestore();
  }
});
test("claude interrupts need a stable idle title without an interrupt hint", () => {
  const tracker = new Tracker(),
    idle = "> \n  ? for shortcuts",
    delay = 1500000;
  expect(interrupted(claudeScreen("✳ Task", idle), tracker, 100)).toBe(false);
  expect(interrupted(claudeScreen("⠋ Task", idle), tracker, 100 + delay)).toBe(false);
  expect(interrupted(claudeScreen("✳ Task", "✻ Working (esc to interrupt)"), tracker, 200 + delay)).toBe(false);
  expect(interrupted(claudeScreen("✳ Task", idle), tracker, 300 + delay)).toBe(false);
  expect(interrupted(claudeScreen("✳ Task", idle), tracker, 299 + 2 * delay)).toBe(false);
  expect(interrupted(claudeScreen("✳ Task", idle), tracker, 300 + 2 * delay)).toBe(true);
});
test("an interrupt key shortens the stable idle wait", () => {
  let tracker = new Tracker();
  const idle = "> \n  ? for shortcuts";
  tracker.observeInput("\x1b", 1000);
  expect(interrupted(claudeScreen("⠋ Task", "✻ Working (esc to interrupt)"), tracker, 1100)).toBe(false);
  expect(interrupted(claudeScreen("✳ Task", idle), tracker, 1200)).toBe(false);
  expect(interrupted(claudeScreen("✳ Task", idle), tracker, 251200)).toBe(true);
  tracker = new Tracker();
  tracker.observeInput("\x03", 1000);
  const late = 5001001;
  expect(interrupted(claudeScreen("✳ Task", idle), tracker, late)).toBe(false);
  expect(interrupted(claudeScreen("✳ Task", idle), tracker, late + 250000)).toBe(false);
});
test("recognize interrupt keys in legacy and Kitty encodings", () => {
  for (const input of ["\x1b", "\x03", "\x1b[27u", "\x1b[27;1u", "\x1b[27;1:1u", "\x1b[99;5u", "a\x1b[27u"])
    expect(interruptKey(input)).toBe(true);
  for (const input of ["", "a", "\x1b[A", "\x1bb", "\x1b[27;5;97~", "\x1b[270u", "\x1b[99u"])
    expect(interruptKey(input)).toBe(false);
});
test("fallback debounces attention, yields to hooks, and clears exited agents", () => {
  const tracker = new Tracker(),
    agent = new Agent(),
    job = { pid: 123, provider: "claude" as const };
  for (let i = 0; i < 2; i++) expect(look(tracker, agent, job, "⠋ Task", "", false)).toBe(false);
  expect(agent.state).toBe("initializing");
  for (let i = 0; i < 4; i++) look(tracker, agent, job, "⠋ Starting", "Initializing (esc to interrupt)", false);
  expect(agent.state).toBe("initializing");
  for (let i = 0; i < 3; i++) look(tracker, agent, job, "✳ Ready", "", false);
  for (let i = 0; i < 3; i++) look(tracker, agent, job, "⠋ Loading", "", false);
  expect(agent.state).toBe("idle");
  for (let i = 0; i < 2; i++) look(tracker, agent, job, "⠋ Task", "Working (esc to interrupt)", false);
  expect(agent.state).toBe("working");
  for (let i = 0; i < 2; i++) expect(look(tracker, agent, job, "✳ Task", "", false)).toBe(false);
  expect(look(tracker, agent, job, "✳ Task", "", false)).toBe(true);
  expect(agent.attention).toBe("finished");
  expect(agent.observation.completed).toBe(1n);
  agent.last_seq = 1n;
  agent.state = "blocked";
  for (let i = 0; i < 4; i++) look(tracker, agent, job, "⠋ Task", "", false);
  expect(agent.state).toBe("blocked");
  look(tracker, agent, null, "", "", false);
  expect(agent.provider).toBe("claude");
  look(tracker, agent, null, "", "", false);
  expect(agent.provider).toBeNull();
  expect(agent.last_seq).toBe(0n);
});
test("claimed and autodetected screens share a lifecycle from the first observed work", () => {
  for (const [provider, claimed] of [
    ["claude", false],
    ["codex", false],
    ["claude", true],
    ["codex", true],
  ] as const) {
    const tracker = new Tracker(),
      agent = new Agent({ provider, state: "initializing" });
    if (claimed) tracker.claim = { provider, owner: process.pid, parent: process.ppid };
    const job = claimed ? null : { provider, pid: 123 };
    const show = (title: string, text: string, reads: number) => {
      let ding = false;
      for (let i = 0; i < reads; i++) ding = look(tracker, agent, job, title, text, false) || ding;
      return ding;
    };
    const working = "Working (esc to interrupt)",
      idle = "› ";
    expect(show("⠋ Task", working, 2)).toBe(false);
    expect(agent.state).toBe("working");
    expect(tracker.ready).toBe(false);
    expect(tracker.screen_worked).toBe(true);
    expect(show("", "unrecognized or disconnected output", 5)).toBe(false);
    expect(agent.state).toBe("working");
    expect(show("✳ Ready", idle, 2)).toBe(false);
    expect(agent.observation.completed).toBe(0n);
    expect(show("✳ Ready", idle, 1)).toBe(true);
    expect(agent).toMatchObject({ state: "idle", attention: "finished", finished_since_activity: true });
    expect(agent.observation).toMatchObject({ completed: 1n, read: 0n, source: "screen", outcome: "completed" });
    expect(tracker.screen_worked).toBe(false);
    expect(show("✳ Ready", idle, 5)).toBe(false);
    expect(agent.observation.completed).toBe(1n);
    show("⠋ Task", working, 2);
    expect(agent.attention).toBe("finished");
    show("", "Enter to confirm · Esc to cancel", 2);
    expect(agent.state).toBe("blocked");
    expect(tracker.screen_worked).toBe(true);
    expect(show("✳ Ready", idle, 3)).toBe(true);
    expect(agent.observation.completed).toBe(2n);
    agent.readThrough(1n);
    expect(agent.observation.unread()).toBe(true);
    agent.acknowledge();
    expect(agent.observation.unread()).toBe(false);
    expect(agent.attention).toBe("none");
  }
});

test("claimed startup idle and startup dialogs do not complete work", () => {
  const tracker = new Tracker(),
    agent = new Agent({ provider: "claude", state: "initializing" });
  tracker.claim = { provider: "claude", owner: process.pid, parent: process.ppid };
  for (let i = 0; i < 3; i++) expect(look(tracker, agent, null, "✳ Ready", "", false)).toBe(false);
  for (let i = 0; i < 2; i++) look(tracker, agent, null, "", "Enter to confirm · Esc to cancel", false);
  expect(agent.attention).toBe("needs_input");
  for (let i = 0; i < 3; i++) expect(look(tracker, agent, null, "✳ Ready", "", false)).toBe(false);
  expect(agent).toMatchObject({ state: "idle", attention: "none" });
  expect(agent.observation.completed).toBe(0n);
});

test("a claimed turn interrupted through the pane records interruption without a finished sound", () => {
  const tracker = new Tracker(),
    agent = new Agent({ provider: "claude", state: "initializing" });
  tracker.claim = { provider: "claude", owner: process.pid, parent: process.ppid };
  const working = "Working (esc to interrupt)";
  for (let i = 0; i < 2; i++) look(tracker, agent, null, "⠋ Task", working, false);
  tracker.observeInput("\x03", Date.now() * 1000);
  for (let i = 0; i < 3; i++) expect(look(tracker, agent, null, "✳ Ready", "", false)).toBe(false);
  expect(agent.observation).toMatchObject({ completed: 1n, outcome: "interrupted", source: "screen" });
  for (let i = 0; i < 2; i++) look(tracker, agent, null, "⠋ Task", working, false);
  expect(tracker.interrupt_key_at).toBe(0);
  let ding = false;
  for (let i = 0; i < 3; i++) ding = look(tracker, agent, null, "✳ Ready", "", false) || ding;
  expect(ding).toBe(true);
  expect(agent.observation).toMatchObject({ completed: 2n, outcome: "completed" });
});

test("structured ownership stays sticky until process replacement", () => {
  const tracker = new Tracker(),
    agent = new Agent(),
    job = { provider: "claude" as const, pid: 123 };
  for (let i = 0; i < 2; i++) look(tracker, agent, job, "⠋ Task", "Working (esc to interrupt)", false);
  expect(tracker.screen_worked).toBe(true);
  agent.last_seq = 1n;
  look(tracker, agent, job, "✳ Ready", "", false);
  expect(tracker.structured).toBe(true);
  expect(tracker.screen_worked).toBe(false);
  agent.last_seq = 0n;
  for (let i = 0; i < 3; i++) expect(look(tracker, agent, job, "✳ Ready", "", false)).toBe(false);
  for (let i = 0; i < 2; i++) look(tracker, agent, job, "⠋ Task", "Working (esc to interrupt)", false);
  for (let i = 0; i < 3; i++) expect(look(tracker, agent, job, "✳ Ready", "", false)).toBe(false);
  expect(agent.observation.completed).toBe(0n);
  const replacement = { ...job, pid: 456 };
  for (let i = 0; i < 3; i++) look(tracker, agent, replacement, "✳ Ready", "", false);
  expect(tracker.structured).toBe(false);
  expect(agent.observation.completed).toBe(0n);
  for (let i = 0; i < 2; i++) look(tracker, agent, replacement, "⠋ Task", "Working (esc to interrupt)", false);
  let ding = false;
  for (let i = 0; i < 3; i++) ding = look(tracker, agent, replacement, "✳ Ready", "", false) || ding;
  expect(ding).toBe(true);
  expect(agent.observation.completed).toBe(1n);
});

test("Codex fallback tracks tools without a lifecycle state transition", () => {
  const tracker = new Tracker(),
    agent = new Agent(),
    job = { pid: 123, provider: "codex" as const };
  for (let i = 0; i < 3; i++) look(tracker, agent, job, "", "› ", true);
  const working = "• Working (20s • esc to interrupt)\n› Ask Codex to do anything";
  for (let i = 0; i < 2; i++) look(tracker, agent, job, "", working, true);
  expect(agent.state).toBe("working");
  expect(agent.tool_active).toBe(false);
  for (const screen of [
    "• Working (20s • esc to interrupt) · 1 background terminal running\n› Ask Codex to do anything",
    "• Working (20s • esc to interrupt) · 3 background t…\n› Ask Codex to do anything",
    "• Waiting for background terminal (20s • esc to interrupt)\n› Ask Codex to do anything",
  ]) {
    look(tracker, agent, job, "", screen, true);
    expect(agent.tool_active).toBe(true);
    look(tracker, agent, job, "", working, true);
    expect(agent.tool_active).toBe(false);
  }
  const tool = "• Working (20s • esc to interrupt) · 1 background t…";
  look(tracker, agent, job, "", tool, true);
  for (let i = 0; i < 3; i++) look(tracker, agent, job, "", "› ", true);
  expect(agent.tool_active).toBe(false);
  agent.last_seq = 1n;
  agent.state = "working";
  for (let i = 0; i < 3; i++) look(tracker, agent, job, "", tool, true);
  expect(agent.tool_active).toBe(false);
});

test("a detached process is a background job and a terminal's foreground is not", async () => {
  const detached = Bun.spawn([process.execPath, "-e", "await Bun.sleep(60000)"], {
    detached: true,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const terminal = new Terminal(80, 24);
  try {
    await terminal.spawn("/tmp", "", 1, process.execPath, "printf x; sleep 60");
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && (!backgroundJob(detached.pid) || n.probe_foreground(terminal.fd) <= 0))
      await Bun.sleep(10);
    expect(backgroundJob(detached.pid)).toBe(true);
    expect(backgroundJob(terminal.pid)).toBe(false);
    const members = new Int32Array(128);
    const count = n.probe_group_pids(detached.pid, ptr(members), members.length);
    expect(count).toBeGreaterThan(0);
    expect(Array.from(members.subarray(0, count))).toContain(detached.pid);
    if (process.platform === "linux") expect(n.probe_group_pids(-1, ptr(members), members.length)).toBeLessThan(0);
  } finally {
    detached.kill();
    await detached.exited;
    terminal.destroy();
    closeReadiness();
  }
});

test("a terminal's foreground is named for the program in front", async () => {
  const terminal = new Terminal(80, 24);
  try {
    await terminal.spawn("/tmp", "", 1, process.execPath, "exec sleep 60");
    const deadline = Date.now() + 3000;
    let front = foreground(terminal.fd);
    while (Date.now() < deadline && front?.program?.name !== "sleep") {
      await Bun.sleep(10);
      front = foreground(terminal.fd);
    }
    expect(front).toEqual({ pgid: terminal.pid, program: { name: "sleep", brand: null }, job: null });
  } finally {
    terminal.destroy();
    closeReadiness();
  }
});
