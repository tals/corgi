//! The sessions one source offers, as a tree of workspaces, tabs and panes to
//! choose from and copy into Corgi. Onboarding and Corgi setup both draw it:
//! two rows of notes, a gap, then the tree, scrolling to fit with a thumb on
//! the border to its right.
import { randomBytes } from "node:crypto";
import { n } from "../native_bridge";
import { milliTimestamp } from "../clock";
import * as palette from "../palette";
import { Rect } from "../layout";
import type { Connection } from "../rpc";
import { Writer, byteSlice, clamp, displayWidth, sat, writeSanitized } from "../text";
import * as catalog from "./catalog";
import * as scrollThumb from "../scroll_thumb";
import * as settingRow from "../setting_row";

export class WorkspacePreview {
  pane_limit: number;
  hidden: number;
  rows: number;
  toggle_row: number | null;
  constructor(ws: catalog.Workspace, can_fold: boolean, expanded: boolean) {
    const total = ws.tabs.reduce((n, t) => n + t.panes.length, 0),
      foldable = can_fold && total > 3,
      limit = foldable && !expanded ? 3 : Number.MAX_SAFE_INTEGER;
    let remaining = limit,
      details = 0;
    for (const tab of ws.tabs) {
      if (!remaining) break;
      const visible = Math.min(remaining, tab.panes.length);
      remaining -= visible;
      details += tab.panes.length === 1 ? 1 : 1 + visible;
    }
    const header = 1 + (ws.recovery === "full" ? 0 : ws.recovery === "workspace" ? 2 : 1);
    this.pane_limit = limit;
    this.hidden = Math.max(0, total - limit);
    this.rows = header + details + Number(foldable) + 1;
    this.toggle_row = foldable ? header + (expanded ? 0 : details) : null;
  }
}
/** Choosing workspaces, copying them, then done. */
export type Stage = "choose" | "copying" | "complete";
/** A click's target: a workspace, its fold toggle, or Herdr's handoff switch. */
export type Hit = { select: number } | { expand: number } | { handoff: true };
/** The tree's first row in the picker's area, below the notes. */
const tree_top = 3;

