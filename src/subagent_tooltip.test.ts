import { expect, test } from "bun:test";
import {
  Accounts,
  Card,
  Model,
  Tone,
  compact,
  conversation,
  draw,
  drawOverview,
  fresh_window,
  limitLine,
  presentChildren,
  shallow_inks,
  status,
  type Conversation,
  type BackgroundView,
} from "./subagent_tooltip";
import { View as UsageView, Tokens } from "./usage/live";
import { View as ContextView } from "./usage/context_window";
import { Window } from "./usage/account";
import type { Spark } from "./usage/limits";
import { option } from "./agent_launcher";
import { Writer } from "./text";
import * as palette from "./palette";
import * as sidebar from "./sidebar";
import { Terminal } from "./pane/terminal";
import { microTimestamp } from "./clock";
import type { Agent } from "./mirror";

const base = new palette.Style({ fg: "text", bg: "bg" }).sgr();
const usage = (tokens: Partial<Record<"input" | "cached_input" | "output", number>> = {}, fields: Partial<UsageView> = {}) =>
  new UsageView({
    known: true,
    tokens: new Tokens({ input: BigInt(tokens.input ?? 0), cached_input: BigInt(tokens.cached_input ?? 0), output: BigInt(tokens.output ?? 0) }),
    ...fields,
  });
function agent(fields: Partial<Agent>): Agent {
  return conversation({ agent: { state: "working", attention: "none", session: "test", ...fields } }).agent;
}
function convo(fields: Partial<Omit<Conversation, "agent">> & { agent: Agent }): Conversation {
  return { ...conversation({}), ...fields, agent: { ...fields.agent, subagents: { ...fields.agent.subagents } } };
}
function entry(fields: Partial<sidebar.Entry>): sidebar.Entry {
  return sidebar.entry({ target: { pane: 1 }, ...fields });
}
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;
function render(fn: (w: Writer) => void): string {
  const w = new Writer();
  fn(w);
  return w.buffered();
}

test("compact child rows prioritize activity and color only the status and secondary name", () => {
  const child = convo({
    id: 2,
    agent: agent({ provider: "codex", name: "Maxwell with a long name", activity: "Tracing activity integration" }),
    usage: usage({ input: 1000, cached_input: 800 }),
  });
  for (const state of ["working", "blocked", "idle", "done"]) {
    child.agent.state = state;
    const frame = render((w) => new Card(w, 0, 88).childRow(0, child));
    expect(frame).toContain("Tracing activity integration");
    expect(frame).toContain("Maxwell with a lo…");
    const tone: Tone = state === "working" ? "working" : state === "blocked" ? "warm" : "muted";
    const glyph = { done: "✓", idle: "○", working: "▶" }[state] ?? "●";
    expect(frame).toContain(Tone.ansi(tone) + glyph);
    expect(frame).toContain("200");
    expect(frame).toContain("800");
  }
  const narrow = render((w) => new Card(w, 0, 64).childRow(0, child));
  expect(narrow).toContain("Tracing activity integration");
  expect(narrow).not.toContain("Maxwell");
});

test("idle children stay hidden while active descendants and usage remain", () => {
  const now = microTimestamp();
  const working = agent({ provider: "codex", activity: "Scanning" });
  const all = [
    convo({ id: 1, attachments: 1, agent: working, children_observed_at: now }),
    convo({ id: 2, parent: 1, role: "Hidden role", agent: working, observed_at: now, usage: usage({ input: 20 }) }),
    convo({ id: 3, parent: 2, role: "Explorer", agent: working, observed_at: now, usage: usage({ input: 30 }) }),
  ];
  all[0].agent.state = "idle";
  all[0].agent.name = "Visible parent";
  all[1].agent.state = "idle";
  all[1].agent.name = "Hidden child";
  all[2].agent.name = "Visible grandchild";
  const e = entry({ conversation: 1, provider: "codex", state: "idle", attention: "none" });
  presentChildren(e, all, now);
  expect(e.children).toBe(1);
  const model = Model.init(all, 1);
  expect(model.children).toBe(1);
  expect(model.group_count).toBe(1);
  expect(model.total.tokens.total()).toBe(50n);
  const output = render((w) => draw(w, all, e, 100, 45, 5, 14));
  expect(output).not.toContain("Hidden child");
  expect(output).not.toContain("Hidden role");
  expect(output).toContain("Visible grandchild");
  const overview = render((w) => drawOverview(w, all, new UsageView(), false, "gpt-6-luna", "GPT-6 Luna", {}, new Accounts(), 100, 30));
  expect(overview).not.toContain("Hidden child");
  expect(overview).toContain("Visible parent");
  expect(overview).toContain("50 tokens");
  all[2].agent.state = "idle";
  presentChildren(e, all, now);
  expect(e.children).toBe(0);
});

