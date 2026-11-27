#!/usr/bin/env bun
/** The replay browser as one self-contained page, for publishing as a claude.ai Artifact. */
import * as fs from "node:fs";
import * as path from "node:path";
import * as replays from "./replays";
import * as examples from "./examples";
import * as roadmap from "../../src/activity/roadmap";
import { compact } from "../../src/subagent_tooltip";
import type * as plan from "./plan";

export type Verdict = "good" | "bad";
/** A plan row as an example shows it. */
export type Row = Pick<plan.Node, "id" | "kind" | "title" | "subtitle" | "state"> & {
  bump: Omit<plan.Bump, "evidence"> | null;
};
/** Display figures, formatted as the tooltip formats them. */
export type Figures = { tokens: string; cached: string; tools: string };
export type Evidence = {
  id: number;
  turn: number;
  kind: plan.Event["kind"];
  text: string;
  owner: string | null;
  focus: boolean;
};
export type Rejected = { raw: string; reason: string };
/** What the page knows about an update before its replay's bundle is opened. */
export type Update = {
  through: number;
  running: boolean | null;
  /** Rows added or changed by this update. */
  changed: number;
  /** A problem marker appeared or changed. */
  problem: boolean;
  rejected: number;
  repairs: number;
};
/** The model call behind an update. */
export type Detail = {
  from: number;
  raw: string;
  repairs: string[];
  rejected: Rejected[];
  usage: Figures | null;
  elapsed_ms: number | null;
  events: Evidence[];
  /** "id · title" for each row that owns an event. */
  owners: Record<string, string>;
  support: number;
};
/** Distinct ANSI frames; `index["COLSxROWS"][update]` points into `list`. */
export type Frames = { list: string[]; index: Record<string, number[]> };
/** One replay's heavy data, gzipped separately and opened when the replay is shown. */
export type Bundle = { frames: Frames; details: Detail[] };
/** The rubric grader's verdict on the final plan, when judge.ts has run. */
export type Judge = {
  overall: number;
  summary: string;
  scores: Record<string, number>;
  reasons: Record<string, string>;
  bad: { id: string; fault: string; why: string }[];
  missing: string[];
};
export type Group = replays.Cohort | "reference";
export type Replay = {
  key: string;
  slug: string;
  run: string;
  id: string;
  label: string;
  provider: string;
  group: Group;
  events: number;
  turns: number;
  ablation: string;
  model: string;
  checks: number;
  findings: { name: string; detail: string }[];
  judge: Judge | null;
  updates: Update[];
};
export type Example = {
  replay: string;
  update: number;
  event: number;
  verdict: Verdict;
  category: string;
  title: string;
  tldr: string;
  note: string;
  row: Row | null;
};
export type Payload = {
  widths: number[];
  heights: number[];
  replays: Replay[];
  examples: Example[];
  /** Display names for example categories. */
  categories: Record<string, string>;
};

const widths = [40, 64, 88],
  heights = [18, 24, 34, 50],
  /** Characters of one evidence event kept on the page. */
  evidenceLimit = 600;

const max0 = (n: bigint) => (n < 0n ? 0n : n);
function clip(text: string, limit: number) {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.72),
    tail = limit - head;
  return `${text.slice(0, head)}\n[… ${text.length - limit} characters omitted …]\n${text.slice(-tail)}`;
}
/** Tokens are uncached input plus output, as the tooltip counts them. */
const figures = (counts: roadmap.Counts): Figures => ({
  tokens: compact(roadmap.total({ ...counts, input: String(max0(BigInt(counts.input) - BigInt(counts.cached))) })),
  cached: compact(BigInt(counts.cached)),
  tools: counts.tools === undefined ? "" : compact(BigInt(counts.tools)),
});
const row = (n: plan.Node): Row => ({
  id: n.id,
  kind: n.kind,
  title: n.title,
  subtitle: n.subtitle,
  state: n.state,
  bump: n.bump ? { kind: n.bump.kind, state: n.bump.state, detail: n.bump.detail } : null,
});

function judged(directory: string, id: string): Judge | null {
  const file = path.join(directory, `${id}.verdict.json`);
  if (!fs.existsSync(file)) return null;
  const v = JSON.parse(fs.readFileSync(file, "utf8"));
  return {
    overall: v.overall,
    summary: v.summary,
    scores: v.scores ?? {},
    reasons: v.reasons ?? {},
    bad: v.bad ?? [],
    missing: v.missing ?? [],
  };
}

