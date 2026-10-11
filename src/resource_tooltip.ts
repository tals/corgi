//! Viewer-local resource card: three framed graphs and a stable mini top.
//! Mirrors resource_tooltip.zig.
import { Style, derived } from "./palette";
import { Rect } from "./layout";
import { cpuText, ioText } from "./trackers/resources";
import { Writer, displayWidth, writeClipped, directoryLabel, sat, zigRound } from "./text";

// Each write sets a whole style, so bold never leaks into the next.
let text: string, faint: string, rule: string, strong: string, warm: string, live: string;
derived(() => {
  text = new Style({ fg: "text", bg: "bg" }).sgr();
  faint = new Style({ fg: "faint", bg: "bg" }).sgr();
  rule = new Style({ fg: "line", bg: "bg" }).sgr();
  // Titles, headings, and the figures the table sorts by.
  strong = new Style({ fg: "strong", bg: "bg", bold: true }).sgr();
  warm = new Style({ fg: "warm", bg: "bg" }).sgr();
  // Graph cells: live data, like the limit sparks.
  live = new Style({ fg: "accent", bg: "bg" }).sgr();
});

export type Sort = "cpu" | "memory" | "io";

export function geometry(cols: number, rows: number, side: number, anchor: number): Rect | null {
  if (cols < 68 || rows < 22) return null;
  const w = Math.min(82, cols - 2);
  const h = Math.min(24, rows - 2);
  return new Rect(Math.min(side, cols - w - 1), Math.min(anchor, rows - h - 1), w, h);
}
/** Where the pointer left the resource row on its way to the card, and when it
 * last moved inside the aim triangle. */
export interface Aim {
  x: number;
  y: number;
  at: number;
}
/** A pointer resting this long short of the card has stopped aiming for it. */
export const aim_ms = 300;
/** Amazon's mega-dropdown "menu aim": after the pointer leaves the resource
 * row, cells inside the triangle from its exit point to the card's left edge
 * are on the way to the card, even across other sidebar rows. Moves arrive a
 * whole cell at a time and cells are about twice as tall as wide, so the apex
 * sits two columns behind the exit point: a first step straight down still
 * counts as aiming, a second does not. */
export function aimed(rect: Rect, from: { x: number; y: number }, x: number, y: number): boolean {
  const ax = from.x - 2;
  const ay = from.y;
  const edge = rect.x;
  if (x <= ax || x >= edge) return false;
  const top = (rect.y - ay) * (x - ax);
  const bottom = (rect.y + rect.h - 1 - ay) * (x - ax);
  const slope = (y - ay) * (edge - ax);
  return slope >= top && slope <= bottom;
}
export interface Process {
  pid: number;
  start: bigint;
  name: string;
  provider?: "codex" | "claude" | null;
  cpu?: number | null;
  memory?: bigint;
  read?: bigint | null;
  written?: bigint | null;
}
function metricValue(sort: Sort, p: Process): number {
  switch (sort) {
    case "cpu":
      return p.cpu ?? -1;
    case "memory":
      return Number(p.memory ?? 0);
    case "io":
      return p.read != null && p.written != null ? Number(p.read) + Number(p.written) : -1;
  }
}
export function less(sort: Sort, left: Process, right: Process): boolean {
  const l = metricValue(sort, left);
  const r = metricValue(sort, right);
  return l === r ? left.pid < right.pid : l > r;
}
const process_capacity = 64;
interface Key {
  pid: number;
  start: string;
}
export class State {
  workspace: number | null = null;
  anchor = 0;
  sort: Sort = "cpu";
  order: Key[] = [];
  count = 0;
  frozen = false;
  constructor(fields: Partial<State> = {}) {
    Object.assign(this, fields);
  }
  update(work: { id: number; processes?: Process[] }, freeze: boolean): void {
    if (this.workspace !== work.id) {
      this.workspace = work.id;
      this.count = 0;
      this.sort = "cpu";
      this.frozen = false;
    }
    if (freeze && this.frozen && this.count > 0) return;
    const list = (work.processes ?? []).slice(0, process_capacity);
    // std.mem.sort is stable, as Array.sort is.
    list.sort((a, b) => (less(this.sort, a, b) ? -1 : less(this.sort, b, a) ? 1 : 0));
    this.order = list.map(p => ({ pid: p.pid, start: String(p.start) }));
    this.count = list.length;
    this.frozen = freeze;
  }
  click(rect: Rect, x: number, y: number): void {
    const sort = sortAt(rect, x, y);
    if (sort === null) return;
    this.sort = sort;
    this.frozen = false;
  }
}
/** The sortable column header under a cell, from "CPU %" through "W MB/s".
 * Both disk columns sort by I/O. */