test("role groups aggregate each descendant once and exclude other trees", () => {
  const working = agent({ provider: "codex", activity: "Scanning" });
  const all = [
    convo({ id: 1, agent: working, usage: usage({ input: 10 }) }),
    convo({ id: 2, parent: 1, role: "Explorer", agent: working, usage: usage({ input: 20 }) }),
    convo({ id: 3, parent: 2, role: "explorer", agent: working, usage: usage({ input: 30 }) }),
    convo({ id: 4, parent: 99, role: "Explorer", agent: working, usage: usage({ input: 900 }) }),
  ];
  const model = Model.init(all, 1);
  expect(model.group_count).toBe(1);
  expect(model.children).toBe(2);
  expect(model.groups[0].usage.tokens.total()).toBe(50n);
  expect(model.total.tokens.total()).toBe(60n);
  expect(model.total.partial).toBe(false);
  const output = render((w) => drawOverview(w, all, new UsageView(), false, "gpt-6-luna", "GPT-6 Luna", {}, new Accounts(), 100, 30));
  expect(output).toContain("960 tokens");
  expect(output).toContain("Corgi (Activity summarizer)");
  expect(output).toContain("Top agents");
});

test("both agent rows open one safe card before a session is bound and exiting rows do not", () => {
  const entries = [entry({ provider: "codex", state: "initializing", attention: "none", name: "探索\x1b[2J" })];
  const view = sidebar.View.init(100, 30, true, 0, 1);
  const top = view.middle() + 2;
  expect(sidebar.agentAt(view, entries, 5, top)).toBe(entries[0]);
  expect(sidebar.agentAt(view, entries, 24, top + 1)).toBe(entries[0]);
  expect(sidebar.agentAt(view, entries, view.width, top)).toBeNull();
  expect(sidebar.agentAt(view, entries, 5, top + 2)).toBeNull();
  const text = render((w) => draw(w, [], entries[0], 100, 30, 5, top));
  expect(text).toContain("探索?[2J");
  expect(text).not.toContain("\x1b[2J");
  expect(text).toContain("Total");
  expect(count(text, "—")).toBe(2);
  expect(text).toContain("Starting session");
  expect(text).not.toContain("No subagents");
  entries[0].exit = { frame_ms: 1, progress: 0.5 };
  expect(sidebar.agentAt(view, entries, 5, top)).toBeNull();
});

test("total shares one set of timeline columns with compact child rows", () => {
  const working = agent({ provider: "codex", activity: "Running tests" });
  const own = usage({ input: 11900, cached_input: 7800, output: 2800 }, { recent_tokens: 14700n });
  const points = [
    { at: 1000, activity: "Reading source", usage: usage({ input: 1200 }) },
    { at: 2000, activity: "Tracing usage", usage: usage({ input: 5400 }) },
    { at: 3000, activity: "Running tests", usage: usage({ input: 7600 }) },
  ];
  const now = microTimestamp();
  const all = [
    convo({ id: 1, agent: working, children_observed_at: now, usage: own, timeline: { points, pending: usage({ input: 500 }) } }),
    convo({ id: 2, parent: 1, role: "Explorer", agent: working, observed_at: now }),
    convo({ id: 3, parent: 1, role: "Explorer", agent: working, observed_at: now }),
    convo({ id: 4, parent: 1, role: "Reviewer", agent: working, observed_at: now }),
  ];
  const e = entry({ conversation: 1, provider: "codex", state: "working", attention: "none" });
  const output = render((w) => draw(w, all, e, 64, 30, 5, 14));
  expect(count(output, "Tokens")).toBe(1);
  expect(count(output, "Cached")).toBe(1);
  for (const text of ["Total", "Tokens", "Cached", "6.9k", "7.8k", "Reading source", "Tracing usage", "Running tests", "500+", "Including subagents", "↳"]) expect(output).toContain(text);
});

