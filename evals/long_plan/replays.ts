/** Recorded replay directories, read once for the preview pages. */
import * as fs from "node:fs";
import * as path from "node:path";
import * as plan from "./plan";
import * as histories from "./history";
import * as tooltip from "./tooltip";
import type * as roadmap from "../../src/activity/roadmap";
import type { History } from "./history";
import { Writer } from "../../src/text";

export type Cohort = "long" | "routine" | "excerpt" | "probe";
export const cohorts: Cohort[] = ["long", "routine", "excerpt", "probe"];
export type Usage = { input: string; cached_input: string; output: string };
/** One model response; `correction` says why the response before it was rejected. */
export type Attempt = { raw: string | null; usage?: Usage; correction?: string };
export type Input = {
  assign_from?: number;
  assign_through?: number;
  events?: plan.Event[];
  support?: plan.Event[];
  correction?: string;
  rejected?: string;
};
export type Call = {
  through: number;
  input?: Input;
  raw: string | null;
  elapsed_ms?: number;
  attempts?: Attempt[];
  repairs?: string[];
  state?: plan.State;
  error?: string;
};
export type Check = { name: string; pass: boolean; detail: string };
/** An accepted update and the plan Corgi would show after it. */
export type Checkpoint = {
  call: Call & { state: plan.State };
  line: number;
  view: roadmap.Snapshot;
  running: boolean | null;
};
export type Replay = {
  key: string;
  directory: string;
  id: string;
  label: string;
  provider: string;
  cohort: Cohort;
  events: number;
  turns: number;
  ablation: string;
  model: string;
  source: string;
  history: History;
  checkpoints: Checkpoint[];
  errors: string[];
  checks: Check[];
};

const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const cohort = (value: unknown): Cohort | null =>
  typeof value === "string" && (cohorts as string[]).includes(value) ? (value as Cohort) : null;

/** Replays with at least one accepted update, longest first within each cohort. A later directory replaces an earlier one with the same name and case. */
export function load(directories: string[]): Replay[] {
  const replays = new Map<string, Replay>();
  for (const directory of directories) {
    const report = read(path.join(directory, "report.json"));
    const reviewPath = path.join(directory, "review.json"),
      review = fs.existsSync(reviewPath) ? read(reviewPath) : report;
    for (const result of report.cases) {
      const scored = review.cases.find((c: { id: string }) => c.id === result.id) ?? result;
      const accounted = path.join(directory, `${result.id}.accounted.history.json`);
      const history: History = read(
        fs.existsSync(accounted) ? accounted : path.join(directory, `${result.id}.history.json`),
      );
      const calls: Call[] = read(path.join(directory, `${result.id}.calls.json`));
      const activity = histories.activity(history);
      const checkpoints = calls
        .filter((c): c is Checkpoint["call"] => c.state !== undefined)
        .map(call => {
          const line = history.events.find(e => e.id === call.through)?.line ?? 0;
          return {
            call,
            line,
            view: plan.snapshot(call.state, history, line),
            running: histories.runningAt(activity, line),
          };
        });
      if (!checkpoints.length) continue;
      const key = `${path.basename(directory)}/${result.id}`;
      replays.set(key, {
        key,
        directory,
        id: result.id,
        label: scored.label ?? result.label ?? result.id,
        provider: history.provider,
        cohort: cohort(result.cohort) ?? (/[/\\]fixtures[/\\]/.test(history.source) ? "probe" : "excerpt"),
        events: history.events.length,
        turns: new Set(history.events.filter(e => e.kind === "user").map(e => e.turn)).size,
        ablation: report.ablation,
        model: report.model,
        source: result.source_hash,
        history,
        checkpoints,
        errors: scored.errors,
        checks: scored.checks,
      });
    }
  }
  return [...replays.values()].sort(
    (a, b) => cohorts.indexOf(a.cohort) - cohorts.indexOf(b.cohort) || b.events - a.events,
  );
}

export const failures = (replay: Replay) => [...replay.errors, ...replay.checks.filter(c => !c.pass).map(c => c.name)];

/** The agent tooltip at a checkpoint, as Corgi draws it into a cols×rows terminal. */
export function frame(replay: Replay, checkpoint: Checkpoint, cols: number, rows: number) {
  const out = new Writer();
  tooltip.draw(out, cols, rows, replay.label, replay.provider, checkpoint.view, checkpoint.running);
  return out.buffered();
}

/** A browser bundle that can sit inside an inline script element. */
export async function script(entrypoint: string) {
  const built = await Bun.build({ entrypoints: [entrypoint], target: "browser", minify: true });
  if (!built.success) throw Error(built.logs.join("\n"));
  return (await built.outputs[0].text()).replaceAll("</script", "<\\/script");
}
