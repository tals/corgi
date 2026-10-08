import { Terminal, closeReadiness } from "./pane/terminal";
import { n, ptr } from "./native_bridge";
import { test, expect } from "bun:test";
import {
  identify,
  claudeProcess,
  backgroundJob,
  screenCompacting,
  screenToolActive,
  Tracker,
  PromptWatch,
  interruptKey,
} from "./detection";
import { Agent } from "./agents";
test("identify actual executables and scripts, not arguments or shell text", () => {
  for (const args of [
    ["/usr/bin/codex"],
    ["bun", "/a/node_modules/@openai/codex/bin/codex.js"],
    ["python3", "/tmp/codex"],
    ["/Frameworks/Python", "/tmp/codex"],
  ])
    expect(identify(args)).toBe("codex");
  expect(
    identify([
      "bun",
      "run",
      "--bun",
      "/a/node_modules/@anthropic-ai/claude-code/cli.js",
    ]),
  ).toBe("claude");
  expect(
    identify([
      "/Users/a/.local/share/claude/versions/2.1.282",
      "--session-id",
      "x",
    ]),
  ).toBe("claude");
  for (const args of [
    ["sh", "-c", "codex"],
    ["node", "-e", "codex"],
    ["bun", "-e", "codex"],
    ["vim", "codex"],
  ])
    expect(identify(args)).toBeNull();
});
test("compaction requires a live status row and ignores quoted or historical text", () => {
  expect(
    screenCompacting("• Compacting context (12s • esc to interrupt)\n› "),
  ).toBe(true);
  expect(
    screenCompacting("◦ Compacting conversation (esc to interrupt)\n› "),
  ).toBe(true);
  expect(
    screenCompacting(
      "• Compacting context (esc to interrupt)\nWorking (esc to interrupt)",
    ),
  ).toBe(false);
  expect(screenCompacting("I saw Compacting context (esc to interrupt)")).toBe(
    false,
  );
  expect(screenCompacting("Compacting context\n› ")).toBeNull();
  expect(
    screenCompacting(
      "• Compacting context (esc to interrupt)\n1\n2\n3\n4\n5\n6\n7\n8",
    ),
  ).toBeNull();
});
test("claude interrupts need a stable idle title without an interrupt hint", () => {
  const tracker = new Tracker(),
    idle = "> \n  ? for shortcuts",
    delay = 1500000;
  expect(tracker.interrupted("✳ Task", idle, 100)).toBe(false);
  expect(tracker.interrupted("⠋ Task", idle, 100 + delay)).toBe(false);
  expect(
    tracker.interrupted("✳ Task", "✻ Working (esc to interrupt)", 200 + delay),
  ).toBe(false);
  expect(tracker.interrupted("✳ Task", idle, 300 + delay)).toBe(false);
  expect(tracker.interrupted("✳ Task", idle, 299 + 2 * delay)).toBe(false);
  expect(tracker.interrupted("✳ Task", idle, 300 + 2 * delay)).toBe(true);
});
test("an interrupt key shortens the stable idle wait", () => {
  let tracker = new Tracker();
  const idle = "> \n  ? for shortcuts";
  tracker.observeInput("\x1b", 1000);
  expect(
    tracker.interrupted("⠋ Task", "✻ Working (esc to interrupt)", 1100),
  ).toBe(false);
  expect(tracker.interrupted("✳ Task", idle, 1200)).toBe(false);
  expect(tracker.interrupted("✳ Task", idle, 251200)).toBe(true);
  tracker = new Tracker();
  tracker.observeInput("\x03", 1000);
  const late = 5001001;
  expect(tracker.interrupted("✳ Task", idle, late)).toBe(false);
  expect(tracker.interrupted("✳ Task", idle, late + 250000)).toBe(false);
});
test("recognize interrupt keys in legacy and Kitty encodings", () => {
  for (const input of [
    "\x1b",
    "\x03",
    "\x1b[27u",
    "\x1b[27;1u",
    "\x1b[27;1:1u",
    "\x1b[99;5u",
    "a\x1b[27u",
  ])
    expect(interruptKey(input)).toBe(true);
  for (const input of [
    "",
    "a",
    "\x1b[A",
    "\x1bb",
    "\x1b[27;5;97~",
    "\x1b[270u",
    "\x1b[99u",
  ])
    expect(interruptKey(input)).toBe(false);
});
test("fallback debounces attention, yields to hooks, and clears exited agents", () => {
  const tracker = new Tracker(),
    agent = new Agent(),
    job = { pid: 123, provider: "claude" as const };
  for (let i = 0; i < 2; i++)
    expect(tracker.update(agent, job, "⠋ Task", "", false)).toBe(false);
  expect(agent.state).toBe("initializing");
  for (let i = 0; i < 4; i++)
    tracker.update(
      agent,
      job,
      "⠋ Starting",
      "Initializing (esc to interrupt)",
      false,
    );
  expect(agent.state).toBe("initializing");
  for (let i = 0; i < 3; i++) tracker.update(agent, job, "✳ Ready", "", false);
  for (let i = 0; i < 3; i++)
    tracker.update(agent, job, "⠋ Loading", "", false);
  expect(agent.state).toBe("idle");
  for (let i = 0; i < 2; i++)
    tracker.update(agent, job, "⠋ Task", "Working (esc to interrupt)", false);
  expect(agent.state).toBe("working");
  for (let i = 0; i < 3; i++)
    expect(tracker.update(agent, job, "✳ Task", "", false)).toBe(false);
  expect(agent.attention).toBe("none");
  agent.last_seq = 1;
  agent.state = "blocked";
  for (let i = 0; i < 4; i++) tracker.update(agent, job, "⠋ Task", "", false);
  expect(agent.state).toBe("blocked");
  tracker.update(agent, null, "", "", false);
  expect(agent.provider).toBe("claude");
  tracker.update(agent, null, "", "", false);
  expect(agent.provider).toBeNull();
  expect(agent.last_seq).toBe(0);
});
test("Codex fallback tracks tools without a lifecycle state transition", () => {
  const tracker = new Tracker(),
    agent = new Agent(),
    job = { pid: 123, provider: "codex" as const };
  for (let i = 0; i < 3; i++) tracker.update(agent, job, "", "› ", true);
  const working =
    "• Working (20s • esc to interrupt)\n› Ask Codex to do anything";
  for (let i = 0; i < 2; i++) tracker.update(agent, job, "", working, true);
  expect(agent.state).toBe("working");
  expect(agent.tool_active).toBe(false);
  for (const screen of [
    "• Working (20s • esc to interrupt) · 1 background terminal running\n› Ask Codex to do anything",
    "• Working (20s • esc to interrupt) · 3 background t…\n› Ask Codex to do anything",
    "• Waiting for background terminal (20s • esc to interrupt)\n› Ask Codex to do anything",
  ]) {
    tracker.update(agent, job, "", screen, true);
    expect(agent.tool_active).toBe(true);
    tracker.update(agent, job, "", working, true);
    expect(agent.tool_active).toBe(false);
  }
  expect(
    screenToolActive(
      "codex",
      "• Working (20s • esc to interrupt) · 0 background terminals running",
    ),
  ).toBe(false);
  expect(
    screenToolActive(
      "claude",
      "• Working (20s • esc to interrupt) · 1 background terminal running",
    ),
  ).toBe(false);
  const tool = "• Working (20s • esc to interrupt) · 1 background t…";
  tracker.update(agent, job, "", tool, true);
  for (let i = 0; i < 3; i++) tracker.update(agent, job, "", "› ", true);
  expect(agent.tool_active).toBe(false);
  agent.last_seq = 1;
  agent.state = "working";
  for (let i = 0; i < 3; i++) tracker.update(agent, job, "", tool, true);
  expect(agent.tool_active).toBe(false);
});