test("timeline renders each phase once with its own interval including idle and clipped views", () => {
  const points = [
    { at: 1000, activity: "Reviewing pending changes", usage: usage({ input: 21500, cached_input: 12800 }) },
    { at: 2000, activity: "Inspecting repository changes", usage: usage() },
  ];
  const root = convo({ id: 1, agent: agent({ provider: "codex", activity: "Inspecting repository changes" }), timeline: { points, pending: usage({ input: 99600, cached_input: 78700 }) } });
  for (const state of ["working", "blocked", "idle"]) {
    root.agent.state = state;
    for (const nodes of [1, 2]) {
      const frame = render((w) => new Card(w, 0, 88).timeline(0, root, root.agent, nodes, true));
      const latest = frame.indexOf("Inspecting repository changes");
      expect(frame.slice(latest + 1)).not.toContain("Inspecting repository changes");
      expect(frame.slice(latest)).toContain(state === "working" ? "20.9k+" : "20.9k");
      expect(frame.slice(latest)).toContain("78.7k");
      expect(frame).not.toContain("In progress");
      if (nodes === 2) {
        expect(frame.slice(0, latest)).toContain("Reviewing pending changes");
        expect(frame.slice(0, latest)).toContain("8.7k");
        expect(frame.slice(0, latest)).toContain("12.8k");
      } else expect(frame).not.toContain("Reviewing pending changes");
    }
  }
});

test("new turn without a summary keeps the old label historical even when clipped", () => {
  const points = [{ at: 1000, activity: "Inspecting installer script", usage: usage() }];
  const root = convo({ id: 1, agent: agent({ provider: "codex", activity: "", recent_activity: "Old tool" }), timeline: { points, pending: usage({ input: 345 }) } });
  for (const nodes of [1, 2]) {
    const frame = render((w) => new Card(w, 0, 88).timeline(0, root, root.agent, nodes, true));
    expect(frame).toContain("  now  ●  .");
    expect(frame).not.toContain("Old tool");
    expect(frame).not.toContain("345+");
    if (nodes === 2) expect(frame).toContain(" last  ○  Inspecting installer script");
    else expect(frame).not.toContain("Inspecting installer script");
  }
  root.timeline = { points: [], pending: new UsageView() };
  const output = render((w) => new Card(w, 0, 88).timeline(0, root, root.agent, 1, false));
  expect(output).toContain("  now  ●  .");
});

test("compaction is the current timeline phase even before the first summary", () => {
  const points = [{ at: 1000, activity: "Compacting context", usage: usage() }];
  for (const label of ["", "Old inferred activity"]) {
    const root = convo({ id: 1, agent: agent({ provider: "codex", activity: label, compacting: true }), timeline: { points, pending: usage({ input: 345 }) } });
    const e = entry({ conversation: 1, provider: "codex", state: "working", attention: "none" });
    const output = render((w) => draw(w, [root], e, 64, 13, 5, 8));
    expect(count(output, "Compacting context")).toBe(1);
    expect(output).toContain("now  ●  Compacting context");
    expect(output).toContain("345+");
    expect(output).not.toContain("Old inferred activity");
  }
});

test("overview excludes detached history and shows Corgi activity", () => {
  const now = microTimestamp();
  const working = agent({ provider: "codex", activity: "" });
  const all = [
    convo({ id: 1, attachments: 1, agent: working }),
    convo({ id: 2, agent: working, usage: usage({ input: 900 }) }),
    convo({ id: 3, parent: 1, observed_at: now, agent: working }),
    convo({ id: 4, parent: 2, observed_at: now, agent: working }),
    convo({ id: 5, parent: 1, observed_at: now - fresh_window - 1, agent: working }),
    convo({ id: 6, attachments: 1, agent: working }),
  ];
  all[0].agent.state = "idle";
  all[0].agent.name = "Open session";
  all[1].agent.name = "Detached history";
  all[2].agent.name = "Live child";
  all[3].agent.name = "Detached child";
  all[4].agent.name = "Stale child";
  all[5].agent.state = "done";
  all[5].agent.name = "Ended session";
  for (const system_working of [false, true]) {
    const frame = render((w) => drawOverview(w, all, new UsageView(), system_working, "gpt-6-luna", "GPT-6 Luna", {}, new Accounts(), 100, 30));
    for (const text of ["Open session", "Live child", "900 tokens", system_working ? "▶ Corgi (Activity summarizer)" : "○ Corgi (Activity summarizer)"]) expect(frame).toContain(text);
    for (const text of ["Detached history", "Detached child", "Stale child", "Ended session", "more agents"]) expect(frame).not.toContain(text);
  }
});

