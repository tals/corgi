#!/usr/bin/env bun
// Grade a replay's final plan against its transcript, as a reader of the tooltip would.
import * as fs from "node:fs";
import * as path from "node:path";
import type { History } from "./history";
import type { Node, State } from "./plan";

export const dimensions = ["goal", "episodes", "steps", "problems", "states", "labels"] as const;
export type Dimension = (typeof dimensions)[number];
export const faults = [
  "wrong_scope",
  "wrong_parent",
  "false_problem",
  "stale_problem",
  "stale_state",
  "noise_step",
  "duplicate",
  "vague_label",
  "false_label",
  "leaked_meta",
] as const;
export type Fault = (typeof faults)[number];
export type Verdict = {
  scores: Record<Dimension, number>;
  reasons: Record<Dimension, string>;
  overall: number;
  summary: string;
  good: { id: string; why: string }[];
  bad: { id: string; fault: Fault; why: string }[];
  missing: string[];
};

export const instructions = `You grade a "long-term plan": a small tree a cheap model maintains while watching a coding agent work. A developer hovers the agent in a sidebar and glances at this tree for a few seconds to learn what the agent has been doing, where the tokens went and what went wrong. Grade it for that reader.

You get DIGEST, a condensed transcript of the real session (user messages in full; agent commentary, tool calls and results clipped), optionally TRUTH, a human's notes on what happened, and PLAN, the final tree: episodes and the steps inside them. Each row has an id, a state (planned, active, done, failed, blocked, skipped), a title, a subtitle, its share of the session's tokens, and sometimes a problem marker: ! category open|resolved detail. The tooltip shows an open problem as a red ! on its row and a resolved one dimmed.

Score each dimension 1-5 (5 = a careful human would have written this; 3 = usable with visible flaws; 1 = misleading or useless) with one sentence of reason that names rows:
- goal: read together, the episode rows say what the user actually wanted, including later requests that changed or replaced the first one.
- episodes: episodes are the subproblems a human would name. Not one catch-all holding everything, not fragments of one subproblem, and a separately requested piece of work has its own.
- steps: steps are meaningful activities at a useful grain. Penalize rows that exist only because a command was retried, rows per tool call, duplicates, and long runs a reader would have to skim.
- problems: every ! is a real problem that cost the agent time or changed its course, and the ones that mattered are present. Penalize ! on trivia (a search that found nothing, a quickly corrected typo), problems still open that the session visibly resolved, and missed ones.
- states: done/active/failed match how the session really ended. Penalize work left active that finished, and finished sessions that read as failing.
- labels: titles are concrete and subtitles carry a finding, constraint or result that is true. Penalize vague labels, anything false, and text that leaks the plan's own bookkeeping.
Then overall 1-5: how well a ten-second glance at this tree tells the truth about the session.

List up to 4 good rows worth showing as examples, up to 8 bad rows, each with a fault from: ${faults.join(", ")}; and up to 4 things missing that the reader would expect. Use only ids present in PLAN. Be specific and terse; quote the row text you object to.

Return only JSON: {"scores":{"goal":n,"episodes":n,"steps":n,"problems":n,"states":n,"labels":n},"reasons":{"goal":"","episodes":"","steps":"","problems":"","states":"","labels":""},"overall":n,"summary":"two sentences","good":[{"id":"","why":""}],"bad":[{"id":"","fault":"","why":""}],"missing":[""]}`;

const failing = /exit(ed)? (code |status )?[1-9]|error|fail|traceback|conflict|denied|not found|timed? ?out/i;
/** User text in full; everything else clipped, tightening until it fits. */
export function digest(data: History, budget = 110_000) {
  for (const scale of [1, 0.5, 0.25, 0.12]) {
    const lines = data.events.flatMap(e => {
      const text = e.text.replace(/\s+/g, " ");
      switch (e.kind) {
        case "user":
          return [`${e.id} USER: ${text.slice(0, 1500)}`];
        case "assistant":
          return [`${e.id} agent: ${text.slice(0, 500 * scale)}`];
        case "tool":
        case "plan":
          return [`${e.id} ${e.kind}: ${text.slice(0, 180 * scale)}`];
        case "result":
          return [`${e.id} result: ${text.slice(0, (failing.test(text) ? 320 : 120) * scale)}`];
        case "lifecycle":
          return [`${e.id} lifecycle: ${text.slice(0, 60)}`];
        default:
          return [];
      }
    });
    const out = lines.join("\n");
    if (out.length <= budget || scale === 0.12) return out.slice(0, budget);
  }
  return "";
}

export function tree(state: State, share: (id: string) => string = () => "") {
  const row = (n: Node, depth: number): string[] => [
    `${"  ".repeat(depth)}${n.id} [${n.state}] ${n.title}${share(n.id)}${n.bump ? ` ! ${n.bump.kind} ${n.bump.state}: ${n.bump.detail}` : ""}`,
    `${"  ".repeat(depth)}   ${n.subtitle}`,
    ...state.nodes.filter(c => c.parent === n.id).flatMap(c => row(c, depth + 1)),
  ];
  return state.nodes
    .filter(n => n.parent === null)
    .flatMap(n => row(n, 0))
    .join("\n");
}

/** Model-free facts about the tree's shape; ratios are 0-1. */
export function shape(state: State, events: number) {
  const of = (kind: Node["kind"]) => state.nodes.filter(n => n.kind === kind),
    steps = of("step"),
    episodes = of("episode");
  const owned = state.spans.filter(s => s.node !== null).reduce((n, s) => n + s.to - s.from + 1, 0);
  return {
    episodes: episodes.length,
    steps: steps.length,
    largest_episode: Math.max(0, ...episodes.map(e => steps.filter(s => s.parent === e.id).length)),
    failed_steps: steps.filter(s => s.state === "failed").length,
    problems: steps.filter(s => s.bump).length,
    open_problems: steps.filter(s => s.bump?.state === "open").length,
    active_steps: steps.filter(s => s.state === "active").length,
    owned: events ? owned / events : 0,
  };
}