export function sortAt(rect: Rect, x: number, y: number): Sort | null {
  if (y !== rect.y + 14 || x < rect.x + rect.w - 32 || x >= rect.x + rect.w - 2) return null;
  if (x >= rect.x + rect.w - 17) return "io";
  if (x >= rect.x + rect.w - 24) return "memory";
  return "cpu";
}

function at(w: Writer, x: number, y: number, color: string, value: string, width: number): void {
  w.write(`\x1b[${y + 1};${x + 1}H${color}`);
  if (value.length === 0) return;
  writeClipped(w, directoryLabel(value, null, 512), width);
}
function right(w: Writer, x: number, y: number, color: string, value: string, width: number): void {
  at(w, x + sat(width, Math.min(width, displayWidth(value))), y, color, value, width);
}
function box(w: Writer, rect: Rect, title: string, title_color: string): void {
  at(w, rect.x, rect.y, rule, "┌", 1);
  w.write("─".repeat(rect.w - 2));
  w.write("┐");
  for (let row = 1; row < rect.h - 1; row++) {
    at(w, rect.x, rect.y + row, rule, "│", 1);
    at(w, rect.x + rect.w - 1, rect.y + row, rule, "│", 1);
  }
  at(w, rect.x, rect.y + rect.h - 1, rule, "└", 1);
  w.write("─".repeat(rect.w - 2));
  w.write("┘");
  at(w, rect.x + 2, rect.y, title_color, title, rect.w - 4);
}
/** Zig's `{d:.N}` for a float. */
export function fixed(value: number, digits: number): string {
  return value.toFixed(digits);
}
const u64 = (value: unknown): bigint | null => (value === null || value === undefined ? null : BigInt(value as number));
function graph(w: Writer, rect: Rect, work: any, metric: Sort): void {
  const read = u64(work.read);
  const written = u64(work.written);
  const total = read !== null && written !== null ? read + written : null;
  const value =
    metric === "cpu"
      ? cpuText(work.cpu ?? null)
      : metric === "memory"
        ? work.memory != null
          ? `${fixed(Number(work.memory) / (1024 * 1024 * 1024), 2)} GiB`
          : ""
        : ioText(total);
  if (value.length === 0) return;
  box(w, rect, metric === "cpu" ? " cpu " : metric === "memory" ? " memory " : " disk I/O ", faint);
  at(w, rect.x + 2, rect.y + 1, strong, value, rect.w - 4);
  const width = rect.w - 4;
  const all: any[] = work.history ?? [];
  const history = all.slice(all.length - Math.min(width, all.length));
  let ceiling = metric === "cpu" ? 100 : 1;
  for (const point of history) {
    const v = sample(point, metric);
    if (v !== null) ceiling = Math.max(ceiling, v);
  }
  const rows = rect.h - 4;
  const glyphs = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  history.forEach((point, i) => {
    const v = sample(point, metric);
    if (v === null) return;
    const eighths = zigRound((v / ceiling) * (rows * 8));
    for (let row = 0; row < rows; row++) {
      const fill = Math.min(8, sat(eighths, row * 8));
      at(w, rect.x + 2 + width - history.length + i, rect.y + rect.h - 2 - row, live, glyphs[fill], 1);
    }
  });
}
function sample(point: any, metric: Sort): number | null {
  switch (metric) {
    case "cpu":
      return point.cpu ?? null;
    case "memory":
      return point.memory == null ? null : Number(point.memory);
    case "io":
      return point.io == null ? null : Number(point.io);
  }
}
function statusText(work: any): string {
  if (!work.known) return "Sampling unavailable";
  if (work.partial) return "Partial process coverage";
  if (work.cpu_pressure) return "CPU busy";
  return "";
}