test("overview ranks all agents together and keeps Corgi in small windows", () => {
  const working = agent({ provider: "codex", activity: "Running tests" });
  const all = [
    convo({ id: 1, attachments: 1, agent: working, usage: usage({ input: 100 }) }),
    convo({ id: 2, parent: 1, attachments: 1, agent: working, usage: usage({ input: 300 }) }),
    convo({ id: 3, attachments: 1, agent: working, usage: usage({ input: 900 }) }),
    convo({ id: 4, attachments: 1, agent: working }),
  ];
  all[0].model = "gpt-6";
  all[0].agent.name = "Parent task";
  all[1].agent.name = "Child task";
  all[2].agent.name = "Largest task";
  all[3].agent.name = "Unreported task";
  const system = usage({ input: 50 });
  const frame = render((w) => drawOverview(w, all, system, false, "gpt-6-luna", "GPT-6 Luna", {}, new Accounts(), 100, 30));
  // Corgi's own row names its model, as agent rows do.
  for (const text of ["GPT-6 Luna", "gpt-6", "Cached", "1.4k tokens", "50", "Unreported task"]) expect(frame).toContain(text);
  expect(frame.indexOf("Largest task")).toBeLessThan(frame.indexOf("Child task"));
  expect(frame.indexOf("Child task")).toBeLessThan(frame.indexOf("Parent task"));
  const small = render((w) => drawOverview(w, all, system, false, "gpt-6-luna", "GPT-6 Luna", {}, new Accounts(), 64, 13));
  // Narrow cards clip the label; the Corgi prefix stays visible.
  for (const text of ["○ Corgi", "Largest", "Child"]) expect(small).toContain(text);

  // Cached-heavy agents must not outrank larger displayed Tokens values.
  all[0].usage.tokens = new Tokens({ input: 10000n, cached_input: 9990n });
  const sorted = render((w) => drawOverview(w, all, system, false, "gpt-6-luna", "GPT-6 Luna", {}, new Accounts(), 100, 30));
  expect(sorted.indexOf("Child task")).toBeLessThan(sorted.indexOf("Corgi (Activity summarizer)"));
  expect(sorted.indexOf("Corgi (Activity summarizer)")).toBeLessThan(sorted.indexOf("Parent task"));

  const many = Array.from({ length: 12 }, (_, i) => {
    const item = convo({ id: i + 1, attachments: 1, agent: working, usage: usage({ input: 1000 + i }) });
    item.agent.name = "Ranked task";
    return item;
  });
  const capped = render((w) => drawOverview(w, many, usage({ input: 50, cached_input: 30, output: 5 }), false, "gpt-6-luna", "GPT-6 Luna", {}, new Accounts(), 100, 30));
  expect(count(capped, "Ranked task")).toBe(9);
  expect(count(capped, "Corgi (Activity summarizer)")).toBe(1);
  expect(capped).toContain("25");
  expect(capped).toContain("... 3 more agents");
});

function testAccounts(now: number): Accounts {
  const claude = option({
    account: "work@acme.dev",
    plan: "max",
    usage_fetched_at: now,
    limits: {
      windows: [
        { minutes: 300, used: 100, reset_at: now + 42 * 60 },
        { minutes: 10080, used: 63, reset_at: now + 3 * 86400 + 16 * 3600 },
      ],
    },
    history: [[5, 13, 24, 35, null, 61, 73, 86, 100, 100, null], Array(11).fill(null)],
  });
  const codex = option({
    account: "me@home.dev",
    usage_fetched_at: now,
    limits: { windows: [{ minutes: 10080, used: 84, reset_at: now + 5 * 86400 + 14 * 3600 }, null] },
  });
  return new Accounts({ system: "codex", now, options: { codex, claude } });
}

test("wide terminals put each account's limits beside its agents", () => {
  const now = Math.floor(Date.now() / 1000);
  const all = [
    convo({ id: 1, attachments: 1, agent: agent({ provider: "claude", session: "c", activity: "" }), usage: usage({ input: 900 }) }),
    convo({ id: 2, attachments: 1, agent: agent({ provider: "codex", session: "c", activity: "" }), usage: usage({ input: 500 }) }),
  ];
  all[0].agent.name = "Claude task";
  all[1].agent.name = "Codex task";
  const accounts = testAccounts(now);
  const frame = render((w) => drawOverview(w, all, new UsageView(), false, "gpt-6-luna", "GPT-6 Luna", {}, accounts, 130, 40));
  for (const text of ["Limits", "Claude work@acme.dev", "Codex me@home.dev", "100%", "↻ 42m", "84%", "┬", "┼", "┴"]) expect(frame).toContain(text);
  // The full 5h window sorts first, and each account's agents follow its rule.
  const claude_rule = frame.indexOf("Claude work@acme.dev");
  const codex_rule = frame.indexOf("Codex me@home.dev");
  expect(claude_rule).toBeLessThan(frame.indexOf("Claude task"));
  expect(frame.indexOf("Claude task")).toBeLessThan(codex_rule);
  expect(codex_rule).toBeLessThan(frame.indexOf("Codex task"));
  // The summarizer runs on the Codex account.
  expect(codex_rule).toBeLessThan(frame.indexOf("Corgi (Activity summarizer)"));
  const narrow = render((w) => drawOverview(w, all, new UsageView(), false, "gpt-6-luna", "GPT-6 Luna", {}, accounts, 100, 40));
  expect(narrow).not.toContain("Limits");
  expect(narrow).toContain("Claude task");
});