export function parse(text: string, state: State): Verdict {
  const start = text.indexOf("{"),
    end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw Error("InvalidVerdict");
  const v = JSON.parse(text.slice(start, end + 1));
  const ids = new Set(state.nodes.map(n => n.id));
  const score = (n: unknown) => {
    if (typeof n !== "number" || n < 1 || n > 5) throw Error("InvalidVerdict");
    return n;
  };
  for (const d of dimensions) {
    score(v.scores?.[d]);
    if (typeof v.reasons?.[d] !== "string") throw Error("InvalidVerdict");
  }
  score(v.overall);
  return {
    scores: v.scores,
    reasons: v.reasons,
    overall: v.overall,
    summary: String(v.summary ?? ""),
    good: (v.good ?? []).filter((g: { id: string }) => ids.has(g.id)),
    bad: (v.bad ?? []).filter((b: { id: string; fault: Fault }) => ids.has(b.id) && faults.includes(b.fault)),
    missing: (v.missing ?? []).map(String),
  };
}

async function ask(model: string, prompt: string) {
  const child = Bun.spawn(
    [
      "claude",
      "--print",
      "--output-format",
      "json",
      "--safe-mode",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--tools",
      "",
      "--no-session-persistence",
      "--system-prompt",
      instructions,
      "--model",
      model,
    ],
    { stdin: new Blob([prompt]), stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) throw Error(`JudgeFailed:${(await new Response(child.stderr).text()).slice(0, 300)}`);
  return String(JSON.parse(out).result);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const option = (name: string, fallback: string) => {
    const i = args.indexOf(name);
    return i < 0 ? fallback : args.splice(i, 2)[1];
  };
  const model = option("--model", "claude-sonnet-5-5"),
    truthPath = option("--truth", ""),
    jobs = Number(option("--jobs", "4")),
    force = args.includes("--force") && args.splice(args.indexOf("--force"), 1).length > 0;
  const summary = args.includes("--summary") && args.splice(args.indexOf("--summary"), 1).length > 0;
  if (!args.length)
    throw Error(
      "Usage: judge.ts [--model MODEL] [--truth truth.json] [--jobs 4] [--force] [--summary] RUN_DIRECTORY...",
    );
  const truth: { id: string; truth: unknown }[] = truthPath ? JSON.parse(fs.readFileSync(truthPath, "utf8")) : [];
  const work = args.flatMap(directory =>
    fs
      .readdirSync(directory)
      .filter(f => f.endsWith(".calls.json"))
      .map(f => ({ directory, id: f.slice(0, -".calls.json".length) })),
  );
  const run = async ({ directory, id }: { directory: string; id: string }) => {
    const out = path.join(directory, `${id}.verdict.json`);
    if (fs.existsSync(out) && !force) return;
    const calls: { state?: State }[] = JSON.parse(fs.readFileSync(path.join(directory, `${id}.calls.json`), "utf8"));
    const state = calls.findLast(c => c.state)?.state;
    if (!state?.nodes.length) return console.log(`${directory}/${id}: no plan`);
    const data: History = JSON.parse(fs.readFileSync(path.join(directory, `${id}.history.json`), "utf8"));
    const notes = truth.find(t => t.id === id)?.truth;
    const prompt = `DIGEST (${data.events.length} events; plan covers through event ${state.through})\n${digest(data)}\n\n${notes ? `TRUTH\n${JSON.stringify(notes, null, 1)}\n\n` : ""}PLAN\n${tree(state)}`;
    try {
      const verdict = parse(await ask(model, prompt), state);
      fs.writeFileSync(
        out,
        JSON.stringify(
          { model, id, through: state.through, shape: shape(state, data.events.length), ...verdict },
          null,
          2,
        ),
      );
      console.log(
        `${directory}/${id}: overall ${verdict.overall} · ${dimensions.map(d => `${d} ${verdict.scores[d]}`).join(" · ")}`,
      );
    } catch (error) {
      console.log(`${directory}/${id}: ${error}`);
    }
  };
  if (summary) {
    const rows = work.flatMap(({ directory, id }) => {
      const file = path.join(directory, `${id}.verdict.json`);
      return fs.existsSync(file)
        ? [{ run: path.basename(directory), ...JSON.parse(fs.readFileSync(file, "utf8")) }]
        : [];
    });
    console.log(`| Run | Case | Overall | ${dimensions.join(" | ")} | E/S | ! (open) | Owned |`);
    console.log(`| --- | --- | ---: | ${dimensions.map(() => "---:").join(" | ")} | --- | --- | ---: |`);
    for (const r of rows)
      console.log(
        `| ${r.run} | ${r.id} | ${r.overall} | ${dimensions.map(d => r.scores[d]).join(" | ")} | ${r.shape.episodes}/${r.shape.steps} | ${r.shape.problems} (${r.shape.open_problems}) | ${Math.round(r.shape.owned * 100)}% |`,
      );
    const mean = (f: (r: (typeof rows)[number]) => number) =>
      (rows.reduce((n, r) => n + f(r), 0) / Math.max(1, rows.length)).toFixed(2);
    console.log(
      `| mean | ${rows.length} cases | ${mean(r => r.overall)} | ${dimensions.map(d => mean(r => r.scores[d])).join(" | ")} | | | |`,
    );
    process.exit(0);
  }
  const queue = [...work];
  await Promise.all(
    Array.from({ length: jobs }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) await run(item);
    }),
  );
}
