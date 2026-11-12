/** The live view of a run as lines of text: pure functions of its state, so the
 * renderer only decides when to draw. Every line fits the width it is given:
 * the frame wraps long text a few lines deep and cuts the rest with `…`, a card
 * wraps the lines the plain output prints. */
import { pathToFileURL } from "node:url";
import type { Stage } from "./live_events";
import type { ItemView, LiveState, StageView, Why } from "./live_state";
import { tokens } from "./report";
import * as term from "./term";
import type { HistoryRun } from "./timings";

/** A piece of a line: its plain text and how it is drawn. */
type Seg = {
  text: string;
  tone?: term.Tone;
  hex?: string;
  /** A gradient over the piece, from and to. */
  grad?: [string, string];
  dim?: boolean;
  url?: string | null;
};
type Line = Seg[];

const violet = "#bb9af7",
  amber = "#e0af68",
  red = "#f7768e",
  green = "#9ece6a",
  gray = "#565f89",
  bandColor = "#292e42";

const spinnerGlyphs = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
/** A braille spinner: one glyph per 80 ms. */
export const spinner = (nowMs: number): string => {
  const at = Math.floor((Number.isFinite(nowMs) ? nowMs : 0) / 80) % spinnerGlyphs.length;
  return spinnerGlyphs[(at + spinnerGlyphs.length) % spinnerGlyphs.length];
};
const turning = "◐◓◑◒";
const turn = (nowMs: number) => turning[Math.abs(Math.floor((Number.isFinite(nowMs) ? nowMs : 0) / 200)) % 4];
const eighths = "▏▎▍▌▋▊▉";

// Text from outside (step output, harness text) may hold escapes and control
// characters, which would draw or count wrong.
const escapes = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b./g;
const controls = /[\x00-\x1f\x7f]/g;
const clean = (text: string) => text.replace(escapes, "").replace(controls, " ");

const graphemes = (text: string) => [...new Intl.Segmenter().segment(text)].map(s => s.segment);
const widthOf = (line: Line) => line.reduce((n, seg) => n + term.width(seg.text), 0);

/** `m:ss`, or `h:mm:ss` from an hour. */
export function clock(ms: number): string {
  const t = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000)),
    h = Math.floor(t / 3600),
    m = Math.floor((t % 3600) / 60),
    s = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}