test("accounts without agents keep their limits and short terminals fall back", () => {
  const now = Math.floor(Date.now() / 1000);
  const accounts = testAccounts(now);
  const output = render((w) => drawOverview(w, [], new UsageView(), false, "gpt-6-luna", "GPT-6 Luna", {}, accounts, 130, 40));
  expect(output).toContain("Claude work@acme.dev");
  expect(output).toContain("63%");
  const short = render((w) => drawOverview(w, [], new UsageView(), false, "gpt-6-luna", "GPT-6 Luna", {}, accounts, 130, 13));
  expect(short).not.toContain("Limits");
  expect(short).toContain("Top agents");
});

function expectSparkCell(line: string, i: number, glyph: string, ink: string) {
  // limitLine draws row 5, pane offset 87, spark from pane + 3, on a card at x = 0.
  expect(line).toContain(`\x1b[6;${4 + 87 + 3 + i}H${base}${palette.bg("surface")}${ink}${glyph}`);
}

test("sparks ghost unobserved slots and stipple the time left", () => {
  const now = 1_000_000;
  // 200 of 300 minutes have passed: 8 of 11 cells.
  const window = new Window({ minutes: 300, used: 52, reset_at: now + 100 * 60 });
  const spark: Spark = [4, 11, null, null, 33, 45, null, null, null, null, null];
  const line = render((w) => limitLine(new Card(w, 0, 122), 5, 87, window, spark, true, now));
  // Short bars fade toward gray; from half height they are plain accent.
  expectSparkCell(line, 0, "▁", shallow_inks[0]);
  expectSparkCell(line, 1, "▁", shallow_inks[0]);
  // Missed slots show a gray bar at the last reading's level.
  expectSparkCell(line, 2, "▁", Tone.ansi("faint"));
  expectSparkCell(line, 3, "▁", Tone.ansi("faint"));
  expectSparkCell(line, 4, "▃", shallow_inks[2]);
  expectSparkCell(line, 5, "▄", Tone.ansi("live"));
  expectSparkCell(line, 6, "▄", Tone.ansi("faint"));
  // The current slot shows the latest reading before history records it.
  expectSparkCell(line, 7, "▄", Tone.ansi("live"));
  for (let i = 8; i < 11; i++) expectSparkCell(line, i, "⢕", Tone.ansi("remaining"));
  expect(line).not.toContain("┈");
  expect(line).toContain("52%");
  expect(line).toContain("↻ 1h 40m");

  // Before the first reading, missed slots are the gray floor.
  const early = new Window({ minutes: 300, used: 40, reset_at: now + 220 * 60 });
  const first = render((w) => limitLine(new Card(w, 0, 122), 5, 87, early, Array(11).fill(null), true, now));
  expectSparkCell(first, 0, "▁", Tone.ansi("faint"));
  expectSparkCell(first, 1, "▁", Tone.ansi("faint"));
  expectSparkCell(first, 2, "▃", shallow_inks[2]);
  expectSparkCell(first, 3, "⢕", Tone.ansi("remaining"));

  const stale = render((w) => limitLine(new Card(w, 0, 122), 5, 87, window, spark, false, now));
  expect(stale).toContain("stale");
  expect(stale).not.toContain("↻");
  expectSparkCell(stale, 5, "▄", Tone.ansi("faint"));
  expectSparkCell(stale, 7, "▄", Tone.ansi("faint"));

  // Cells past 80% are warm and hot without bold; the figure stays bold.
  const full = new Window({ minutes: 300, used: 100, reset_at: now + 100 * 60 });
  const high = render((w) => limitLine(new Card(w, 0, 122), 5, 87, full, [50, 85, 100, null, null, null, null, null, null, null, null], true, now));
  expectSparkCell(high, 1, "▇", Tone.ansi("warm_cell"));
  expectSparkCell(high, 2, "█", Tone.ansi("hot_cell"));
  expect(high).toContain(`${Tone.ansi("hot")}100%`);
});

