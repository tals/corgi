/** What a run tells the live view, next to its plain progress lines. */
import type { HarnessKind } from "./config";
import type { Usage } from "./harness_stream";
import type { Estimate } from "./timings";

export type Stage = "fetch" | "rebase" | "merge" | "verify" | "after-build" | "push";
export type Upstream = { name: string; tip: string; newCommits: number };
export type LiveEvent =
  | {
      t: "begin";
      command: "rebuild" | "rebase" | "continue";
      branch: string;
      upstream: Upstream;
      stages: Stage[];
      items: Partial<Record<Stage, string[]>>;
      estimate: Estimate;
      /** Item ids (patch names) to the pages they link to. */
      links: Record<string, string>;
      /** Which agent the harness runs, for its name in the view; null without a kind. */
      harness: HarnessKind | null;
      /** The median harness call in earlier runs: a call that starts grows the estimate by it. */
      harnessMedianMs: number | null;
      /** Active time before this invocation, for a continued run. */
      elapsedMs: number;
    }
  | {
      t: "stage";
      stage: Stage;
      state: "start" | "done";
      summary?: string;
      /** The upstream as fetched, on the fetch's `done`: `begin` only knows the tip from before. */
      upstream?: Upstream;
      /** The stage's time when it is known rather than clocked (a replayed run). */
      ms?: number;
      /** Item ids to the pages they link to, beyond `begin`'s: the step logs once the report has a directory. */
      links?: Record<string, string>;
    }
  | {
      t: "item";
      stage: Stage;
      id: string;
      state: "start" | "done" | "failed" | "skipped";
      outcome?: string;
      /** Why it was skipped or failed. */
      detail?: string;
      /** As for `stage`. */
      ms?: number;
    }
  | { t: "retry"; stage: Stage; id: string; why: "flaky" | "harness" | "upstream"; detail: string }
  | {
      t: "harness";
      state: "start" | "activity" | "end";
      stage: Stage;
      id: string;
      attempt: number;
      limit: number;
      files?: string[];
      text?: string;
      usage?: Usage | null;
      ok?: boolean;
      reason?: string;
    }
  | { t: "log"; text: string }
  | { t: "estimate"; estimate: Estimate }
  | {
      t: "end";
      ok: boolean;
      code: number;
      headline: string;
      lines: string[];
      report: string | null;
      /** The run's active time at its end, for the finished card's comparison with the last run. */
      activeMs?: number;
      /** What a finished run's card shows of `lines`; absent, it shows them all. */
      brief?: string[];
      handoffs?: number;
    };
export type Sink = (event: LiveEvent) => void;
export const signal = (sink: Sink | undefined, event: LiveEvent): void => sink?.(event);

/** The `end` of a command's outcome: its first line without the `custom-build: ` prefix leads. */
export function end(
  outcome: { code: number; lines: string[]; brief?: string[]; handoffs?: number },
  report: string | null,
  activeMs?: number,
): LiveEvent {
  const [first = "", ...rest] = outcome.lines;
  return {
    t: "end",
    ok: outcome.code === 0,
    code: outcome.code,
    headline: first.replace(/^custom-build:? /, ""),
    lines: rest,
    report,
    ...(activeMs === undefined ? {} : { activeMs }),
    ...(outcome.brief ? { brief: outcome.brief } : {}),
    ...(outcome.handoffs ? { handoffs: outcome.handoffs } : {}),
  };
}

/** An `onActivity` for a harness call that sends its lines as `activity` events;
 * undefined without a sink. It never throws: a throw would stop the harness's output drain. */
export function activity(
  sink: Sink | undefined,
  call: Omit<Extract<LiveEvent, { t: "harness" }>, "t" | "state">,
): ((line: string) => void) | undefined {
  if (!sink) return undefined;
  return line => {
    try {
      sink({ t: "harness", state: "activity", ...call, text: line });
    } catch {}
  };
}