function update(checkpoint: replays.Checkpoint, previous: replays.Checkpoint | undefined): Update {
  const before = new Map(previous?.view.nodes.map(n => [n.id, JSON.stringify(row(n))])),
    bumps = new Map(previous?.view.nodes.map(n => [n.id, JSON.stringify(n.bump ?? null)]));
  const call = checkpoint.call;
  return {
    through: call.through,
    running: checkpoint.running,
    changed: checkpoint.view.nodes.filter(n => before.get(n.id) !== JSON.stringify(row(n))).length,
    problem: checkpoint.view.nodes.some(n => n.bump && bumps.get(n.id) !== JSON.stringify(n.bump)),
    rejected: (call.input?.rejected ? 1 : 0) + Math.max(0, (call.attempts?.length ?? 0) - 1),
    repairs: call.repairs?.length ?? 0,
  };
}

function detail(checkpoint: replays.Checkpoint, previous: number): Detail {
  const { call, view } = checkpoint;
  const attempts = call.attempts ?? [],
    rejected: Rejected[] = [];
  if (call.input?.rejected) rejected.push({ raw: call.input.rejected, reason: clip(call.input.correction ?? "", 600) });
  for (let i = 0; i + 1 < attempts.length; i++)
    rejected.push({ raw: attempts[i].raw ?? "", reason: attempts[i + 1].correction ?? "Rejected" });
  const usage = attempts.reduce<roadmap.Counts | null>(
    (sum, a) =>
      a.usage
        ? roadmap.add(sum ?? roadmap.zero(), {
            input: a.usage.input,
            cached: a.usage.cached_input,
            output: a.usage.output,
          })
        : sum,
    null,
  );
  const span = (event: number) => call.state.spans.find(s => s.from <= event && event <= s.to);
  const events = (call.input?.events ?? []).map(e => ({
    id: e.id,
    turn: e.turn,
    kind: e.kind,
    // Raw reasoning stays out of published pages, as in view.ts.
    text:
      e.kind === "reasoning"
        ? `[Reasoning omitted from this page; ${e.text.length} characters]`
        : clip(e.text, evidenceLimit),
    owner: span(e.id)?.node ?? null,
    focus: span(e.id)?.focus === true && span(e.id)?.from === e.id,
  }));
  const owners: Record<string, string> = {};
  for (const e of events) {
    const node = e.owner === null ? undefined : view.nodes.find(n => n.id === e.owner);
    if (node) owners[node.id] = `${node.id} · ${node.title}`;
  }
  return {
    from: call.input?.assign_from ?? previous + 1,
    raw: call.raw ?? "",
    repairs: call.repairs ?? [],
    rejected,
    usage: usage && { ...figures(usage), tools: "" },
    elapsed_ms: call.elapsed_ms ?? null,
    events,
    owners,
    support: call.input?.support?.length ?? 0,
  };
}

/** Frames grouped by size, so neighbouring updates' near-identical frames compress together. */
function frames(replay: replays.Replay): Frames {
  const list: string[] = [],
    seen = new Map<string, number>(),
    index: Record<string, number[]> = {};
  for (const cols of widths)
    for (const rows of heights)
      index[`${cols}x${rows}`] = replay.checkpoints.map(c => {
        const ansi = replays.frame(replay, c, cols, rows);
        if (!seen.has(ansi)) seen.set(ansi, list.push(ansi) - 1);
        return seen.get(ansi)!;
      });
  return { list, index };
}

function slugs(keys: string[]) {
  const used = new Set<string>();
  return keys.map(key => {
    const base =
      key
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "replay";
    let slug = base;
    for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;
    used.add(slug);
    return slug;
  });
}