test("a finished agent the user has not seen shows a dot", () => {
  const finished_agent = agent({ provider: "codex", state: "idle", attention: "finished", session: "s", activity: "" });
  const finished = status(finished_agent, false);
  expect(finished.icon).toBe("●");
  expect(finished.label).toBe("Finished");
  expect(finished.tone).toBe("working");
  finished_agent.state = "working";
  expect(status(finished_agent, false).label).toBe("Working");
});

test("overview ranks by tokens of the priciest listed model", () => {
  const working = agent({ provider: "claude", activity: "Running tests" });
  const all = [
    convo({ id: 1, attachments: 1, agent: working, model: "claude-haiku-4-5-20251001", usage: usage({ input: 42_000, cached_input: 2_000, output: 2_000 }) }),
    convo({ id: 2, attachments: 1, agent: working, model: "claude-opus-5", usage: usage({ input: 12_000, cached_input: 2_000, output: 1_000 }) }),
    convo({ id: 3, attachments: 1, agent: working, model: "codex-auto-review", usage: usage({ input: 5_000 }) }),
  ];
  all[0].agent.name = "Haiku task";
  all[1].agent.name = "Opus task";
  all[2].agent.name = "Unpriced task";
  const frame = render((w) => drawOverview(w, all, new UsageView(), false, "gpt-6-luna", "GPT-6 Luna", {}, new Accounts(), 100, 30));
  // Haiku 42k raw is 8.4k in Opus tokens, below Opus's own 11k.
  expect(frame.indexOf("Opus task")).toBeLessThan(frame.indexOf("Haiku task"));
  expect(frame.indexOf("Haiku task")).toBeLessThan(frame.indexOf("Unpriced task"));
  for (const text of ["≈opus", "claude-opus-5", "8.4k", "11k", "42k", "?"]) expect(frame).toContain(text);
});

test("unavailable or stale child discovery makes no subagent claims", () => {
  const now = microTimestamp();
  const parent_agent = agent({ provider: "codex", session: "parent", activity: "Reading source", subagents: { running: 2, blocked: 0, waiting: true } });
  const all = [convo({ id: 1, agent: parent_agent }), convo({ id: 2, parent: 1, agent: parent_agent, role: "Explorer" })];
  const e = entry({ conversation: 1, provider: "codex", state: "working", attention: "none" });
  for (const stamp of [0, now - fresh_window - 1]) {
    all[0].children_observed_at = stamp;
    e.subagents = { ...parent_agent.subagents };
    presentChildren(e, all, now);
    expect(e.children).toBe(0);
    expect(e.subagents.running).toBe(0);
    expect(e.subagents.waiting).toBe(false);
    const output = render((w) => draw(w, all, e, 100, 30, 5, 14));
    for (const text of ["subagent", "Explorer", "Updating child", "Including subagents"]) expect(output).not.toContain(text);
    expect(output).toContain("Total");
  }
  all[0].children_observed_at = now;
  for (const c of [0, 1, 2]) {
    all[1].observed_at = c === 0 ? 0 : c === 1 ? now - fresh_window - 1 : now;
    all[1].agent.state = c === 2 ? "unknown" : "working";
    e.subagents = { ...parent_agent.subagents };
    presentChildren(e, all, now);
    expect(e.children).toBe(0);
    expect(e.subagents.waiting).toBe(false);
    const hidden = render((w) => draw(w, all, e, 100, 30, 5, 14));
    for (const text of ["?", "subagent", "Explorer", "Including subagents"]) expect(hidden).not.toContain(text);
  }
  all[1].observed_at = now;
  all[1].agent.state = "working";
  e.subagents = { ...parent_agent.subagents };
  presentChildren(e, all, now);
  expect(e.children).toBe(1);
  expect(e.subagents.running).toBe(2);
  e.subagents = { running: 0, blocked: 0, waiting: false };
  all[0].agent.subagents = { running: 0, blocked: 0, waiting: false };
  const output = render((w) => draw(w, all.slice(0, 1), e, 100, 30, 5, 14));
  expect(output).toContain("No subagents");
});