export function draw(w: Writer, rect: Rect, name: string, snapshot: any, state: State): void {
  if (state.workspace === null) return;
  const found = (snapshot?.workspaces ?? []).find((item: any) => item.id === state.workspace);
  const work = {
    known: false,
    partial: false,
    count: 0,
    cpu: null,
    memory: null,
    read: null,
    written: null,
    cpu_pressure: false,
    processes: [],
    history: [],
    ...(found ?? {}),
    id: state.workspace,
  };
  w.write("\x1b7\x1b]8;;\x1b\\" + text + "\x1b[?25l");
  for (let row = 0; row < rect.h; row++) {
    w.write(`\x1b[${rect.y + row + 1};${rect.x + 1}H`);
    w.splat(" ", rect.w);
  }
  box(w, rect, ` ${name} / resources `, strong);
  const status = statusText(work);
  at(w, rect.x + 2, rect.y + 1, work.cpu_pressure ? warm : text, status, rect.w - 20);
  right(
    w,
    rect.x + rect.w - 16,
    rect.y + 1,
    faint,
    `live / ${Math.floor((snapshot?.interval_ms ?? 2000) / 1000)}s`,
    13,
  );
  const gw = Math.floor((rect.w - 6) / 3);
  (["cpu", "memory", "io"] as Sort[]).forEach((metric, i) => {
    graph(w, new Rect(rect.x + 2 + i * (gw + 1), rect.y + 3, gw, 7), work, metric);
  });
  let host_line = `HOST ${snapshot?.cores ?? 1} cores`;
  if (snapshot?.host_cpu != null) host_line += ` / ${cpuText(snapshot.host_cpu)} CPU`;
  if ((snapshot?.memory_pressure ?? "unknown") !== "unknown") host_line += ` / memory ${snapshot.memory_pressure}`;
  at(w, rect.x + 2, rect.y + 11, faint, host_line, rect.w - 4);
  at(w, rect.x + 2, rect.y + 13, strong, "TOP PROCESSES", 20);
  const header = rect.y + 14;
  // The sorted column's heading and figures are bright; the rest recede.
  const cpu = state.sort === "cpu" ? strong : text;
  const memory = state.sort === "memory" ? strong : text;
  const io = state.sort === "io" ? strong : text;
  // Linux PIDs reach seven digits.
  right(w, rect.x + 2, header, faint, "PID", 7);
  at(w, rect.x + 10, header, faint, "PROCESS", rect.w - 43);
  right(w, rect.x + rect.w - 32, header, state.sort === "cpu" ? strong : faint, "CPU %", 7);
  right(w, rect.x + rect.w - 24, header, state.sort === "memory" ? strong : faint, "GiB", 6);
  right(w, rect.x + rect.w - 17, header, state.sort === "io" ? strong : faint, "R MB/s", 7);
  right(w, rect.x + rect.w - 9, header, state.sort === "io" ? strong : faint, "W MB/s", 7);
  const count = Math.min(state.count, sat(rect.h, 19));
  state.order.slice(0, count).forEach((key, i) => {
    const y = header + 1 + i;
    const p: Process | undefined = work.processes.find(
      (item: Process) => item.pid === key.pid && String(item.start) === key.start,
    );
    right(w, rect.x + 2, y, faint, `${key.pid}`, 7);
    if (p) {
      at(w, rect.x + 10, y, text, `${p.provider ? (p.provider === "claude" ? "* " : "† ") : ""}${p.name}`, rect.w - 43);
      right(w, rect.x + rect.w - 32, y, cpu, p.cpu != null ? fixed(p.cpu, 1) : "", 7);
      right(w, rect.x + rect.w - 24, y, memory, fixed(Number(p.memory ?? 0) / (1024 * 1024 * 1024), 2), 6);
      right(w, rect.x + rect.w - 17, y, io, p.read != null ? fixed(Number(p.read) / 1000000, 1) : "", 7);
      right(w, rect.x + rect.w - 9, y, io, p.written != null ? fixed(Number(p.written) / 1000000, 1) : "", 7);
    } else at(w, rect.x + 10, y, faint, "Sample not available", rect.w - 43);
  });
  at(w, rect.x + 2, rect.y + rect.h - 3, faint, "* Claude Code   † Codex", rect.w - 4);
  at(
    w,
    rect.x + 2,
    rect.y + rect.h - 2,
    faint,
    `${work.count} local processes / ${snapshot?.memory_kind ?? "RSS"}${work.partial ? " / partial" : ""} / ${count} shown`,
    rect.w - 4,
  );
  w.write("\x1b[0m\x1b8\x1b[?25l");
}