const line = "─".repeat(40);
const screens = {
  idle: `⏺ Done.\n\n${line}\n❯ \n${line}\n  ⏸ manual mode on · ? for shortcuts · ← 2 agents`,
  typed: `${line}\n❯ a long reply that\n  wraps\n${line}\n  ⏸ manual mode on`,
  working: `✢ Honking… (1s · thinking)\n${line}\n❯ \n${line}\n  ⏸ manual mode on · esc to interrupt · ← 2 agents`,
  permission: `⏺ Sleeping\n${line}\n Bash command\n\n   sleep 25\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and always allow\n   3. No\n\n Esc to cancel · Tab to amend`,
  question: `${line}\n ☐ Color\n\nPick a color\n\n❯ 1. Red\n  2. Blue\n  3. Type something.\n${line}\n  4. Chat about this\n\nEnter to select · ↑/↓ to navigate · Esc to cancel`,
  question_last: `${line}\n ☐ Color\n\nPick a color\n\n  1. Red\n  2. Blue\n  3. Type something.\n${line}\n❯ 4. Chat about this\n\nEnter to select · ↑/↓ to navigate · Esc to cancel`,
};
import { claudeComposer } from "./detection";
test("Claude's prompts cover its composer", () => {
  for (const screen of [screens.idle, screens.typed, screens.working])
    expect(claudeComposer(screen)).toBe("open");
  for (const screen of [
    screens.permission,
    screens.question,
    screens.question_last,
    "",
  ])
    expect(claudeComposer(screen)).toBe("covered");
  expect(
    claudeComposer(
      `${line}\n❯ make\n${line}\n  enter to select · esc to cancel`,
    ),
  ).toBe("unknown");
});
test("a hook-reported Claude block ends once its prompt was seen and answered", () => {
  const tracker = new PromptWatch();
  for (const screen of [
    screens.working,
    screens.permission,
    screens.working,
    screens.working,
    screens.permission,
    screens.permission,
    screens.working,
  ])
    expect(tracker.answered(true, screen)).toBeNull();
  expect(tracker.answered(true, screens.working)).toBe("working");
  for (let i = 0; i < 2; i++)
    expect(tracker.answered(true, screens.question)).toBeNull();
  expect(tracker.answered(true, screens.typed)).toBeNull();
  expect(tracker.answered(true, screens.idle)).toBe("idle");
  for (let i = 0; i < 2; i++) tracker.answered(true, screens.question);
  expect(tracker.answered(false, "")).toBeNull();
  for (let i = 0; i < 3; i++)
    expect(tracker.answered(true, screens.idle)).toBeNull();
});