test("Claude's child list holds until its next Stop", () => {
  const now = microTimestamp();
  const old = now - 10 * fresh_window;
  const parent_agent = agent({ provider: "claude", session: "parent", activity: "", subagents: { running: 1, blocked: 0, waiting: true } });
  const lane = agent({ provider: "claude", session: "a1", name: "general-purpose", activity: "Lane A: sidebar" });
  const all = [convo({ id: 1, agent: parent_agent, children_observed_at: old }), convo({ id: 2, parent: 1, agent: lane, observed_at: old })];
  const e = entry({ conversation: 1, provider: "claude", state: "working", attention: "none", subagents: { ...parent_agent.subagents } });
  presentChildren(e, all, now);
  expect(e.children).toBe(1);
  expect(e.subagents.waiting).toBe(true);
  const output = render((w) => draw(w, all, e, 100, 30, 5, 14));
  for (const text of ["Lane A: sidebar", "Including subagents"]) expect(output).toContain(text);
  // No Stop has listed any yet.
  all[0].children_observed_at = 0;
  presentChildren(e, all, now);
  expect(e.children).toBe(0);
  expect(e.subagents.waiting).toBe(false);
});

test("compact token counts round through unit boundaries without overflow", () => {
  for (const [value, text] of [
    [0n, "0"],
    [999n, "999"],
    [1000n, "1k"],
    [12_345n, "12.3k"],
    [12_350n, "12.4k"],
    [999_949n, "999.9k"],
    [999_950n, "1M"],
    [2_345_678n, "2.3M"],
    [(1n << 64n) - 1n, "18.4E"],
  ] as const)
    expect(compact(value)).toBe(text);
});

test("background command rows group tasks and bound overflow without claiming stale work is live", () => {
  const items: BackgroundView["items"] = [
    { id: "server", label: "bun run dev", group: "servers" },
    { id: "tests", label: "Parser tests", group: "tests" },
    { id: "build", label: "Release build", group: "builds" },
  ];
  const tasks: BackgroundView = { items, observed_at: microTimestamp(), live: true, truncated: false };
  const w = new Writer();
  expect(new Card(w, 0, 64).backgroundTasks(0, tasks, 4)).toBe(4);
  const frame = w.buffered();
  expect(frame.indexOf("Tests · Parser tests")).toBeLessThan(frame.indexOf("Servers · bun run dev"));
  tasks.observed_at -= fresh_window + 1;
  const small = new Writer();
  expect(new Card(small, 0, 40).backgroundTasks(0, tasks, 3)).toBe(3);
  expect(small.buffered()).toContain("Last reported");
  expect(small.buffered()).toContain("+2 more commands");
});

test("overview footer shows the running release and a staged update", () => {
  const all = [convo({ id: 1, attachments: 1, agent: agent({ provider: "codex", activity: "" }) })];
  const current = render((w) =>
    drawOverview(w, all, new UsageView(), false, "", "", { running: "20260925T183012Z-be82c7b9090a", commit: "be82c7b9090a5f7e" }, new Accounts(), 100, 30),
  );
  expect(current).toContain("Corgi 2026-09-25 · be82c7b");
  expect(current).not.toContain("Update");
  const release = { running: "20260925T183012Z-be82c7b9090a", staged: "20260926T090000Z-a1b2c3d4e5f6" };
  const ready = render((w) => drawOverview(w, all, new UsageView(), false, "", "", release, new Accounts(), 100, 30));
  expect(ready).toContain(Tone.ansi("title") + "↑ Update 2026-09-26 · a1b2c3d ready · relaunch Corgi");
  const narrow = render((w) => drawOverview(w, all, new UsageView(), false, "", "", release, new Accounts(), 40, 13));
  expect(narrow).toContain("↑ Update ready · relaunch Corgi");
});

test("overview footer names a development build's commit", () => {
  const all = [convo({ id: 1, attachments: 1, agent: agent({ provider: "codex", activity: "" }) })];
  const output = render((w) => drawOverview(w, all, new UsageView(), false, "", "", { running: "0.1.0-dev", commit: "0123abcdef45-dirty" }, new Accounts(), 100, 30));
  expect(output).toContain("Corgi 0.1.0-dev · 0123abc-dirty");
});

function screenLines(all: Conversation[], e: sidebar.Entry, cols: number): string[] {
  const output = render((w) => draw(w, all, e, cols, 30, 0, 2));
  const host = Terminal.create(cols, 30);
  try {
    host.feed(output);
    return host.text().split("\n").slice(0, 30);
  } finally {
    host.destroy();
  }
}
const lineWith = (lines: string[], needle: string) => {
  const i = lines.findIndex((line) => line.includes(needle));
  return i < 0 ? null : i;
};