/** `5m 18s`, `42s` or `1h 05m`, for the time left. */
function span(ms: number): string {
  const t = Math.max(0, Math.round((Number.isFinite(ms) ? ms : 0) / 1000)),
    h = Math.floor(t / 3600),
    m = Math.floor((t % 3600) / 60);
  if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
  return m ? `${m}m ${t % 60}s` : `${t}s`;
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The line cut to `room` cells, ending in `…` when cut. */
function cut(line: Line, room: number): Line {
  const parts = line.map(seg => ({ ...seg, text: clean(seg.text) }));
  if (room <= 0) return [];
  if (widthOf(parts) <= room) return parts;
  const out: Line = [];
  let used = 0;
  for (const seg of parts) {
    const w = term.width(seg.text);
    if (used + w <= room - 1) {
      out.push(seg);
      used += w;
      continue;
    }
    let text = "";
    for (const g of graphemes(seg.text)) {
      if (used + term.width(text + g) > room - 1) break;
      text += g;
    }
    out.push({ ...seg, text: `${text}…` });
    break;
  }
  return out;
}
/** The line in as many lines of `room` cells as it takes (`rest` cells from the
 * second), broken after a space or a slash where there is one, the later lines
 * indented. */
function wrap(line: Line, room: number, indent = 4, rest = room): Line[] {
  const parts = line.map(seg => ({ ...seg, text: clean(seg.text) }));
  if (room <= 0) return [];
  if (widthOf(parts) <= room) return [parts];
  const lead = Math.min(indent, Math.max(0, room - 2)),
    chars = parts.flatMap(seg => graphemes(seg.text).map(g => ({ seg, g, w: term.width(g) }))),
    lines: Line[] = [];
  let i = 0;
  while (i < chars.length) {
    const start = lines.length ? lead : 0,
      limit = lines.length ? Math.max(1, rest) : room;
    let used = start,
      end = i,
      space = -1;
    while (end < chars.length && used + chars[end].w <= limit) {
      // After a slash only inside a path, not after the one that starts it.
      if (end > i && (chars[end].g === " " || (chars[end].g === "/" && chars[end - 1].g !== " "))) space = end;
      used += chars[end].w;
      end++;
    }
    // A character wider than the room can't be shown at all.
    if (end === i) {
      i++;
      continue;
    }
    if (end < chars.length && space > i) end = space + 1;
    const taken = chars.slice(i, end).map(c => ({ ...c.seg, text: c.g }));
    while (taken.length && taken[taken.length - 1].text === " ") taken.pop();
    lines.push(merged([...(start ? [{ text: " ".repeat(start) }] : []), ...taken]));
    i = end;
    while (i < chars.length && chars[i].g === " ") i++;
  }
  return lines;
}
const sameLook = (a: Seg, b: Seg) =>
  a.tone === b.tone && a.hex === b.hex && a.grad === b.grad && a.dim === b.dim && a.url === b.url;
/** The line with neighbors that look the same joined. */
const merged = (line: Line): Line =>
  line.reduce<Line>((out, seg) => {
    const prev = out[out.length - 1];
    if (prev && sameLook(prev, seg)) out[out.length - 1] = { ...prev, text: prev.text + seg.text };
    else out.push(seg);
    return out;
  }, []);

function paintSeg(seg: Seg, color: boolean): string {
  const { text } = seg;
  if (!color || !text) return text;
  let out = seg.grad
    ? term.gradient(text, seg.grad[0], seg.grad[1], true)
    : seg.hex
      ? term.rgb(text, seg.hex, true)
      : term.paint(text, seg.tone, true);
  if (seg.dim) out = term.paint(out, "dim", true);
  return term.link(out, seg.url, true);
}
/** The line as text: cut to the width, colored, and on a band when `band`. */
function draw(line: Line, width: number, color: boolean, band = false): string {
  const text = cut(line, width)
    .map(seg => paintSeg(seg, color))
    .join("");
  if (!color || !band || !text) return text;
  const [r, g, b] = [1, 3, 5].map(i => parseInt(bandColor.slice(i, i + 2), 16)),
    bg = `\x1b[48;2;${r};${g};${b}m`;
  return `${bg}${text.replaceAll("\x1b[0m", `\x1b[0m${bg}`)}\x1b[0m`;
}
const drawn = (lines: Line[], color: boolean) => lines.map(line => line.map(seg => paintSeg(seg, color)).join(""));

/** The line with `right` at `edge`, the left cut to make room. */
function spread(left: Line, right: Line, edge: number): Line {
  const rw = widthOf(right);
  if (!rw) return left;
  const l = cut(left, Math.max(0, edge - rw - 2));
  return [...l, { text: " ".repeat(Math.max(2, edge - widthOf(l) - rw)) }, ...right];
}

const harnessName = (s: LiveState) => s.harnessKind ?? "harness";
const elapsed = (s: LiveState, nowMs: number) =>
  s.clock.activeMs + (s.clock.sinceMs === null ? 0 : Math.max(0, nowMs - s.clock.sinceMs));
const stageMs = (st: StageView, nowMs: number) =>
  st.ms + (st.startedMs === null ? 0 : Math.max(0, nowMs - st.startedMs));
/** The stage a timing key belongs to: `merge:a` to merge, `step:test` to verify. */
function stageOfKey(key: string): Stage | null {
  const head = key.split(":")[0];
  if (head === "step") return "verify";
  return head === "fetch" || head === "rebase" || head === "merge" || head === "after-build" || head === "push"
    ? head
    : null;
}
const colorOf = (stage: Stage, at = 0) => {
  const g = term.stageGradient[stage];
  return g ? term.mix(g[0], g[1], at) : term.stageColor[stage];
};
const stageLook = (stage: Stage): Seg => {
  const g = term.stageGradient[stage];
  return g ? { text: "", grad: g } : { text: "", hex: term.stageColor[stage] };
};

/** Per stage, the time the last run took. */
function lastStages(last: HistoryRun | null): Partial<Record<Stage, number>> {
  const out: Partial<Record<Stage, number>> = {};
  for (const [key, ms] of Object.entries(last?.items ?? {})) {
    const stage = stageOfKey(key);
    if (stage) out[stage] = (out[stage] ?? 0) + ms;
  }
  return out;
}
/** The timing key prefix of a stage's items. */
const itemKey: Partial<Record<Stage, string>> = { rebase: "rebase:", merge: "merge:", verify: "step:" };

/** Each stage's stretch of the timeline: its time so far and what is left of it. */
type Stretch = { stage: Stage; doneMs: number; leftMs: number };
function stretches(s: LiveState, nowMs: number): { all: Stretch[]; total: number | null; elapsed: number } {
  const time = elapsed(s, nowMs),
    total = s.estimate.totalMs,
    last = s.estimate.last,
    lastMs = lastStages(last);
  // What is left of a stage, by the last run: a running stage with items by
  // the items it has not finished, so a stage running late still has some left.
  const weight = (st: StageView, doneMs: number) => {
    const prefix = itemKey[st.name],
      items = s.items[st.name] ?? [];
    if (st.state === "done") return 0;
    if (st.state === "pending" || !prefix || !items.length || !last)
      return Math.max(0, (lastMs[st.name] ?? 0) - doneMs);
    const known = Object.entries(last.items)
        .filter(([key]) => key.startsWith(prefix))
        .map(([, ms]) => ms),
      typical = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 0;
    return items
      .filter(it => it.state === "pending" || it.state === "running")
      .reduce((n, it) => n + (last.items[`${prefix}${it.id}`] ?? typical), 0);
  };
  const all = s.stages.map(st => {
      const doneMs = st.state === "pending" ? 0 : stageMs(st, nowMs);
      return { stage: st.name, doneMs, leftMs: 0, weight: weight(st, doneMs), open: st.state !== "done" };
    }),
    left = total === null ? 0 : Math.max(0, total - time),
    weights = all.reduce((n, x) => n + x.weight, 0);
  if (weights > 0) for (const x of all) x.leftMs = (left * x.weight) / weights;
  else {
    const first = all.find(x => x.open);
    if (first) first.leftMs = left;
  }
  return { all: all.map(({ stage, doneMs, leftMs }) => ({ stage, doneMs, leftMs })), total, elapsed: time };
}

const stageOrder: Stage[] = ["fetch", "rebase", "merge", "verify", "after-build", "push"];
const barCells = (width: number, rights: number) => Math.max(4, Math.min(width - 22, width - 8 - rights));

/** The timeline: the run so far (`now`), the last run under it, and the stage names. */
export function timeline(
  s: LiveState,
  width: number,
  color: boolean,
  nowMs: number = s.clock.sinceMs ?? 0,
): { now: string; last: string | null; legend: string } {
  const { all, total, elapsed: time } = stretches(s, nowMs),
    done = all.reduce((n, x) => n + x.doneMs, 0),
    planned = all.reduce((n, x) => n + x.doneMs + x.leftMs, 0),
    scale = Math.max(total ?? 0, time, done, planned),
    nowRight: Line =
      total === null
        ? [{ text: clock(time) }]
        : [{ text: `${clock(time)} / ` }, { text: `~${clock(Math.max(total, time))}`, dim: true }],
    last = s.estimate.last,
    ahead = s.estimate.aheadMs,
    lastRight: Line = [];
  if (ahead !== null)
    lastRight.push(
      ahead >= 0 ? { text: `▲ ${clock(ahead)} ahead`, hex: green } : { text: `▼ ${clock(-ahead)} behind`, hex: amber },
    );
  if (total !== null) {
    if (lastRight.length) lastRight.push({ text: " · ", dim: true });
    lastRight.push({ text: `~${span(Math.max(0, total - time))} left`, dim: true });
  }
  const cells = barCells(width, Math.max(widthOf(nowRight), last ? widthOf(lastRight) : 0)),
    unit = scale > 0 ? scale / cells : 0,
    starts: number[] = [];
  let at = 0;
  for (const x of all) {
    starts.push(at);
    at += x.doneMs + x.leftMs;
  }
  // The stage at a point of the timeline, and how far into it the point is.
  const stageAt = (ms: number): [Stage | null, number] => {
    for (let i = 0; i < all.length; i++) {
      const length = all[i].doneMs + all[i].leftMs;
      if (ms < starts[i] + length || i === all.length - 1)
        return [all[i].stage, length > 0 ? Math.min(1, (ms - starts[i]) / length) : 0];
    }
    return [null, 0];
  };
  const cursor = unit > 0 ? done / unit : 0,
    bar: Line = [];
  for (let c = 0; c < cells; c++) {
    const [stage, into] = unit > 0 ? stageAt((c + 0.5) * unit) : [null, 0],
      hex = stage ? colorOf(stage, into) : gray,
      fill = Math.min(1, Math.max(0, cursor - c)),
      part = Math.round(fill * 8);
    if (part >= 8) bar.push({ text: "█", hex });
    else if (part > 0) bar.push({ text: eighths[part - 1], hex });
    else bar.push({ text: "░", hex, dim: true });
  }
  const now = draw([{ text: " now  ", dim: true }, ...bar, { text: "  " }, ...nowRight], width, color);
  let lastLine: string | null = null;
  if (last) {
    const lastMs = lastStages(last),
      order = stageOrder.filter(st => lastMs[st]),
      lastBar: Line = [];
    let from = 0;
    for (const stage of order) {
      const length = lastMs[stage] ?? 0,
        first = unit > 0 ? Math.round(from / unit) : 0,
        end = unit > 0 ? Math.round((from + length) / unit) : 0;
      for (let c = first; c < Math.min(end, cells); c++)
        lastBar.push({ text: "▔", hex: colorOf(stage, (c - first) / Math.max(1, end - first)), dim: true });
      from += length;
    }
    const pad = cells - widthOf(lastBar);
    lastLine = draw(
      [{ text: " last ", dim: true }, ...lastBar, { text: " ".repeat(Math.max(0, pad) + 2) }, ...lastRight],
      width,
      color,
    );
  }
  // Each stage's name under where it starts, a space apart. Names that would
  // run past the edge (short stages at the end) move left instead of being cut.
  const at6 = all.map((_, i) => 6 + (unit > 0 ? Math.round(starts[i] / unit) : 0)),
    pos: number[] = [];
  all.forEach((x, i) => pos.push(i ? Math.max(at6[i], pos[i - 1] + all[i - 1].stage.length + 1) : at6[i]));
  for (let i = all.length - 1; i >= 0; i--) {
    const limit = (i === all.length - 1 ? width : pos[i + 1] - 1) - all[i].stage.length;
    pos[i] = Math.max(0, Math.min(pos[i], limit));
  }
  for (let i = 1; i < all.length; i++) pos[i] = Math.max(pos[i], pos[i - 1] + all[i - 1].stage.length + 1);
  const legend: Line = [];
  let col = 0;
  all.forEach((x, i) => {
    legend.push({ text: " ".repeat(pos[i] - col) }, { ...stageLook(x.stage), text: x.stage, dim: true });
    col = pos[i] + x.stage.length;
  });
  return { now, last: lastLine, legend: draw(legend, width, color) };
}

/** What a finished item's line says after its name. */
function outcome(it: ItemView): Line {
  const tok = it.tokens ? [{ text: ` · ${tokens(it.tokens.input + it.tokens.output)} tok`, dim: true }] : [],
    tries = it.tries.length > 1 ? [{ text: ` · ${it.tries.length} tries`, dim: true }] : [],
    detail = it.detail ? `: ${it.detail}` : "",
    files = it.files.length ? [{ text: ` ${plural(it.files.length, "file")}` }] : [],
    agent = (what: string): Line => [{ text: "✦", hex: violet }, { text: ` ${what}` }, ...files, ...tries, ...tok];
  switch (it.outcome) {
    case "merged":
    case "rebased":
    case "passed":
      return [{ text: it.outcome }, ...tok];
    case "replayed":
      return [{ text: "replayed (rerere)" }];
    case "agent-resolved":
      return agent("agent-resolved");
    case "fixed":
      return agent("fixed by the agent");
    case "user-resolved":
      return [{ text: "resolved by you" }];
    case "skipped-merged":
      return [{ text: "skipped: merged upstream", dim: true }];
    case "already-contained":
      return [{ text: "skipped: already contained", dim: true }];
    case "left-alone":
      return [{ text: `left alone${detail}`, dim: true }];
    case "not-rebased":
      return [{ text: `not rebased, kept as it was${detail}`, hex: amber }];
    case "flaky":
      return [{ text: "passed on retry: may be flaky", hex: amber }];
    case "stopped":
    case "failed":
      return [{ text: `${it.outcome}${detail}`, hex: red }, ...tries, ...tok];
    default:
      return [{ text: `${it.outcome ?? it.state}${detail}`, dim: it.state === "skipped" }, ...tok];
  }
}
/** A running item's line after its name: the harness call, or its clock. */
function activeItem(s: LiveState, stage: Stage, it: ItemView, nowMs: number): Line {
  const rejected = it.tries.findLast(t => !t.ok)?.reason ?? it.retries[it.retries.length - 1]?.detail,
    why: Line = rejected ? [{ text: ` · ↻ ${rejected}`, hex: amber }] : [];
  if (it.harness) {
    const h = it.harness,
      what = stage === "verify" ? `fixing ${it.id}` : `resolving ${h.files.join(", ") || "the conflict"}`;
    return [
      { text: "✦", hex: violet },
      { text: ` ${harnessName(s)} ${what} · try ${h.attempt}/${h.limit} · ${clock(nowMs - h.startedMs)}` },
      ...why,
    ];
  }
  return [{ text: it.startedMs === null ? "" : clock(nowMs - it.startedMs), dim: true }, ...why];
}
const itemMark = (stage: Stage, it: ItemView, nowMs: number): Seg => {
  switch (it.state) {
    case "running":
      return { text: spinner(nowMs), hex: colorOf(stage) };
    case "done":
      return { text: "✓", hex: green };
    case "skipped":
      return { text: "↷", dim: true };
    case "failed":
      return { text: "✗", hex: red };
    case "pending":
      return { text: "·", dim: true };
  }
};
const finishedItem = (it: ItemView) => it.state === "done" || it.state === "skipped" || it.state === "failed";

/** The items to show of a running stage's items, `heights` lines each, in
 * `rows` lines: all that fit, else a window around the running one with a
 * line for those before and after it. The running item always shows. */
function windowOf(items: ItemView[], heights: number[], rows: number): { from: number; to: number } {
  const n = items.length,
    lines = (from: number, to: number) =>
      heights.slice(from, to).reduce((a, b) => a + b, 0) + (from > 0 ? 1 : 0) + (to < n ? 1 : 0);
  if (lines(0, n) <= rows) return { from: 0, to: n };
  let active = items.findIndex(it => it.state === "running");
  if (active < 0) active = items.findIndex(it => it.state === "pending");
  if (active < 0) active = n - 1;
  // Grow around the running item, one after it, then one before, while it fits.
  let from = active,
    to = active + 1,
    grew = true;
  while (grew) {
    grew = false;
    if (to < n && lines(from, to + 1) <= rows) {
      to++;
      grew = true;
    }
    if (from > 0 && lines(from - 1, to) <= rows) {
      from--;
      grew = true;
    }
  }
  return { from, to };
}

/** Lines a stage's list or an item's text may wrap to in the frame. */
const wrapRows = 3;
/** `line` in lines of `room` cells (`rest` from the second), at most `max`,
 * the last cut with `…` when there is more. */
function wrapUpTo(line: Line, room: number, rest = room, max = wrapRows): Line[] {
  const lines = wrap(line, Math.max(1, room), 0, Math.max(1, rest));
  if (lines.length <= max) return lines;
  const last = lines[max - 1],
    limit = Math.max(1, max > 1 ? rest : room),
    more = { ...last[last.length - 1], text: "…", url: null };
  return [...lines.slice(0, max - 1), widthOf(last) < limit ? [...last, more] : cut([...last, more], limit)];
}
/** `parts` joined by ` · ` in lines of `room` cells (`rest` from the second),
 * broken between parts, at most `wrapRows`: the last ends in `+N more` when
 * there is more. */
function listLines(parts: string[], room: number, rest = room): string[] {
  const lines: string[] = [];
  let shown = 0;
  for (const part of parts) {
    const at = lines.length - 1;
    if (at >= 0 && term.width(lines[at]) + 3 + term.width(part) <= (at ? rest : room)) lines[at] += ` · ${part}`;
    else if (lines.length < wrapRows) lines.push(part);
    else break;
    shown++;
  }
  if (shown < parts.length) {
    // Make room for the count on the last line, giving up its last parts.
    const at = lines.length - 1,
      limit = at ? rest : room;
    let left = parts.length - shown;
    while (term.width(`${lines[at]} · +${left} more`) > limit && lines[at].includes(" · ")) {
      lines[at] = lines[at].slice(0, lines[at].lastIndexOf(" · "));
      left++;
    }
    lines[at] += ` · +${left} more`;
  }
  return lines;
}
const foldMarks: [ItemView["state"], Seg][] = [
  ["done", { text: "✓", hex: green }],
  ["skipped", { text: "↷", dim: true }],
  ["failed", { text: "✗", hex: red }],
  ["pending", { text: "·", dim: true }],
];
/** One line for items left out of the window: `✓ 4 done`, `· 3 pending`. */
function folded(items: ItemView[]): Line {
  const line: Line = [{ text: "     " }];
  for (const [state, mark] of foldMarks) {
    const n = items.filter(it => it.state === state).length;
    if (n) line.push({ text: line.length > 1 ? "  " : "" }, mark, { text: ` ${n} ${state}`, dim: state === "pending" });
  }
  return line;
}

/** Each stage's lines in the checklist: its mark, name and summary, list or
 * progress, a long summary or list wrapped under itself. */
function stageHeads(s: LiveState, o: { width: number; nowMs: number; color: boolean }): string[][] {
  const { width, nowMs, color } = o,
    edge = Math.min(width, 72),
    nameCol = Math.max(0, ...s.stages.map(st => st.name.length)) + 3,
    bodyCol = 3 + nameCol,
    plan = stretches(s, nowMs).all;
  return s.stages.map(st => {
    const items = s.items[st.name] ?? [],
      failed = items.some(it => it.state === "failed"),
      mark: Seg = failed
        ? { text: "✗", hex: red }
        : st.state === "done"
          ? { text: "✓", hex: green }
          : st.state === "running"
            ? { text: turn(nowMs), hex: colorOf(st.name) }
            : { text: "·", dim: true },
      name: Seg = { ...stageLook(st.name), text: st.name.padEnd(nameCol), dim: st.state === "pending" };
    let body: Line[] = [[]],
      right: Line = [];
    if (st.state === "running") {
      const bar: Line = [];
      if (items.length) {
        const finished = items.filter(finishedItem).length,
          active = items.findIndex(it => it.state === "running"),
          filled = Math.round((finished / items.length) * 16);
        for (let c = 0; c < 16; c++)
          bar.push(c < filled ? { text: "█", hex: colorOf(st.name, c / 15) } : { text: "░", dim: true });
        bar.push({ text: ` ${active >= 0 ? active + 1 : finished}/${items.length}` });
      } else bar.push({ text: spinner(nowMs), hex: colorOf(st.name) });
      body = [bar];
      right = [{ text: clock(stageMs(st, nowMs)), dim: true }];
    } else {
      if (st.state === "done") right = [{ text: clock(st.ms), dim: true }];
      else {
        const left = plan.find(x => x.stage === st.name)?.leftMs ?? 0;
        if (left > 0) right = [{ text: `~${clock(left)}`, dim: true }];
      }
      // A long summary or list wraps under itself: its first line clear of
      // the time on the right, the others as wide as the terminal.
      const room = (right.length ? edge - widthOf(right) - 2 : width) - bodyCol,
        rest = width - bodyCol;
      if (st.state === "done") body = wrapUpTo([{ text: st.summary ?? "" }], room, rest);
      else
        body = listLines(
          items.map(it => it.id),
          room,
          rest,
        ).map(text => [{ text, dim: true }]);
      if (!body.length) body = [[]];
    }
    return [
      draw(spread([{ text: " " }, mark, { text: " " }, name, ...body[0]], right, edge), width, color),
      ...body.slice(1).map(line => draw([{ text: " ".repeat(bodyCol) }, ...line], width, color)),
    ];
  });
}

/** The checklist: each stage's `heads`, the running stage's items under it,
 * in at most `itemRows` lines. An item's text wraps under itself. */
function checklist(
  s: LiveState,
  o: { width: number; nowMs: number; color: boolean; itemRows: number; heads: string[][] },
): string[] {
  const { width, nowMs, color } = o,
    lines: string[] = [];
  s.stages.forEach((st, i) => {
    lines.push(...o.heads[i]);
    if (st.state !== "running") return;
    const items = s.items[st.name] ?? [],
      idCol = Math.min(Math.max(0, ...items.map(it => term.width(it.id))) + 3, Math.max(8, Math.floor(width * 0.4))),
      restCol = 7 + idCol;
    const itemLines = items.map(it => {
      const id = cut([{ text: it.id }], idCol - 1)[0]?.text ?? "",
        band = it.state === "running",
        idSeg: Seg = { text: id, url: s.links[it.id], dim: it.state === "pending", tone: band ? "bold" : null },
        lead: Line = [
          { text: "     " },
          itemMark(st.name, it, nowMs),
          { text: " " },
          idSeg,
          { text: " ".repeat(Math.max(1, idCol - term.width(id))) },
        ];
      if (it.state === "pending") return [draw(lead.slice(0, 4), width, color)];
      const rest = wrapUpTo(it.state === "running" ? activeItem(s, st.name, it, nowMs) : outcome(it), width - restCol);
      return [
        draw([...lead, ...(rest[0] ?? [])], width, color, band),
        ...rest.slice(1).map(line => draw([{ text: " ".repeat(restCol) }, ...line], width, color, band)),
      ];
    });
    const { from, to } = windowOf(
        items,
        itemLines.map(l => l.length),
        o.itemRows,
      ),
      folds = (from > 0 ? 1 : 0) + (to < items.length ? 1 : 0),
      shown = itemLines.slice(from, to);
    // A window of the running item alone that is still too tall loses that item's last lines.
    if (shown.length === 1) shown[0] = shown[0].slice(0, Math.max(1, o.itemRows - folds));
    if (from > 0) lines.push(draw(folded(items.slice(0, from)), width, color));
    for (const l of shown) lines.push(...l);
    if (to < items.length) lines.push(draw(folded(items.slice(to)), width, color));
  });
  return lines;
}

const whyWords: Record<Why, string> = { flaky: "flaky", harness: "rejected", upstream: "on plain upstream" };
/** The footer: harness calls and tokens, retries. */
function footer(s: LiveState, width: number, color: boolean): string[] {
  const h = s.harness,
    calls: Line = h.calls
      ? [{ text: plural(h.calls, "call") }, ...(h.running ? [{ text: ` · ${h.running} running` }] : [])]
      : [{ text: "no calls yet", dim: true }],
    ended = h.calls - h.running;
  if (s.harnessKind && ended > 0) {
    const known = ended > h.unknown,
      unknown = h.unknown ? "+?" : "";
    calls.push(
      known
        ? {
            text: ` · ${tokens(h.input + h.output)}${unknown} tokens (in ${tokens(h.input)} / out ${tokens(h.output)})`,
          }
        : { text: " · ? tokens" },
    );
  }
  const by = (Object.keys(whyWords) as Why[]).filter(why => s.retriesBy[why]),
    retries: Line = s.retries
      ? [
          { text: String(s.retries), hex: amber },
          ...by.map(why => ({ text: ` · ${s.retriesBy[why]} ${whyWords[why]}`, dim: true })),
        ]
      : [{ text: "none yet", dim: true }];
  return [
    draw([{ text: " " }, { text: "✦", hex: violet }, { text: " harness  " }, ...calls], width, color),
    draw([{ text: " " }, { text: "↻", hex: amber }, { text: " retries  " }, ...retries], width, color),
  ];
}

/** The header: command, branch, upstream and its new commits. */
function header(s: LiveState, width: number, color: boolean): string {
  const line: Line = [{ text: "custom-build", grad: term.titleGradient }];
  if (s.command) line.push({ text: ` ${s.command}`, tone: "bold" });
  if (s.branch) line.push({ text: " · ", dim: true }, { text: s.branch });
  if (s.upstream.name) {
    line.push({ text: " · ", dim: true }, { text: `${s.upstream.name} @ ` });
    line.push({ text: s.upstream.tip.slice(0, 7), tone: "cyan" });
    if (s.upstream.newCommits > 0) line.push({ text: ` (+${s.upstream.newCommits})`, dim: true });
  }
  return draw(line, width, color);
}

/** The live region while the run goes on, in at most `rows` lines when given.
 * Header, timeline, stage lines and footer always show; the blank lines, then
 * the activity line give way before a running stage's items fold up. */
export function frame(
  s: LiveState,
  o: { width: number; nowMs: number; color: boolean; verbose: boolean; rows?: number },
): string[] {
  const width = Math.max(0, Math.floor(o.width)),
    { nowMs, color } = o,
    t = timeline(s, width, color, nowMs),
    times = t.last === null ? [t.now, t.legend] : [t.now, t.last, t.legend],
    // The activity takes up to two lines, the second under the first.
    activity =
      !o.verbose && s.activity
        ? wrapUpTo([{ text: s.activity, dim: true }], width - 3, width - 3, 2).map((line, i) =>
            draw([{ text: i ? "   " : " ▏ ", dim: true }, ...line], width, color),
          )
        : [],
    rows = o.rows === undefined ? Infinity : Math.max(1, Math.floor(o.rows)),
    items = s.stages.filter(st => st.state === "running").reduce((n, st) => n + (s.items[st.name] ?? []).length, 0),
    heads = stageHeads(s, { width, nowMs, color }),
    fixed = 1 + times.length + heads.reduce((n, h) => n + h.length, 0) + 2,
    // The items want at least a line before, the running one and one after.
    fits = (extra: number) => fixed + extra + Math.min(items, 3) <= rows,
    gaps = fits(3 + activity.length),
    shownActivity = fits((gaps ? 3 : 0) + activity.length) ? activity : [],
    gap = gaps ? [""] : [],
    itemRows = Math.max(1, rows - fixed - gap.length * 3 - shownActivity.length);
  return [
    header(s, width, color),
    ...gap,
    ...times,
    ...gap,
    ...checklist(s, { width, nowMs, color, itemRows, heads }),
    ...gap,
    ...footer(s, width, color),
    ...shownActivity,
  ];
}

/** A stage's time from its state alone: a stage still running when the run
 * ended counts up to its last item's end. */
function stageTime(s: LiveState, st: StageView): number {
  if (st.startedMs === null) return st.ms;
  const items = s.items[st.name] ?? [],
    replayed = items.filter(it => it.startedMs === null && it.ms !== null).reduce((n, it) => n + (it.ms ?? 0), 0),
    lastEnd = Math.max(
      st.startedMs,
      ...items.filter(it => it.startedMs !== null && it.ms !== null).map(it => it.startedMs! + it.ms!),
    );
  return st.ms + replayed + (lastEnd - st.startedMs);
}

const outcomeGroups: [string, string[], string][] = [
  ["merged", ["merged"], "#9ece6a"],
  ["replayed", ["replayed"], "#7dcfff"],
  ["agent-resolved", ["agent-resolved"], violet],
  ["user-resolved", ["user-resolved"], "#7aa2f7"],
  ["skipped", ["skipped-merged", "already-contained"], gray],
];
/** The card that replaces the live region when the run ends; nothing before that. */
export function card(s: LiveState, o: { width: number; color: boolean }): string[] {
  const e = s.ended;
  if (!e) return [];
  const width = Math.max(0, Math.floor(o.width)),
    { color } = o,
    out: string[] = [],
    plainLines = (line: Line, indent = 4) => out.push(...drawn(wrap(line, width, indent), color)),
    failed = s.stages.flatMap(st =>
      (s.items[st.name] ?? []).filter(it => it.state === "failed").map(it => ({ st, it })),
    );
  const total = s.stages.reduce((n, st) => n + stageTime(s, st), 0);
  if (!e.ok && failed.length) {
    const { st, it } = failed[0],
      items = s.items[st.name] ?? [],
      at = items.length > 1 ? ` ${items.indexOf(it) + 1}/${items.length}` : "";
    plainLines([
      { text: "✗", hex: red },
      { text: ` stopped after ${clock(total)} at ${st.name}${at}: `, tone: "bold" },
      { text: e.headline.replace(/^stopped:? /, "") },
    ]);
    for (const f of failed) {
      const parts = [
        ...(f.it.files.length ? [f.it.files.join(", ")] : []),
        ...(f.it.tries.length ? [plural(f.it.tries.length, "try", "tries")] : []),
        ...(f.it.tokens ? [`${tokens(f.it.tokens.input + f.it.tokens.output)} tok`] : []),
        ...(!f.it.tries.length && f.it.detail ? [f.it.detail] : []),
      ];
      plainLines([
        { text: " " },
        { text: f.it.id, url: s.links[f.it.id], tone: "bold" },
        { text: parts.length ? `  ${parts.join(" · ")}` : "" },
      ]);
      for (const t of f.it.tries)
        plainLines(
          [
            { text: `   try ${t.attempt} ` },
            t.ok ? { text: "✓", hex: green } : { text: "✗", hex: red },
            { text: t.reason ? ` ${t.reason}` : "" },
          ],
          9,
        );
    }
  } else {
    const partial = e.ok && problems(s);
    // Like with like: both runs' active times. The stage clocks hold harness
    // calls that history's merge items leave out.
    const last = s.estimate.last ?? s.base.last,
      took = e.activeMs || total,
      compare: Line = [];
    if (e.ok && e.activeMs && last?.activeMs) {
      const d = last.activeMs - e.activeMs;
      compare.push(
        d >= 0 ? { text: `  ▲ ${clock(d)} faster`, hex: green } : { text: `  ▼ ${clock(-d)} slower`, hex: amber },
      );
    }
    plainLines([
      partial ? { text: "◐", hex: amber } : e.ok ? { text: "✓", hex: green } : { text: "✗", hex: red },
      { text: ` ${e.headline}${partial ? ", with problems" : ""}`, tone: "bold" },
      { text: ` in ${clock(took)}` },
      ...compare,
    ]);
    const ran = s.stages.filter(st => st.state !== "pending"),
      room = Math.min(width, 80) - 1 - 2 * ran.length;
    if (total > 0 && room > 0) {
      const bar: Line = [{ text: " " }];
      for (const st of ran) {
        const cells = Math.max(1, Math.round((stageTime(s, st) / total) * room));
        bar.push({ text: "▕", dim: true });
        for (let c = 0; c < cells; c++) bar.push({ text: "█", hex: colorOf(st.name, c / Math.max(1, cells - 1)) });
        bar.push({ text: "▏", dim: true });
      }
      out.push(draw(bar, width, color));
    }
    if (ran.length) {
      const times: Line = [{ text: " " }];
      ran.forEach((st, i) => {
        if (i) times.push({ text: " · ", dim: true });
        times.push({ ...stageLook(st.name), text: st.name }, { text: ` ${clock(stageTime(s, st))}` });
      });
      out.push(draw(times, width, color));
    }
    const merged = s.items.merge ?? [],
      groups = outcomeGroups
        .map(([label, outcomes, hex]) => ({
          label,
          hex,
          n: merged.filter(it => it.outcome !== null && outcomes.includes(it.outcome)).length,
        }))
        .filter(g => g.n);
    const branches = s.items.rebase ?? [],
      branchGroups = branchOutcomes
        .map(([label, outcome, hex]) => ({ label, hex, n: branches.filter(it => it.outcome === outcome).length }))
        .filter(g => g.n);
    if (branchGroups.length) {
      const line: Line = [{ text: " branches  " }];
      branchGroups.forEach((g, i) => {
        line.push(
          { text: i ? "  " : "" },
          { text: "■".repeat(Math.min(g.n, 10)), hex: g.hex },
          { text: ` ${g.n} ${g.label}` },
        );
      });
      out.push(draw(line, width, color));
    }
    if (groups.length) {
      const line: Line = [{ text: " patches   " }];
      groups.forEach((g, i) => {
        line.push(
          { text: i ? "  " : "" },
          { text: "■".repeat(Math.min(g.n, 10)), hex: g.hex },
          { text: ` ${g.n} ${g.label}` },
        );
      });
      out.push(draw(line, width, color));
    }
    const used = s.stages.flatMap(st => (s.items[st.name] ?? []).filter(it => it.tokens)),
      sum = s.harness.input + s.harness.output;
    if (s.harnessKind && (sum || used.length)) {
      const line: Line = [{ text: " " }, { text: "✦", hex: violet }, { text: ` tokens  ${tokens(sum)}` }];
      used.forEach((it, i) => {
        line.push(
          { text: i ? " · " : "  ", dim: !!i },
          { text: it.id, url: s.links[it.id] },
          { text: ` ${tokens(it.tokens!.input + it.tokens!.output)}` },
        );
      });
      out.push(draw(line, width, color));
    }
    for (const st of s.stages)
      for (const it of s.items[st.name] ?? [])
        for (const r of it.retries) {
          // A verify item is its step; any other names what the retry was for.
          const who = st.name === "verify" ? "" : `${it.id}: `,
            text =
              r.why === "flaky"
                ? `${who}${r.detail}${it.state === "done" ? ", passed on retry: may be flaky" : ""}`
                : r.why === "harness"
                  ? `${it.id}: a try was rejected, ${r.detail}`
                  : `${r.detail}, tried on plain upstream`;
          out.push(draw([{ text: " " }, { text: "↻", hex: amber }, { text: ` retried ${text}` }], width, color));
        }
  }
  for (const line of e.lines) plainLines([{ text: line }]);
  if (e.report && !e.lines.some(line => line.includes(e.report!)))
    plainLines([
      { text: " report    ", dim: true },
      { text: e.report, url: e.report.startsWith("/") ? pathToFileURL(e.report).href : null },
    ]);
  return out;
}

/** A rebase stage's outcomes in the card's branch line, worst news last. */
const branchOutcomes: [string, string, string][] = [
  ["rebased", "rebased", green],
  ["current", "current", gray],
  ["not rebased", "not-rebased", red],
  ["left alone", "left-alone", amber],
];
/** Whether a run that ended well left work undone: an own branch that couldn't
 * be rebased, or, when rebasing was the whole run, one it left alone. */
export function problems(s: LiveState): boolean {
  const outcomes = (s.items.rebase ?? []).map(it => it.outcome);
  return outcomes.includes("not-rebased") || (s.command === "rebase" && outcomes.includes("left-alone"));
}

/** Detail lines of an outcome (`  report: path`) by their label, lined up on a card. */
const detailLine = /^\s*(report|handoff|push|note|warning|log|stopped|next)\s*:\s(.*)$/;
const fileLabels = new Set(["report", "handoff", "log"]);
/** An outcome without a run to show (an error, a refusal, a rollback) as a
 * card: a ✓ or ✗ headline, then its lines with their labels lined up. */
export function outcomeCard(
  e: { ok: boolean; headline: string; lines: string[]; report?: string | null },
  o: { width: number; color: boolean; command?: string | null; tookMs?: number | null },
): string[] {
  const width = Math.max(0, Math.floor(o.width)),
    details = e.lines.map(line => {
      const m = detailLine.exec(line);
      return m ? { label: m[1], text: m[2] } : { label: null, text: line.trim() };
    });
  if (e.report && !e.lines.some(line => line.includes(e.report!))) details.push({ label: "report", text: e.report });
  const labelCol = Math.max(0, ...details.map(d => d.label?.length ?? 0)),
    head: Line = [e.ok ? { text: "✓", hex: green } : { text: "✗", hex: red }, { text: " " }];
  if (!e.ok && o.command)
    head.push({ text: "custom-build", grad: term.titleGradient }, { text: ` ${o.command}: `, tone: "bold" });
  head.push({ text: e.headline, tone: "bold" });
  if (o.tookMs) head.push({ text: ` in ${clock(o.tookMs)}` });
  const out = drawn(wrap(head, width, 2), o.color);
  for (const d of details) {
    if (!d.text) continue;
    const line: Line = d.label
      ? [
          { text: "   " },
          d.label === "warning"
            ? { text: d.label.padEnd(labelCol), hex: amber }
            : { text: d.label.padEnd(labelCol), dim: true },
          { text: "  " },
          {
            text: d.text,
            url: fileLabels.has(d.label) && d.text.startsWith("/") ? pathToFileURL(d.text).href : null,
          },
        ]
      : [{ text: "   " }, { text: d.text }];
    out.push(...drawn(wrap(line, width, d.label ? 5 + labelCol : 3), o.color));
  }
  return out;
}

/** A task of a short command (rollback) and how it went. */
export type TaskLine = {
  id: string;
  state: "running" | "done" | "skipped" | "failed";
  detail: string;
  startedMs: number;
  ms: number | null;
};
const taskColor: Record<string, string> = {
  undo: term.stageColor.rebase,
  binary: term.stageColor["after-build"],
  install: term.stageColor.verify,
};
/** A short command's checklist: its title, then a line per task with its
 * mark, name, what it did and its time; the running one spins. */
export function taskFrame(
  t: { command: string; branch?: string | null; tasks: TaskLine[] },
  o: { width: number; nowMs: number; color: boolean },
): string[] {
  const width = Math.max(0, Math.floor(o.width)),
    { nowMs, color } = o,
    edge = Math.min(width, 72),
    nameCol = Math.max(0, ...t.tasks.map(x => term.width(x.id))) + 3,
    bodyCol = 3 + nameCol,
    head: Line = [
      { text: "custom-build", grad: term.titleGradient },
      { text: ` ${t.command}`, tone: "bold" },
    ];
  if (t.branch) head.push({ text: " · ", dim: true }, { text: t.branch });
  const lines = [draw(head, width, color)];
  for (const x of t.tasks) {
    const hex = taskColor[x.id] ?? violet,
      mark: Seg =
        x.state === "running"
          ? { text: spinner(nowMs), hex }
          : x.state === "done"
            ? { text: "✓", hex: green }
            : x.state === "failed"
              ? { text: "✗", hex: red }
              : { text: "↷", dim: true },
      name: Seg = { text: x.id.padEnd(nameCol), hex, dim: x.state === "skipped" },
      right: Line = [{ text: clock(x.ms ?? Math.max(0, nowMs - x.startedMs)), dim: true }],
      look: Partial<Seg> =
        x.state === "failed" ? { hex: red } : x.state === "running" || x.state === "skipped" ? { dim: true } : {},
      body = wrapUpTo([{ text: x.detail, ...look }], edge - widthOf(right) - 2 - bodyCol, width - bodyCol);
    lines.push(
      draw(spread([{ text: " " }, mark, { text: " " }, name, ...(body[0] ?? [])], right, edge), width, color),
      ...body.slice(1).map(line => draw([{ text: " ".repeat(bodyCol) }, ...line], width, color)),
    );
  }
  return lines;
}

/** The fireworks that open the card of a run that fully succeeded. */
export const finaleRows = 5,
  finaleFrameMs = 70;
const sparkColors = [violet, amber, "#7dcfff", red, green];
/** Where a burst's sparks fly: twelve directions round a circle. */
const sparkAngles = Array.from({ length: 12 }, (_, i) => (i * Math.PI) / 6);
/** A spark by its age: bright, then fading, then gone. */
const sparkAge = ["✦", "✦", "✧", "·"];
/** A spark at `radius` from a burst at (x, y): columns doubled so the burst
 * looks round in terminal cells, and sparks sink as they age. */
const sparkAt = (x: number, y: number, angle: number, radius: number, sink: number) => ({
  x: x + Math.round(Math.cos(angle) * radius * 2),
  y: y + Math.round(Math.sin(angle) * radius * 0.75) + sink,
});
/** Fireworks frame by frame, `finaleRows` high: rockets rise and burst into
 * sparks that fade, a beat apart; the last frame, a few sparks left, is what
 * stays above the card. Seeded, so a seed always draws the same show. */
export function fireworks(width: number, color: boolean, seed = 1): string[][] {
  const w = Math.max(0, Math.min(Math.floor(width), 64));
  if (w < 12) return [];
  let state = seed >>> 0 || 1;
  const rand = (n: number) => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return (state >>> 8) % n;
  };
  const count = w >= 40 ? 3 : w >= 24 ? 2 : 1,
    rockets = Array.from({ length: count }, (_, i) => {
      const x = Math.round(((i + 1) * w) / (count + 1)) + rand(5) - 2,
        top = rand(2),
        launch = i * 5;
      return { x, top, launch, burst: launch + (finaleRows - 1 - top), hex: sparkColors[rand(sparkColors.length)] };
    }),
    end = Math.max(...rockets.map(r => r.burst)) + sparkAge.length + 1;
  type Cell = { ch: string; hex?: string; dim?: boolean } | null;
  const scene = (frame: number, final: boolean): string[] => {
    const grid: Cell[][] = Array.from({ length: finaleRows }, () => Array<Cell>(w).fill(null)),
      put = (x: number, y: number, cell: Cell) => {
        if (x >= 0 && x < w && y >= 0 && y < finaleRows) grid[y][x] = cell;
      };
    for (const r of rockets) {
      if (final) {
        // What's left once the show is over: a few embers round each burst.
        sparkAngles.forEach((angle, i) => {
          if (i % 3 === 0) return;
          const at = sparkAt(r.x, r.top + 1, angle, 2.5, 1);
          put(at.x, at.y, { ch: i % 2 ? "✧" : "·", hex: r.hex, dim: i % 2 === 0 });
        });
        continue;
      }
      if (frame < r.launch) continue;
      if (frame < r.burst) {
        const y = finaleRows - 1 - (frame - r.launch);
        put(r.x, y, { ch: "│", hex: r.hex });
        put(r.x, y + 1, { ch: "╵", dim: true });
        continue;
      }
      const age = frame - r.burst;
      if (age >= sparkAge.length) continue;
      if (age === 0) put(r.x, r.top + 1, { ch: "✸", hex: r.hex });
      for (const angle of sparkAngles) {
        const at = sparkAt(r.x, r.top + 1, angle, age + 1, age >> 1);
        put(at.x, at.y, { ch: sparkAge[age], hex: r.hex, dim: age === sparkAge.length - 1 });
      }
    }
    return grid.map(row =>
      draw(
        row.map(cell => (cell ? { text: cell.ch, hex: cell.hex, dim: cell.dim } : { text: " " })),
        width,
        color,
      ).trimEnd(),
    );
  };
  return [...Array.from({ length: end }, (_, f) => scene(f, false)), scene(end, true)];
}
