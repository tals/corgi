#!/usr/bin/env bun
// Turn judge verdicts into the artifact's good and bad example rows.
import * as fs from "node:fs";
import * as path from "node:path";
import * as plan from "./plan";
import type { State } from "./plan";
import type { Fault, Verdict } from "./judge";

/** Good rows are grouped by what the judge praised: a problem marker, an episode's scope, or a step's result. */
export type Strength = "flagged_problem" | "episode_scope" | "concrete_step";
export type Category = Strength | Fault;
export type Example = {
  replay: string;
  event?: number;
  node?: string;
  verdict: "good" | "bad";
  category: Category;
  title: string;
  /** One sentence: what the judge saw. */
  tldr: string;
  note: string;
};
export const categories: Record<Category, string> = {
  flagged_problem: "Real problem flagged",
  episode_scope: "Episode scope",
  concrete_step: "Concrete step",
  wrong_scope: "Wrong scope",
  wrong_parent: "Wrong parent",
  false_problem: "Not a real problem",
  stale_problem: "Problem already fixed",
  stale_state: "Stale state",
  noise_step: "Noise step",
  duplicate: "Duplicate row",
  vague_label: "Vague label",
  false_label: "False label",
  leaked_meta: "Leaked bookkeeping",
};
const good = 2,
  bad = 3;

/** The first sentence, for a one-line summary. */
export const sentence = (text: string) => text.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? text;

function examples(directory: string): Example[] {
  const out: Example[] = [];
  for (const file of fs
    .readdirSync(directory)
    .filter(f => f.endsWith(".verdict.json"))
    .sort()) {
    const id = file.slice(0, -".verdict.json".length),
      verdict: Verdict = JSON.parse(fs.readFileSync(path.join(directory, file), "utf8")),
      calls: { state?: State; through: number }[] = JSON.parse(
        fs.readFileSync(path.join(directory, `${id}.calls.json`), "utf8"),
      ),
      last = calls.findLast(c => c.state)!,
      replay = `${path.basename(directory)}/${id}`;
    // Only rows the tooltip still draws; levels the plan no longer has drop out.
    const shown = new Set((plan.flatten(last.state!.nodes) as plan.Node[]).map(n => n.id));
    const row = (node: string) => last.state!.nodes.find(n => n.id === node)!;
    // The checkpoint where the row last changed shows it in the tooltip's tail.
    const seen = (node: string) => {
      let event = last.through,
        text = JSON.stringify(row(node));
      for (const call of calls.toReversed()) {
        if (!call.state) continue;
        if (JSON.stringify(call.state.nodes.find(n => n.id === node)) !== text) break;
        event = call.through;
      }
      return event;
    };
    const praised = verdict.good.filter(g => shown.has(g.id));
    for (const g of praised.slice(0, good)) {
      const r = row(g.id);
      out.push({
        replay,
        event: seen(g.id),
        node: g.id,
        verdict: "good",
        category: r.bump ? "flagged_problem" : r.kind === "step" ? "concrete_step" : "episode_scope",
        title: r.title,
        tldr: sentence(g.why),
        note: g.why,
      });
    }
    // Distinct faults first, then repeats.
    const faulted = verdict.bad.filter(b => shown.has(b.id)),
      distinct = faulted.filter((b, i) => faulted.findIndex(o => o.fault === b.fault) === i),
      picked = [...distinct, ...faulted.filter(b => !distinct.includes(b))].slice(0, bad);
    for (const b of picked) {
      const r = row(b.id);
      out.push({
        replay,
        node: b.id,
        event: b.fault.startsWith("stale") || r.kind !== "step" ? last.through : seen(b.id),
        verdict: "bad",
        category: b.fault,
        title: r.title,
        tldr: sentence(b.why),
        note: b.why,
      });
    }
  }
  return out;
}

if (import.meta.main) {
  const args = process.argv.slice(2),
    at = args.indexOf("--out"),
    out = at < 0 ? ".lavish/long-plan-examples.json" : args.splice(at, 2)[1];
  if (!args.length) throw Error("Usage: examples.ts [--out FILE.json] RUN_DIRECTORY...");
  const list = args.flatMap(examples);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(list, null, 2));
  const count = (v: Example["verdict"]) => list.filter(e => e.verdict === v).length;
  console.log(`${list.length} examples (${count("good")} good, ${count("bad")} bad) → ${out}`);
}