/** Example rows, as examples.ts writes them: `[{replay: "RUN/CASE", event?, node?, verdict, category?, title, tldr?, note}]`. */
function resolve(file: string, loaded: replays.Replay[]): Example[] {
  const list: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(list)) throw Error(`${file}: expected a JSON array of examples`);
  return list.map((value, index) => {
    const where = `${file}[${index}]`,
      entry = value as Record<string, unknown>;
    const replay = loaded.find(r => r.key === entry?.replay);
    if (!replay)
      throw Error(
        `${where}: unknown replay ${JSON.stringify(entry?.replay)}; expected one of ${loaded.map(r => r.key).join(", ")}`,
      );
    if (entry.verdict !== "good" && entry.verdict !== "bad") throw Error(`${where}: verdict must be "good" or "bad"`);
    if (typeof entry.title !== "string" || typeof entry.note !== "string")
      throw Error(`${where}: title and note must be strings`);
    for (const field of ["node", "category", "tldr"])
      if (entry[field] !== undefined && typeof entry[field] !== "string")
        throw Error(`${where}: ${field} must be a string`);
    if (entry.event !== undefined && !Number.isSafeInteger(entry.event))
      throw Error(`${where}: event must be an integer`);
    // The update whose batch covers the event; the last one without an event.
    const event = entry.event as number | undefined,
      found = event === undefined ? -1 : replay.checkpoints.findIndex(c => c.call.through >= event),
      update = found < 0 ? replay.checkpoints.length - 1 : found,
      checkpoint = replay.checkpoints[update];
    const node = entry.node === undefined ? null : checkpoint.view.nodes.find(n => n.id === entry.node);
    if (node === undefined)
      console.warn(`${where}: ${entry.node} is not in the plan at event ${checkpoint.call.through}; no row shown`);
    return {
      replay: replay.key,
      update,
      event: checkpoint.call.through,
      verdict: entry.verdict,
      category: (entry.category as string | undefined) ?? "",
      title: entry.title,
      tldr: (entry.tldr as string | undefined) ?? examples.sentence(entry.note),
      note: entry.note,
      row: node ? row(node) : null,
    };
  });
}

/** Keep the page ASCII so it reads the same under any declared charset. */
const ascii = (text: string) =>
  text.replace(/[^\x00-\x7f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
const packed = (value: unknown) => Buffer.from(Bun.gzipSync(JSON.stringify(value))).toString("base64");

async function main() {
  const args = process.argv.slice(2);
  const option = (name: string) => {
    const at = args.indexOf(name);
    return at < 0 ? null : args.splice(at, 2)[1];
  };
  const examplesFile = option("--examples"),
    out = option("--out") ?? ".lavish/long-plan-artifact.html";
  if (!args.length || args.some(a => a.startsWith("--")))
    throw Error("Usage: bun evals/long_plan/artifact.ts [--examples FILE.json] [--out FILE.html] RUN_DIRECTORY...");
  const loaded = replays.load(args);
  if (!loaded.length) throw Error("Provide completed replay directories");
  const slug = slugs(loaded.map(r => r.key));
  const pages: Replay[] = loaded.map((r, i) => ({
    key: r.key,
    slug: slug[i],
    run: path.basename(r.directory),
    id: r.id,
    label: r.label,
    provider: r.provider,
    group: r.ablation === "reference" ? "reference" : r.cohort,
    events: r.events,
    turns: r.turns,
    ablation: r.ablation,
    model: r.model,
    checks: r.checks.length,
    findings: [
      ...r.errors.map(e => ({ name: e, detail: "" })),
      ...r.checks.filter(c => !c.pass).map(c => ({ name: c.name, detail: c.detail })),
    ],
    judge: judged(r.directory, r.id),
    updates: r.checkpoints.map((c, n) => update(c, r.checkpoints[n - 1])),
  }));
  const payload: Payload = {
    widths,
    heights,
    replays: pages,
    examples: examplesFile ? resolve(examplesFile, loaded) : [],
    categories: examples.categories,
  };
  const bundles = loaded.map((r, i) => {
    const bundle: Bundle = {
      frames: frames(r),
      details: r.checkpoints.map((c, n) => detail(c, n ? r.checkpoints[n - 1].call.through : 0)),
    };
    return `<script type="application/octet-stream" id="bundle-${slug[i]}">${packed(bundle)}</script>`;
  });
  const template = fs.readFileSync(path.join(import.meta.dir, "artifact.html"), "utf8"),
    js = ascii(await replays.script(path.join(import.meta.dir, "artifact_browser.ts")));
  const html = template
    .replace("<!--DATA-->", () => packed(payload))
    .replace("<!--BUNDLES-->", () => bundles.join("\n"))
    .replace("<!--SCRIPT-->", () => js);
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, html);
  const count = (v: Verdict) => payload.examples.filter(e => e.verdict === v).length;
  console.log(
    `${pages.length} replays, ${pages.reduce((n, r) => n + r.updates.length, 0)} updates, ${count("good")} good and ${count("bad")} bad examples → ${out} (${(html.length / 1e6).toFixed(2)} MB)`,
  );
}

if (import.meta.main) await main();