test("a retitled Claude process is still Claude", () => {
  const info = { exe: "/usr/bin/node", argv: ["claude bg-spare"] };
  expect(claudeProcess(info)).toBe(true);
  info.argv[0] = "node";
  expect(claudeProcess(info)).toBe(false);
  info.exe = "/opt/claude/bin/claude";
  expect(claudeProcess(info)).toBe(true);
});

test("a detached process is a background job and a terminal's foreground is not", async () => {
  const detached = Bun.spawn(
    [process.execPath, "-e", "await Bun.sleep(60000)"],
    { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  const terminal = new Terminal(80, 24);
  try {
    await terminal.spawn("/tmp", "", 1, process.execPath, "printf x; sleep 60");
    const deadline = Date.now() + 3000;
    while (
      Date.now() < deadline &&
      (!backgroundJob(detached.pid) || n.probe_foreground(terminal.fd) <= 0)
    )
      await Bun.sleep(10);
    expect(backgroundJob(detached.pid)).toBe(true);
    expect(backgroundJob(terminal.pid)).toBe(false);
    const members = new Int32Array(128);
    const count = n.probe_group_pids(detached.pid, ptr(members), members.length);
    expect(count).toBeGreaterThan(0);
    expect(Array.from(members.subarray(0, count))).toContain(detached.pid);
    if (process.platform === "linux")
      expect(n.probe_group_pids(-1, ptr(members), members.length)).toBeLessThan(0);
  } finally {
    detached.kill();
    await detached.exited;
    terminal.destroy();
    closeReadiness();
  }
});
