import * as i18n from "./i18n";
import * as roadmap from "./activity/roadmap";
import type { Row as ObservedTool } from "./activity/plan_tools";
import type { Node } from "./activity/plan";
import * as palette from "./palette";
import * as text from "./text";
import { Rect } from "./layout";

type ToolRow = {
  kind: "tool";
  parent: Node | null;
  title: string;
  active: boolean;
  outcome?: ObservedTool["outcome"];
  members?: string[];
  first?: number;
  range?: string;
  total?: number;
};
type Row =
  | {
      kind: "node";
      node: Node;
      depth: number;
      counts?: roadmap.Counts;
      current?: boolean;
      returned?: boolean;
      tools?: ToolRow[];
    }
  | { kind: "request"; parent: null; title: string }
  | ToolRow
  | { kind: "tool-footer"; parent: Node | null; remaining: number }
  | { kind: "detail"; parent: Node | null; title: string }
  | { kind: "more"; parent: Node; count: number }
  | { kind: "pending"; parent: Node | null; active?: boolean };
const rowHeight = (row: Row) => (row.kind === "node" && row.node.bump ? 2 : 1);
const currentStep = (view: roadmap.Snapshot, node: Node) => node.id === view.focus_step && node.state === "active";
type Block = { from: number; episode: Node; heading: Extract<Row, { kind: "node" }>; children: Row[] };
function toolRow(tool: ObservedTool, parent: Node | null, running: boolean | null): ToolRow {
  const members = tool.members?.filter(label => label !== "…");
  const total = tool.members?.length ?? 0;
  if (members?.length && members.length < total) {
    const missing = total - members.length;
    members.push(i18n.t`Without a description: ${missing}`);
  }
  return { ...tool, kind: "tool", parent, active: running !== false && tool.running, members, total };
}
function blocks(view: roadmap.Snapshot, running: boolean | null): Block[] {
  if (view.visits.length) {
    const tools = new Map<number | null, roadmap.Snapshot["tool_rows"]>();
    for (const tool of view.tool_rows ?? []) {
      const rows = tools.get(tool.visit) ?? [];
      rows.push(tool);
      tools.set(tool.visit, rows);
    }
    const nodes = new Map(view.nodes.map(n => [n.id, n])),
      seenEpisodes = new Set<string>(),
      bumps = new Map<string, number>(),
      blocks: Block[] = [];
    for (const node of view.nodes) {
      if (!node.bump) continue;
      const failure = Math.min(...node.bump.evidence);
      const index = view.visits.findLastIndex(v => v.step === node.id && v.from <= failure);
      bumps.set(node.id, index < 0 ? view.visits.findIndex(v => v.step === node.id) : index);
    }
    view.visits.forEach((visit, i) => {
      const step = nodes.get(visit.step)!,
        episode = nodes.get(step.parent!)!;
      let block = blocks.at(-1);
      if (block?.episode.id !== episode.id) {
        block = {
          from: visit.from,
          episode,
          heading: {
            kind: "node",
            node: episode,
            depth: 0,
            counts: roadmap.zero(),
            current: false,
            returned: seenEpisodes.has(episode.id),
          },
          children: [],
        };
        blocks.push(block);
        seenEpisodes.add(episode.id);
      }
      const latest = i === view.visits.length - 1;
      block.heading.counts = roadmap.add(block.heading.counts!, visit.counts);
      block.heading.current = running !== false && latest && episode.id === view.focus && episode.state === "active";
      const index = block.children.findIndex(r => r.kind === "node" && r.node.id === step.id);
      const child: Row =
        index < 0
          ? { kind: "node", node: { ...step, bump: null }, depth: 1, counts: roadmap.zero(), current: false }
          : block.children.splice(index, 1)[0];
      block.children.push(child);
      if (child.kind === "node") {
        for (const tool of tools.get(visit.from) ?? []) {
          (child.tools ??= []).push(toolRow(tool, step, running));
        }
        child.counts = roadmap.add(child.counts!, visit.counts);
        child.current = running !== false && latest && currentStep(view, step);
        if (bumps.get(step.id) === i) child.node.bump = step.bump;
      }
      if (block.heading.current && ["done", "abandoned", "planned"].includes(step.state))
        block.children.push({ kind: "pending", parent: episode });
    });
    for (const block of blocks)
      block.children = block.children.flatMap(row => (row.kind === "node" && row.tools ? [row, ...row.tools] : [row]));
    return blocks;
  }
  const step = view.nodes.find(n => n.id === view.focus_step);
  return view.nodes
    .filter(n => n.kind === "episode")
    .sort((a, b) => Number(a.id === view.focus) - Number(b.id === view.focus))
    .map(episode => {
      const heading: Block["heading"] = {
        kind: "node",
        node: episode,
        depth: 0,
        current: running === false ? false : undefined,
      };
      const children: Row[] = view.nodes
        .filter(n => n.parent === episode.id)
        .sort((a, b) => Number(a.id === view.focus_step) - Number(b.id === view.focus_step))
        .map(node => ({ kind: "node", node, depth: 1, current: running === false ? false : undefined }));
      if (
        running !== false &&
        episode.id === view.focus &&
        episode.state === "active" &&
        (!step || ["done", "abandoned", "planned"].includes(step.state))
      )
        children.push({ kind: "pending", parent: episode });
      return { from: 0, episode, heading, children };
    });
}
export type Expanded = { id: number; offset: number };
export function tail(
  view: roadmap.Snapshot,
  count: number,
  running: boolean | null = null,
  expanded: Expanded | null = null,
): { rows: Row[]; hidden: number } {
  const episodes = blocks(view, running);
  type RequestBlock = { from: number; episode: null; heading: Extract<Row, { kind: "request" }>; children: Row[] };
  const requests = new Map<string, RequestBlock>();
  for (const tool of view.tool_rows ?? []) {
    if (tool.visit !== null && view.visits.length) continue;
    const request = tool.request;
    const key = request ? request.turn + "/" + request.id : "";
    let block = requests.get(key);
    if (!block) {
      const turn = request?.turn;
      block = {
        from: request?.event ?? 0,
        episode: null,
        heading: {
          kind: "request",
          parent: null,
          title: request?.title || (turn ? i18n.t`Request ${turn}` : i18n.t`Tools`),
        },
        children: [],
      };
      requests.set(key, block);
    }
    block.from = Math.min(block.from, request?.event ?? 0);
    block.children.push(toolRow(tool, null, running));
  }
  const groups = [...episodes, ...requests.values()].sort((a, b) => a.from - b.from);
  if (expanded) {
    // Keep the selected summary with its step even if new foreground work arrives.
    const block = groups.find(b => b.children.some(row => row.kind === "tool" && row.first === expanded.id));
    const tool: ToolRow | undefined = block?.children.find(
      (r): r is ToolRow => r.kind === "tool" && r.first === expanded.id,
    );
    if (tool?.members?.length) {
      const parent = block?.children.find(r => r.kind === "node" && r.node.id === tool.parent?.id);
      const context: Row[] = block ? [block.heading, ...(parent ? [parent] : []), tool] : [tool];
      const room = count - height(context);
      const footer = room >= 2 && tool.members.length > Math.min(6, room);
      const size = Math.min(6, tool.members.length, room - Number(footer));
      if (size > 0) {
        const compact = tail(view, count - size - Number(footer), running);
        const visible = compact.rows.some(r => r.kind === "tool" && r.first === expanded.id);
        const rows = visible ? compact.rows : context;
        const index = rows.findIndex(r => r.kind === "tool" && r.first === expanded.id);
        const start = Math.min(Math.max(0, expanded.offset), tool.members.length - size);
        const details: Row[] = tool.members
          .slice(start, start + size)
          .map(title => ({ kind: "detail", parent: tool.parent, title }));
        if (footer)
          details.push({ kind: "tool-footer", parent: tool.parent, remaining: tool.members.length - start - size });
        rows.splice(
          index,
          1,
          {
            ...tool,
            range:
              size < tool.members.length && tool.total === tool.members.length
                ? `${start + 1}–${start + size}/${tool.members.length}`
                : "",
          },
          ...details,
        );
        return { rows, hidden: visible ? compact.hidden : 0 };
      }
    }
  }
  let pending: Row | null = null;
  if (
    running &&
    groups.at(-1)?.heading.kind !== "request" &&
    !groups.some(b =>
      b.children.some(
        r => (r.kind === "tool" && r.active) || (r.kind === "node" && (r.current ?? currentStep(view, r.node))),
      ),
    )
  ) {
    const last = groups.at(-1);
    if (
      last?.episode &&
      (last.heading.current ?? (last.episode.id === view.focus && last.episode.state === "active"))
    ) {
      const placeholder = last.children.find(r => r.kind === "pending");
      if (placeholder?.kind === "pending") placeholder.active = true;
      else last.children.push({ kind: "pending", parent: last.episode, active: true });
    } else pending = { kind: "pending", parent: null, active: true };
  }
  const room = Math.max(0, count - (pending ? 1 : 0));
  const all = groups.flatMap(b => [b.heading, ...b.children]);
  const pinned = all.filter(
    r =>
      r.kind === "pending" ||
      (r.kind === "node" &&
        (r.current ?? (currentStep(view, r.node) || (r.node.id === view.focus && r.node.state === "active")))),
  );
  const item = (r: Row) => r.kind === "node" || r.kind === "tool" || r.kind === "request";
  const items = all.filter(item);
  const fit = (selected: Set<Row>) => {
    const candidate: Row[] = [];
    for (const { episode, heading, children } of groups) {
      if (!selected.has(heading) && !children.some(r => selected.has(r))) continue;
      const parents = new Set(children.flatMap(r => (r.kind === "tool" && selected.has(r) ? [r.parent?.id] : [])));
      candidate.push(heading);
      let hidden = 0;
      const gap = () => {
        if (episode && hidden >= 2 && count >= 4) candidate.push({ kind: "more", parent: episode, count: hidden });
        hidden = 0;
      };
      for (const child of children) {
        if (selected.has(child) || (child.kind === "node" && parents.has(child.node.id))) {
          gap();
          candidate.push(child);
        } else if (child.kind === "node" || child.kind === "tool") hidden++;
      }
      gap();
    }
    return candidate;
  };
  // Keep as many running tools as fit, even when newer calls have already finished.
  for (const tool of all.filter(r => r.kind === "tool" && r.active).reverse()) {
    if (height(fit(new Set([...pinned, tool]))) <= room) pinned.push(tool);
    else break;
  }
  let rows: Row[] = [];
  // Keep the latest work and its episode visible in short terminals.
  for (let start = all.length; start >= 0; start--) {
    const selected = new Set([...all.slice(start), ...pinned]);
    const candidate = fit(selected);
    if (candidate.reduce((sum, r) => sum + rowHeight(r), 0) <= room) rows = candidate;
    if (all.slice(start).reduce((sum, r) => sum + rowHeight(r), 0) > room) break;
  }
  if (pending) rows.push(pending);
  return { rows, hidden: items.length - rows.filter(item).length };
}
export const height = (rows: Row[]) => rows.reduce((sum, row) => sum + rowHeight(row), 0);
export function drawRows(
  view: roadmap.Snapshot,
  rows: Row[],
  width: number,
  paint: {
    line: (row: number, label: string, counts: roadmap.Counts | null, tone: palette.Token) => void;
    mark: (row: number, column: number, value: string, tone: palette.Token, bold?: boolean, strike?: boolean) => void;
  },
) {
  let y = 0;
  rows.forEach((entry, i) => {
    const next = rows[i + 1],
      last = !next || (next.kind === "node" && next.depth === 0) || (next.kind === "pending" && next.parent === null);
    if (entry.kind === "request") {
      paint.line(y++, entry.title, null, "text");
      return;
    }
    if (entry.kind === "tool-footer") {
      const remaining = entry.remaining;
      paint.line(y++, remaining ? "         " + i18n.t`↓ ${remaining} more` : "", null, "faint");
      return;
    }
    if (entry.kind === "detail") {
      paint.line(y++, "         " + "· " + entry.title, null, "muted");
      return;
    }
    if (entry.kind === "tool") {
      const indent = "     ";
      const name = entry.title === "…" ? "" : " " + entry.title;
      if (entry.active) paint.line(y++, indent + "▶ ›_" + name, null, "accent");
      else if (entry.outcome && entry.members) {
        const status =
          entry.outcome === "failure"
            ? "× " + i18n.t`Failed`
            : entry.outcome === "success"
              ? "✓ " + i18n.t`Succeeded`
              : "· " + i18n.t`Outcome unknown`;
        const count = entry.range || String(entry.total);
        const caret = entry.members.length ? (entry.range === undefined ? "▸ " : "▾ ") : "";
        paint.line(
          y++,
          indent + caret + status + " (" + count + ")" + name,
          null,
          entry.outcome === "failure" ? "hot" : "muted",
        );
      } else paint.line(y++, indent + "· " + i18n.t`Finished` + name, null, "muted");
      return;
    }
    if (entry.kind !== "node") {
      if (entry.kind === "pending" && entry.active) paint.line(y++, entry.parent ? "  ┣▶ …" : "▶ …", null, "accent");
      else
        paint.line(y++, `  ${last ? "╰" : "├"} …${entry.kind === "more" ? ` ${entry.count} more` : ""}`, null, "faint");
      return;
    }
    const { node, depth } = entry;
    const focused = depth === 0 && (entry.current ?? (node.id === view.focus && node.state === "active")),
      current = depth === 1 && (entry.current ?? currentStep(view, node)),
      closed =
        node.state === "done" ||
        node.state === "abandoned" ||
        (node.state === "failed" && node.bump?.state === "resolved");
    let tone: palette.Token = "text";
    if (current) tone = "accent";
    else if (focused) tone = "strong";
    else if (closed) tone = "muted";
    else if (node.state === "planned") tone = "faint";
    const branch = current ? "┣" : last ? "╰" : "├",
      prefix = depth ? "  " + branch : "",
      issue = node.bump ? "!" : "",
      // An episode is a heading: bold says it is current, and only a problem takes a marker.
      marker = depth ? (current ? "▶" : "") + issue || " " : issue,
      lead = prefix + marker + (marker ? " " : ""),
      counts = entry.counts ?? view.counts[node.id] ?? roadmap.zero(),
      suffix = node.state === "planned" ? " (planned)" : "";
    paint.line(y, `${lead}${entry.returned ? "↩ " : ""}${node.title}${suffix}`, counts, tone);
    if (depth) paint.mark(y, 2, branch, current ? "accent" : "line", current);
    if (current) paint.mark(y, prefix.length, "▶", "accent", true);
    if (issue) paint.mark(y, prefix.length + (current ? 1 : 0), issue, node.bump!.state === "open" ? "warm" : "muted");
    y++;
    if (node.bump) {
      const resolved = node.bump.state === "resolved",
        column = lead.length,
        detail = text.ellipsis(node.bump.detail, width - column);
      paint.line(y, " ".repeat(column) + detail, null, resolved ? "faint" : "muted");
      if (resolved) paint.mark(y, column, detail, "faint", false, true);
      if (!last || current) paint.mark(y, 2, current ? "┃" : "│", current ? "accent" : "line");
      y++;
    }
  });
  return y;
}
export function geometry(cols: number, rows: number) {
  const w = Math.max(1, Math.min(112, cols - 2)),
    h = Math.max(1, rows - 2);
  return new Rect(Math.floor((cols - w) / 2), 1, w, h);
}
export const capacity = (rect: Rect) => Math.max(1, rect.h - 7);
export function draw(w: text.Writer, rect: Rect, name: string, view: roadmap.Snapshot, running: boolean | null = null) {
  const line = (y: number, value: string, tone: palette.Token = "text") => {
    if (y < 0 || y >= rect.h) return;
    const style = new palette.Style({ fg: tone, bg: "surface", bold: tone === "strong" || tone === "accent" }),
      clipped = text.ellipsis(value, rect.w),
      padded = clipped + " ".repeat(Math.max(0, rect.w - text.displayWidth(clipped)));
    w.write(`\x1b[${rect.y + y + 1};${rect.x + 1}H${style.sgr()}${padded}`);
  };
  for (let y = 0; y < rect.h; y++) line(y, "");
  line(0, `  Plan · ${name}`, "strong");
  if (rect.h < 10 || rect.w < 36) {
    line(2, " Enlarge terminal · Esc to close", "muted");
    return;
  }
  const { rows, hidden } = tail(view, capacity(rect), running),
    lastRow = rows.at(-1),
    last = lastRow?.kind === "node" ? lastRow.node : lastRow?.parent,
    episode =
      view.nodes.find(n => n.id === view.focus) ??
      (last?.kind === "step" ? view.nodes.find(n => n.id === last.parent) : last),
    heading = episode;
  const observed = view.nodes
    .filter(n => n.kind === "episode")
    .reduce((sum, n) => roadmap.add(sum, view.counts[n.id] ?? roadmap.zero()), view.unassigned);
  line(1, heading ? "  " + heading.title : "", "strong");
  line(2, hidden ? `  … ${hidden} earlier items` : "─".repeat(rect.w), hidden ? "muted" : "line");
  const columns = rect.w >= 88 ? 3 : rect.w >= 60 ? 2 : 1;
  const metric = (values: string[]) =>
    values
      .slice(0, columns)
      .map((v, i) => v.padStart([8, 10, 10][i]))
      .join(" ");
  const stats = (counts: roadmap.Counts, partial = false) =>
    metric([
      view.known ? (partial ? "≥" : "") + text.compactCount(roadmap.total(counts)) : "",
      counts.tools === undefined ? "" : text.compactCount(BigInt(counts.tools)),
      view.known ? text.compactCount(BigInt(counts.cached)) : "",
    ]);
  const row = (y: number, label: string, values: string, tone: palette.Token) => {
    const title = text.ellipsis(label, rect.w - values.length - 4);
    line(
      y,
      title + " ".repeat(Math.max(1, rect.w - text.displayWidth(title) - values.length - 2)) + values + "  ",
      tone,
    );
  };
  row(3, "  Episode / step", metric(["Tokens", "Calls", "Cached"]), "faint");
  let y = 4;
  const mark = (column: number, value: string, color: palette.Token, bold = false, strike = false) => {
    const style = new palette.Style({ fg: color, bg: "surface", bold, strike });
    w.write(`\x1b[${rect.y + y + 1};${rect.x + column + 1}H${style.sgr()}${value}`);
  };
  drawRows(view, rows, rect.w - 2, {
    line: (rowIndex, label, counts, tone) => {
      y = 4 + rowIndex;
      if (counts) row(y, "  " + label, stats(counts), tone);
      else line(y, "  " + label, tone);
    },
    mark: (rowIndex, column, value, tone, bold, strike) => {
      y = 4 + rowIndex;
      mark(column + 2, value, tone, bold, strike);
    },
  });
  if (!rows.length) line(4, "  …", "faint");
  line(rect.h - 3, "─".repeat(rect.w), "line");
  if (columns === 3) row(rect.h - 2, "  Total", stats(observed, view.partial), "strong");
  else {
    const total = [
      view.known ? (view.partial ? "≥" : "") + text.compactCount(roadmap.total(observed)) : "",
      observed.tools === undefined ? "" : text.compactCount(BigInt(observed.tools)) + " calls",
      view.known ? text.compactCount(BigInt(observed.cached)) + " cached" : "",
    ]
      .filter(Boolean)
      .join(" · ");
    line(rect.h - 2, "  Total " + total, "strong");
  }
  const notes = [
    "Esc close",
    view.known && roadmap.total(view.unassigned) > 0n
      ? text.compactCount(roadmap.total(view.unassigned)) + " tokens unassigned"
      : "",
    view.limited ? "History limit reached" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  line(rect.h - 1, "  " + notes, "muted");
  w.write("\x1b[0m\x1b[?25l");
}