test("the card shows sixteen recent phases when the terminal has room", () => {
  const points = Array.from({ length: 16 }, (_, i) => ({ at: 1000 * (i + 1), activity: `Phase ${String(i + 1).padStart(2, "0")}`, usage: usage() }));
  const all = [
    convo({
      id: 1,
      agent: agent({ provider: "codex", name: "long run", session: "s", activity: "Phase 16" }),
      children_observed_at: microTimestamp(),
      timeline: { points, pending: usage() },
    }),
  ];
  const e = entry({ conversation: 1, name: "long run", provider: "codex", state: "working", attention: "none" });
  const lines = screenLines(all, e, 100);
  for (let i = 1; i <= 16; i++) expect(lineWith(lines, `Phase ${String(i).padStart(2, "0")}`)).not.toBeNull();
});

test("timeline rows older than the latest five recede toward the background", () => {
  const points = Array.from({ length: 8 }, (_, i) => ({ at: 1000 * (i + 1), activity: `Phase ${String(i + 1).padStart(2, "0")}`, usage: usage({ input: 1000 }) }));
  const root = convo({ id: 1, agent: agent({ provider: "codex", session: "s", activity: "Phase 08" }), timeline: { points, pending: usage() } });
  const frame = render((w) => new Card(w, 0, 88).timeline(0, root, root.agent, points.length, true));
  for (let i = 1; i <= 8; i++) {
    const at = frame.indexOf(`Phase ${String(i).padStart(2, "0")}`);
    const color = frame.slice(frame.lastIndexOf("\x1b[38;2;", at));
    const tone = i <= 3 ? Tone.faded("muted") : i === 8 ? Tone.ansi("strong") : Tone.ansi("muted");
    expect(color.startsWith(tone)).toBe(true);
  }
});

test("the subtitle pairs provider and model with the context meter, and activity moves below until there is a timeline", () => {
  const now = microTimestamp();
  const activity_text = "Running the reload suite against the v5 fixtures";
  const all = [
    convo({
      id: 1,
      agent: agent({ provider: "codex", name: "api refactor", session: "s", activity: activity_text }),
      model: "gpt-6-astra",
      model_name: "GPT-6 Astra",
      children_observed_at: now,
      context: new ContextView({ used: 85_386n, window: 258_400n, at: 1 }),
    }),
  ];
  const e = entry({ conversation: 1, name: "api refactor", provider: "codex", state: "working", attention: "none" });

  // No timeline: the activity keeps a whole line under the subtitle.
  let lines = screenLines(all, e, 100);
  let subtitle = lineWith(lines, "codex · GPT-6 Astra")!;
  expect(lines[subtitle]).toContain("context ━━━━━");
  expect(lines[subtitle]).toContain("33%");
  expect(lines[subtitle + 1]).toContain(activity_text);
  expect(lines[subtitle + 2]).toContain("Tokens");

  // With a timeline, the activity is its "now" row and the card keeps its height.
  all[0].timeline = { points: [{ at: 1000, activity: activity_text, usage: usage() }], pending: usage() };
  lines = screenLines(all, e, 100);
  subtitle = lineWith(lines, "codex · GPT-6 Astra")!;
  expect(lines[subtitle + 1]).toContain("Tokens");

  // The narrowest card keeps the figure and drops the bar.
  lines = screenLines(all, e, 40);
  expect(lineWith(lines, "context 33%")).not.toBeNull();

  // Ended sessions and conversations without a reading show no meter.
  e.state = "done";
  expect(lineWith(screenLines(all, e, 100), "context")).toBeNull();
  e.state = "working";
  all[0].context = new ContextView();
  expect(lineWith(screenLines(all, e, 100), "context")).toBeNull();

  // Near a learned compaction point the figure is hot and bold, and fades
  // into the card while compacting.
  all[0].context = new ContextView({ used: 381_000n, window: 1_000_000n, compacts_at: 400_000n, at: 1 });
  const hot = render((w) => draw(w, all, e, 100, 30, 0, 2));
  expect(hot).toContain("\x1b[1m" + palette.fg("hot") + "38%");
  all[0].agent.compacting = true;
  const output = render((w) => draw(w, all, e, 100, 30, 0, 2));
  expect(output).toContain("\x1b[1m" + palette.fgRgb(palette.mix(palette.colors.hot, palette.colors.bg, 60)) + "38%");
  expect(output).toContain("┼");
});