export class Picker {
  source: catalog.Source = "tmux";
  workers = new Map<catalog.Source, catalog.Worker>();
  selected = Array(256).fill(false);
  expanded = Array(256).fill(false);
  cursor = 0;
  scroll = 0;
  reveal_cursor = false;
  handoff = true;
  /** Whether the cursor is on Herdr's handoff switch, above the workspaces. */
  switch_focused = false;
  stage: Stage = "choose";
  progress: any = {
    phase: "idle",
    completed: 0,
    total: 0,
    workspace: null,
    message: "",
  };
  /** The last failure, until the next key. */
  message = "";
  operation = 0n;
  last_poll = 0;
  blink_closed = false;
  scan_finished = false;
  selection_initialized = false;
  close() {
    for (const worker of this.workers.values()) worker.close();
    this.workers.clear();
  }
  worker() {
    return this.workers.get(this.source) ?? null;
  }
  items(): catalog.Workspace[] {
    const worker = this.worker();
    return worker?.done ? worker.catalog.workspaces.slice(0, 256) : [];
  }
  scan() {
    this.scan_finished = false;
    if (!this.worker())
      try {
        this.workers.set(this.source, catalog.Worker.start(this.source));
      } catch (error) {
        this.message = (error as Error).message;
      }
  }
  changeSource(source: catalog.Source) {
    if (!catalog.available_sources.includes(source)) return;
    this.operation = 0n;
    this.stage = "choose";
    this.source = source;
    this.cursor = 0;
    this.switch_focused = false;
    this.scroll = 0;
    this.selected.fill(false);
    this.expanded.fill(false);
    this.selection_initialized = false;
    this.message = "";
    this.scan();
  }
  /** Scans the source again, unless a scan is still running. */
  refresh() {
    const worker = this.worker();
    if (worker && !worker.done) return;
    worker?.close();
    this.workers.delete(this.source);
    this.selected.fill(false);
    this.expanded.fill(false);
    this.selection_initialized = false;
    this.scan();
  }
  activeHandoff() {
    const list = this.items();
    return (
      this.source === "herdr" && this.handoff && list.length > 0 && list[Math.min(this.cursor, list.length - 1)].handoff
    );
  }
  chosen(index: number) {
    const list = this.items();
    return this.activeHandoff()
      ? list[index].session === list[Math.min(this.cursor, list.length - 1)].session
      : this.selected[index];
  }
  selectionCount() {
    return this.items().filter((_, i) => this.chosen(i)).length;
  }
  /** Whether a copy failed and waits for `retry`. */
  failed() {
    return this.stage === "copying" && this.progress.phase === "failed";
  }
  /** Asks the daemon to copy, or hand off, the chosen workspaces. */
  async begin(conn: Connection): Promise<void> {
    if (!this.operation) this.operation = (randomBytes(8).readBigUInt64LE() >> 1n) | 1n;
    if (this.activeHandoff()) {
      const list = this.items(),
        current = process.env.HERDR_PANE_ID;
      if (
        current &&
        list.some(
          ws =>
            ws.session === list[this.cursor].session &&
            ws.tabs.some(tab => tab.panes.some(pane => pane.id === current)),
        )
      )
        throw Error("OpenCorgiOutsideHerdrFirst");
      await conn.call("onboarding.handoff", {
        operation: this.operation,
        viewer_pgid: n.probe_getpgrp(),
        socket: list[this.cursor].socket,
      });
    } else {
      const selected = this.items().filter((_, i) => this.chosen(i));
      if (this.source === "herdr") {
        const first = selected[0].session;
        if (selected.some(ws => ws.session !== first)) throw Error("ChooseOneHerdrSession");
        await conn.call("onboarding.copy", {
          operation: this.operation,
          source: this.source,
          workspaces: selected,
          herdr_session: this.worker()!.herdr_scan!.sessions[first],
          selected: selected.map(ws => ws.id),
        });
      } else
        await conn.call("onboarding.copy", {
          operation: this.operation,
          source: this.source,
          workspaces: catalog.copyWorkspaces(selected),
        });
    }
    this.stage = "copying";
    this.scroll = 0;
    this.message = "";
    this.progress = {
      phase: "connecting",
      completed: 0,
      total: 0,
      workspace: null,
      message: "",
    };
    this.last_poll = 0;
  }
  /** Back to choosing after a failed copy, with the failure as the message. */
  retry() {
    this.stage = "choose";
    this.operation = 0n;
    this.message = this.progress.message;
  }
  /** Back to choosing after a finished copy, from a fresh scan. */
  restart() {
    this.stage = "choose";
    this.operation = 0n;
    this.refresh();
  }
  /** True when the picker changed and needs drawing. */
  async poll(conn: Connection): Promise<boolean> {
    const blink = this.cmuxConfused() && milliTimestamp() % 5000 >= 4850,
      animation = blink !== this.blink_closed;
    this.blink_closed = blink;
    if (this.stage === "choose") {
      if (!this.scan_finished && this.worker()?.done) {
        this.scan_finished = true;
        this.cursor = Math.min(this.cursor, Math.max(0, this.items().length - 1));
        this.selectDefaults();
        return true;
      }
      return animation;
    }
    if (this.stage !== "copying" || milliTimestamp() - this.last_poll < 100) return animation;
    this.last_poll = milliTimestamp();
    try {
      this.progress = (await conn.call("onboarding.status", { operation: this.operation })).progress;
      if (this.progress.phase === "complete") this.stage = "complete";
    } catch (error) {
      this.message = (error as Error).message;
    }
    return true;
  }
  selectDefaults() {
    if (this.selection_initialized || !this.worker()?.done) return;
    this.selection_initialized = true;
    if (this.source === "tmux") for (let i = 0; i < Math.min(3, this.items().length); i++) this.selected[i] = true;
  }
  preview(ws: catalog.Workspace, index: number) {
    return new WorkspacePreview(ws, this.stage === "choose", this.expanded[index]);
  }
  toggleExpanded(index: number) {
    const list = this.items();
    if (index >= list.length || this.preview(list[index], index).toggle_row === null) return;
    const row = list.slice(0, index).reduce((n, w, i) => n + this.preview(w, i).rows, 0);
    this.expanded[index] = !this.expanded[index];
    this.scroll = row;
    this.reveal_cursor = false;
  }
  /** Moves the cursor a row, past either end to the other when `wrap`. Herdr's
   * handoff switch is the first row; the workspaces follow. */
  move(next: boolean, wrap: boolean) {
    const above = this.source === "herdr" ? 1 : 0,
      rows = above + this.items().length;
    this.reveal_cursor = true;
    if (rows === 0) return;
    const at = this.switch_focused ? 0 : this.cursor + above,
      to = wrap ? (at + (next ? 1 : rows - 1)) % rows : clamp(at + (next ? 1 : -1), 0, rows - 1);
    // The workspace cursor stays put on the switch: it names the session to hand off.
    this.switch_focused = above === 1 && to === 0;
    if (!this.switch_focused) this.cursor = to - above;
  }
  /** The keys both hosts share: Space or X selects the row under the cursor,
   * E expands, H switches Herdr's handoff and R scans again. False for any
   * other key. */
  key(b: number): boolean {
    if ((b === 32 || b === 120) && this.switch_focused) this.handoff = !this.handoff;
    else if (b === 32 || b === 120) {
      if (this.items().length && !this.activeHandoff()) this.selected[this.cursor] = !this.selected[this.cursor];
    } else if (b === 101 || b === 69) this.toggleExpanded(this.cursor);
    else if (b === 104 && this.source === "herdr") this.handoff = !this.handoff;
    else if (b === 114) this.refresh();
    else return false;
    return true;
  }
  /** What a click on `area` at (x, y) lands on. */
  hit(area: Rect, x: number, y: number): Hit | null {
    if (this.stage !== "choose" || !area.contains(x, y)) return null;
    const ry = y - area.y;
    if (ry === 0 && this.source === "herdr") return { handoff: true };
    if (ry < tree_top) return null;
    let row = 0;
    for (const [i, ws] of this.items().entries()) {
      const p = this.preview(ws, i);
      if (row >= this.scroll && ry === tree_top + row - this.scroll) return { select: i };
      if (
        p.toggle_row !== null &&
        row + p.toggle_row >= this.scroll &&
        ry === tree_top + row + p.toggle_row - this.scroll
      )
        return { expand: i };
      row += p.rows;
    }
    return null;
  }
  click(hit: Hit) {
    this.switch_focused = "handoff" in hit;
    if ("handoff" in hit) this.handoff = !this.handoff;
    else if ("expand" in hit) this.toggleExpanded(hit.expand);
    else {
      this.cursor = hit.select;
      if (!this.activeHandoff()) this.selected[hit.select] = !this.selected[hit.select];
    }
  }
  cmuxConfused() {
    return this.source === "cmux" && !!this.worker()?.done && !!this.worker()?.catalog.confused;
  }
  /** The line under the heading: what the source offers, or how the copy goes. */
  summary(): string {
    switch (this.stage) {
      case "choose":
        return {
          tmux: "Copy sessions, scrollback and commands. Source processes stay in tmux.",
          herdr: "Choose a session to bring into Corgi.",
          cmux: "Copy workspaces and surfaces. Source processes stay in cmux.",
        }[this.source];
      case "copying":
        return this.progress.message;
      case "complete":
        return this.activeHandoff() ? "Your processes are running in Corgi." : "Your workspaces are ready.";
    }
  }
  /** The line under Herdr's handoff switch. */
  private handoffNote(): string {
    if (!this.handoff) return "Copies the workspaces; their processes stay in Herdr.";
    if (this.items().length === 0) return "Keeps your processes running.";
    if (!this.activeHandoff()) return "Live handoff unavailable for this session; turn it off to copy.";
    return `All ${this.selectionCount()} workspaces in this session move together.`;
  }
  /** The heading while copying. */
  heading(): string {
    return this.activeHandoff() ? "Handing off to Corgi" : "Copying into Corgi";
  }
  /** The notes and the tree; the cursor shows only when `focused`. */
  draw(w: Writer, area: Rect, focused: boolean) {
    if (this.stage === "choose") this.selectDefaults();
    this.drawNotes(w, area, focused);
    this.drawTree(w, area, focused);
  }
  private drawNotes(w: Writer, area: Rect, focused: boolean) {
    if (this.stage === "choose") {
      if (this.source === "herdr") {
        // Setup's on/off row, across the whole width, with a line under its name.
        settingRow.drawToggle(w, area.x - 2, area.y, area.w + 3, {
          label: "Handoff processes",
          on: this.handoff,
          here: focused && this.switch_focused,
        });
        const unavailable = this.handoff && this.items().length > 0 && !this.activeHandoff();
        put(w, area, 4, 1, this.handoffNote(), unavailable ? warm : dim);
      } else if (!this.cmuxConfused()) {
        // One line where it fits, else a row for each part.
        const tip =
          this.source === "cmux"
            ? ["Visible splits first", "remaining surfaces in additional tabs"]
            : ["Up to 3 recent groups selected", "Return in each pane restarts its command"];
        if (displayWidth(tip.join(" · ")) <= area.w) put(w, area, 0, 0, tip.join(" · "), dim);
        else tip.forEach((part, i) => put(w, area, 0, i, part, dim));
      }
    } else {
      const status =
        this.stage === "complete"
          ? "[✓] Complete"
          : this.failed()
            ? "[!] Import stopped · Enter returns to selection"
            : "[···] Working";
      put(w, area, 0, 0, status, bright);
    }
    if (this.cmuxConfused()) {
      const y = this.stage === "choose" ? 0 : 1;
      put(w, area, 0, y, this.blink_closed ? "ᐱ─ᴥ─ᐱ" : "ᐱoᴥ°ᐱ", text);
      put(w, area, 7, y, "I'm confused by this cmux version.", warm);
      put(
        w,
        area,
        7,
        y + 1,
        this.stage === "complete" ? "Imported what I could. See details below." : "I'll bring over what I can.",
        dim,
      );
    }
  }
  private drawTree(w: Writer, area: Rect, focused: boolean) {
    const choosing = this.stage === "choose",
      wk = this.worker();
    if (wk) {
      if (!wk.done) put(w, area, 2, tree_top + 1, "Looking for running sessions…", dim);
      else if (this.items().length === 0) {
        const empty = this.cmuxConfused()
          ? "No workspaces could be recovered yet."
          : wk.catalog.message.length > 0
            ? "Couldn't read this source. R retries."
            : "No available sessions found.";
        put(w, area, 2, tree_top + 1, empty, text);
        put(w, area, 2, tree_top + 3, wk.catalog.message, dim);
      }
    }
    let row = 0;
    let cursor_row = 0;
    this.items().forEach((ws, i) => {
      if (!choosing && !this.chosen(i)) return;
      if (i === this.cursor) cursor_row = row;
      row += this.preview(ws, i).rows;
    });
    const capacity = area.h - tree_top;
    if (choosing && this.reveal_cursor) {
      this.reveal_cursor = false;
      if (cursor_row < this.scroll) this.scroll = cursor_row;
      if (cursor_row >= this.scroll + capacity) this.scroll = cursor_row - capacity + 1;
    }
    this.scroll = Math.min(this.scroll, sat(row, capacity));
    // The thumb rides the border just right of the area.
    const bar = scrollThumb.thumb(capacity, row, this.scroll);
    if (bar)
      for (let k = bar.start; k < bar.start + bar.len; k++)
        w.write(`\x1b[${area.y + tree_top + k + 1};${area.x + area.w + 2}H${dim}┃`);
    const line = (label: string, style: string, hint: string) => {
      if (row >= this.scroll && row - this.scroll < capacity) {
        const y = area.y + tree_top + row - this.scroll,
          hint_x = area.w - Math.min(30, Math.floor(area.w / 2));
        w.write(`\x1b[${y + 1};${area.x + 1}H${style}`);
        writeSanitized(w, label, hint.length > 0 ? hint_x - 2 : area.w - 2);
        if (hint.length > 0) put(w, area, hint_x, y - area.y, hint, muted);
      }
      row += 1;
    };
    row = 0;
    let pane_number = 0;
    const handoff = this.activeHandoff();
    this.items().forEach((ws, i) => {
      if (!choosing && !this.chosen(i)) return;
      const preview_layout = this.preview(ws, i);
      const cursor_mark = i === this.cursor && choosing && focused && !this.switch_focused ? "›" : " ";
      const check_mark = this.chosen(i) ? "[x]" : "[ ]";
      line(`${cursor_mark}${check_mark} ${short(ws.name)}`, bright, "");
      if (ws.recovery !== "full") {
        if (ws.recovery === "workspace") line("    Workspace only · opens a new shell", warm, "");
        line(`    ${ws.recovery_note}`, warm, "");
      }
      if (preview_layout.toggle_row !== null && preview_layout.hidden === 0) line("    ▾ Show less", bright, "");
      let remaining = preview_layout.pane_limit;
      for (const [tab_index, tab] of ws.tabs.entries()) {
        if (remaining === 0) break;
        const visible = Math.min(remaining, tab.panes.length);
        remaining -= visible;
        const last_tab = tab_index + 1 === ws.tabs.length;
        const branch = last_tab ? "└─" : "├─";
        if (tab.panes.length === 1) {
          const pane = tab.panes[0];
          const done = !choosing && pane_number < this.progress.completed;
          line(
            `    ${branch} ${short(tab.name)} · ${done ? "✓ " : ""}${short(pane.name)}`,
            text,
            paneAnnotation(this.source, handoff, pane),
          );
          pane_number += 1;
          continue;
        }
        line(`    ${branch} ${short(tab.name)}`, text, "");
        tab.panes.slice(0, visible).forEach((pane, pane_index) => {
          const rail = last_tab ? " " : "│";
          const twig = pane_index + 1 === tab.panes.length ? "└─" : "├─";
          const check = !choosing && pane_number < this.progress.completed ? "✓ " : "";
          line(`    ${rail}  ${twig} ${check}${short(pane.name)}`, text, paneAnnotation(this.source, handoff, pane));
          pane_number += 1;
        });
      }
      if (preview_layout.hidden > 0) line(`    …${preview_layout.hidden} more`, bright, "");
      row += 1;
    });
  }
}
let text: string, bright: string, muted: string, dim: string, warm: string;
palette.derived(() => {
  text = new palette.Style({ fg: "text", bg: "surface" }).sgr();
  bright = new palette.Style({ fg: "strong", bg: "surface", bold: true }).sgr();
  muted = new palette.Style({ fg: "muted", bg: "surface" }).sgr();
  dim = new palette.Style({ fg: "faint", bg: "surface" }).sgr();
  warm = new palette.Style({ fg: "warm", bg: "surface" }).sgr();
});
const short = (value: string) => byteSlice(value, 300);
function put(w: Writer, area: Rect, x: number, y: number, str: string, style: string) {
  if (x >= area.w || y >= area.h) return;
  w.write(`\x1b[${area.y + y + 1};${area.x + x + 1}H${style}`);
  writeSanitized(w, str, area.w - x);
}
function paneAnnotation(source: catalog.Source, handoff: boolean, pane: catalog.Pane): string {
  if (source === "tmux") return "";
  if (handoff) {
    if (pane.pid != null && pane.pid > 0) return `${String(pane.pid).padStart(7)} · Herdr → Corgi`;
    return "      ? · Herdr → Corgi";
  }
  return pane.url ? "↗ Browser link" : pane.resume_available ? "↻ Resume available" : "+ New shell";
}
