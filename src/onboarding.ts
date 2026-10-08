//! Viewer-owned cell-based onboarding wizard.
import { randomBytes } from "node:crypto";
import { n } from "./native_bridge";
import { BoundedText } from "./bounded_text";
import { Writer, byteSlice, sat, utf8Size, writeEllipsis } from "./text";
import { milliTimestamp } from "./clock";
import type { Action } from "./action";
import * as km from "./keymap";
import * as keys from "./keys";
import * as bindings from "./bindings";
import * as palette from "./palette";
import * as catalog from "./import/catalog";
import * as herdr from "./import/herdr";
import { Rect } from "./layout";
import type { Connection } from "./rpc";
import * as shortcut_help from "./shortcut_help";
import * as ghostty_integration from "./ghostty_integration";
export type Step = "presets" | "keymap" | "connect" | "import" | "progress" | "complete";
export type Mode = "welcome" | "keyboard" | "import";
const Message = BoundedText(256);
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
export class State {
  preset: km.Preset = "corgi";
  prefix: km.Prefix = "ctrl_b";
  step: Step = "presets";
  source: catalog.Source = "tmux";
  source_initialized = false;
  help = new shortcut_help.State();
  workers = new Map<catalog.Source, catalog.Worker>();
  selected = Array(256).fill(false);
  expanded = Array(256).fill(false);
  cursor = 0;
  scroll = 0;
  reveal_cursor = false;
  handoff = true;
  focus = 0;
  progress: any = {
    phase: "idle",
    completed: 0,
    total: 0,
    workspace: null,
    message: "",
  };
  message = new Message();
  last_poll = 0;
  blink_closed = false;
  scan_finished = false;
  selection_initialized = false;
  operation = 0n;
  mode: Mode = "welcome";
  dismissable = false;
  cancelled = false;
  static start(mode: Mode, preset: km.Preset, prefix: km.Prefix) {
    const state = new State();
    state.mode = mode;
    state.preset = preset;
    state.prefix = prefix;
    state.dismissable = true;
    if (mode === "import") state.enterImport();
    return state;
  }
  cancel() {
    this.cancelled = true;
    return true;
  }
  deinit() {
    for (const worker of this.workers.values()) worker.deinit();
    this.workers.clear();
  }
  fail(error: Error | string) {
    this.setMessage(typeof error === "string" ? error : error.message);
  }
  setMessage(msg: string) {
    this.message = new Message(msg);
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
        this.fail(error as Error);
      }
  }
  changeSource(source: catalog.Source) {
    if (!catalog.available_sources.includes(source)) return;
    this.operation = 0n;
    this.source = source;
    this.cursor = 0;
    this.scroll = 0;
    this.selected.fill(false);
    this.expanded.fill(false);
    this.selection_initialized = false;
    this.message = new Message();
    this.scan();
  }
  enterKeymap() {
    this.step = "keymap";
    this.help = new shortcut_help.State();
  }
  enterImport() {
    this.step = "import";
    this.focus = 0;
    if (!this.source_initialized) {
      this.source_initialized = true;
      this.source = herdr.detected()
        ? "herdr"
        : km.supportedPreset(this.preset) === "herdr"
          ? "herdr"
          : km.supportedPreset(this.preset) === "cmux"
            ? "cmux"
            : "tmux";
    }
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
  async begin(conn: Connection): Promise<boolean> {
    if (!this.selectionCount()) return this.mode === "import" ? this.cancel() : true;
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
    this.step = "progress";
    this.scroll = 0;
    this.message = new Message();
    this.progress = {
      phase: "connecting",
      completed: 0,
      total: 0,
      workspace: null,
      message: "",
    };
    this.last_poll = 0;
    return false;
  }
  async poll(conn: Connection): Promise<boolean> {
    const blink = this.cmuxConfused() && milliTimestamp() % 5000 >= 4850,
      animation = blink !== this.blink_closed;
    this.blink_closed = blink;
    if (this.step === "import") {
      if (!this.scan_finished && this.worker()?.done) {
        this.scan_finished = true;
        this.cursor = Math.min(this.cursor, Math.max(0, this.items().length - 1));
        this.selectDefaults();
        return true;
      }
      return animation;
    }
    if (this.step !== "progress" || milliTimestamp() - this.last_poll < 100) return animation;
    this.last_poll = milliTimestamp();
    try {
      this.progress = (await conn.call("onboarding.status", { operation: this.operation })).progress;
      if (this.progress.phase === "complete") this.step = "complete";
    } catch (error) {
      this.fail(error as Error);
    }
    return true;
  }
  selectDefaults() {
    if (this.selection_initialized || !this.worker()?.done) return;
    this.selection_initialized = true;
    if (this.source === "tmux") for (let i = 0; i < Math.min(3, this.items().length); i++) this.selected[i] = true;
  }
  preview(ws: catalog.Workspace, index: number) {
    return new WorkspacePreview(ws, this.step === "import", this.expanded[index]);
  }
  toggleExpanded(index: number) {
    const list = this.items();
    if (index >= list.length || this.preview(list[index], index).toggle_row === null) return;
    const row = list.slice(0, index).reduce((n, w, i) => n + this.preview(w, i).rows, 0);
    this.expanded[index] = !this.expanded[index];
    this.scroll = row;
    this.reveal_cursor = false;
  }
  async key(byte: number | string, conn: Connection): Promise<boolean> {
    const b = typeof byte === "string" ? byte.charCodeAt(0) : byte;
    if (this.step === "import") this.selectDefaults();
    this.preset = km.supportedPreset(this.preset);
    this.message = new Message();
    if (this.step === "presets") {
      const presets = km.available_presets,
        index = presets.indexOf(this.preset);
      if (b === 106 || b === 14) this.preset = presets[(index + 1) % presets.length];
      else if (b === 107 || b === 16) this.preset = presets[(index + presets.length - 1) % presets.length];
      else if (b >= 49 && b <= 52 && b - 49 < presets.length) this.preset = presets[b - 49];
      else if ([112, 80, 32].includes(b)) this.prefix = this.prefix === "ctrl_b" ? "ctrl_a" : "ctrl_b";
      else if (b === 63) this.enterKeymap();
      else if (b === 9) this.focus = (this.focus + 1) % 3;
      else if (b === 27 && this.dismissable) return this.cancel();
      else if (b === 13) {
        if (this.focus === 1) this.prefix = this.prefix === "ctrl_b" ? "ctrl_a" : "ctrl_b";
        else if (this.focus === 2) this.enterKeymap();
        else if (this.preset === "cmux") this.step = "connect";
        else if (this.mode === "keyboard") return true;
        else this.enterImport();
      }
    } else if (this.step === "keymap") {
      if (this.help.key(b)) this.step = "presets";
    } else if (this.step === "connect") {
      if (b === 27) this.step = "presets";
      else if (b === 112) {
        this.preset = "herdr";
        if (this.mode === "keyboard") return true;
        this.enterImport();
      } else if (b === 13) {
        if (ghosttyHost()) {
          ghostty_integration.sync({ preset: "cmux", prefix: this.prefix });
          if (this.mode === "keyboard") return true;
          this.enterImport();
          this.setMessage("Reload Ghostty: Cmd+Shift+, to apply Command keys.");
        } else this.setMessage("Press P for portable Herdr prefix keys, or Esc to choose again.");
      }
    } else if (this.step === "import") {
      if (b === 115 || b === 83) return this.mode === "import" ? this.cancel() : true;
      if (b === 27) {
        if (this.mode === "import") return this.cancel();
        this.step = "presets";
      } else if (b >= 49 && b <= 51) this.changeSource((["tmux", "herdr", "cmux"] as catalog.Source[])[b - 49]);
      else if (b === 104 && this.source === "herdr") this.handoff = !this.handoff;
      else if (b === 114) {
        const worker = this.worker();
        if (worker && !worker.done) return false;
        worker?.deinit();
        this.workers.delete(this.source);
        this.selected.fill(false);
        this.expanded.fill(false);
        this.selection_initialized = false;
        this.scan();
      } else if (b === 106 || b === 14) {
        this.cursor = Math.min(this.cursor + 1, Math.max(0, this.items().length - 1));
        this.reveal_cursor = true;
      } else if (b === 107 || b === 16) {
        this.cursor = Math.max(0, this.cursor - 1);
        this.reveal_cursor = true;
      } else if ((b === 32 || b === 120) && this.items().length && !this.activeHandoff())
        this.selected[this.cursor] = !this.selected[this.cursor];
      else if (b === 101 || b === 69) this.toggleExpanded(this.cursor);
      else if (b === 9) this.focus = (this.focus + 1) % 2;
      else if (b === 13) return this.begin(conn);
    } else if (this.step === "progress") {
      if (this.progress.phase === "failed" && (b === 27 || b === 13)) {
        this.step = "import";
        this.operation = 0n;
        this.setMessage(this.progress.message);
      }
    } else if (this.step === "complete" && b === 13) return true;
    return false;
  }
  async sequence(seq: string, conn: Connection): Promise<boolean> {
    if (this.step === "keymap") {
      this.help.sequence(seq);
      return false;
    }
    const key = keys.parse(seq);
    if (key === "up") return this.key(16, conn);
    if (key === "down") return this.key(14, conn);
    if (key === "page_up") this.scroll = Math.max(0, this.scroll - 5);
    if (key === "page_down") this.scroll += 5;
    if (this.step === "import" && (seq === "\x1b[C" || seq === "\x1b[D")) {
      const sources = catalog.available_sources,
        delta = seq[2] === "C" ? 1 : sources.length - 1;
      this.changeSource(sources[(sources.indexOf(this.source) + delta) % sources.length]);
    }
    return false;
  }
  async click(cols: number, rows: number, x: number, y: number, conn: Connection): Promise<boolean> {
    if (this.step === "keymap") {
      if (shortcut_help.State.closeAt(cols, rows, x, y)) this.step = "presets";
      if (shortcut_help.State.corgiAt(cols, rows, x, y)) this.help.play(milliTimestamp());
      return false;
    }
    const b = bounds(cols, rows);
    if (!b.contains(x, y) || b.w < 76 || b.h < 26) return false;
    const rx = x - b.x,
      ry = y - b.y;
    if (ry === b.h - 3) {
      if (this.step === "presets") this.focus = 0;
      if (rx < 15 && (this.step !== "presets" || this.dismissable)) return this.key(27, conn);
      return this.key(13, conn);
    }
    if (this.step === "presets") {
      const layout = presetLayout(b);
      for (const [i, card] of layout.cards.entries())
        if (card.contains(x, y)) {
          this.preset = km.available_presets[i];
          this.focus = 0;
          return false;
        }
      if (this.preset !== "cmux" && layout.prefix.contains(x, y)) return this.key("p", conn);
      if (ry === layout.help_y && rx >= layout.detail_x) {
        if (rx < layout.detail_x + 20) return this.key("?", conn);
        if (this.preset === "cmux") return this.key("p", conn);
      }
    } else if (this.step === "import") {
      if (ry === 6 && rx >= b.w - 23) return this.key("s", conn);
      if (ry === 6 && rx >= 3 && rx < 3 + 14 * catalog.available_sources.length)
        return this.key(49 + Math.floor((rx - 3) / 14), conn);
      if (ry === 8 && this.source === "herdr") return this.key("h", conn);
      if (ry < 11 || ry >= b.h - 5) return false;
      let row = 0;
      for (const [i, ws] of this.items().entries()) {
        const p = this.preview(ws, i);
        if (row >= this.scroll && ry === 11 + row - this.scroll) {
          this.cursor = i;
          if (!this.activeHandoff()) this.selected[i] = !this.selected[i];
          break;
        }
        if (
          p.toggle_row !== null &&
          row + p.toggle_row >= this.scroll &&
          ry === 11 + row + p.toggle_row - this.scroll
        ) {
          this.toggleExpanded(i);
          break;
        }
        row += p.rows;
      }
    }
    return false;
  }
  cmuxConfused() {
    return (
      this.source === "cmux" &&
      ["import", "progress", "complete"].includes(this.step) &&
      !!this.worker()?.done &&
      !!this.worker()?.catalog.confused
    );
  }
  frame(cols: number, rows: number): string {
    if (this.step === "import") this.selectDefaults();
    this.preset = km.supportedPreset(this.preset);
    if (this.step === "keymap")
      return this.help.frame(cols, rows, this.preset, this.prefix, milliTimestamp(), "default");
    const w = new Writer();
    w.write(new palette.Style({ bg: "bg" }).sgr() + "\x1b[2J\x1b[?25l");
    const b = bounds(cols, rows);
    if (b.w < 76 || b.h < 26) {
      w.write("\x1b[H" + palette.fg("text") + "Welcome to Corgi. Enlarge the terminal to 76 × 26 to continue.");
      return w.buffered();
    }
    box(w, b, false);
    put(
      w,
      b,
      2,
      0,
      { welcome: " Welcome to Corgi ", keyboard: " Keyboard shortcuts ", import: " Import sessions " }[this.mode],
      bright,
    );
    put(
      w,
      b,
      3,
      2,
      {
        presets: "Which shortcuts feel like home?",
        keymap: "Your shortcuts",
        connect: "Connect your Command keys",
        import: "Bring your work along",
        progress: this.activeHandoff() ? "Handing off to Corgi" : "Copying into Corgi",
        complete: this.mode === "import" ? "Import complete" : "You're ready to go",
      }[this.step],
      bright,
    );
    put(
      w,
      b,
      3,
      3,
      {
        presets: "Choose familiar keys.",
        keymap: "",
        connect: "Your host terminal needs to forward these shortcuts.",
        import: {
          tmux: "Copy sessions, scrollback and commands. Source processes stay in tmux.",
          herdr: "Choose a session to bring into Corgi.",
          cmux: "Copy workspaces and surfaces. Source processes stay in cmux.",
        }[this.source],
        progress: this.progress.message,
        complete: this.activeHandoff() ? "Your processes are running in Corgi." : "Your workspaces are ready.",
      }[this.step],
      dim,
    );
    switch (this.step as Step) {
      case "presets":
        drawPresets(w, b, this);
        break;
      case "keymap":
        break;
      case "connect":
        put(w, b, 5, 7, ghosttyHost() ? "Ghostty / macOS" : "Command forwarding is not confirmed", bright);
        put(w, b, 5, 10, ghosttyHost() ? "[ Connect and continue ]" : "[ P Use Herdr prefix keys ]", bright);
        put(w, b, 5, 13, "Ghostty setup changes shortcuts in every Ghostty window.", text);
        put(w, b, 5, 15, "Cmd+T/D/W, workspace numbers and related bindings replace host actions.", dim);
        put(w, b, 5, 17, "Reload Ghostty with Cmd+Shift+, after connecting.", dim);
        put(w, b, 5, 20, "P  Continue with portable Herdr keys", bright);
        break;
      default:
        this.drawImport(w, b);
    }
    if (this.message.len > 0)
      put(
        w,
        b,
        3,
        b.h - ((this.step as Step) === "presets" || (this.step as Step) === "keymap" ? 4 : 5),
        this.message.text(),
        warm,
      );
    put(w, b, 3, b.h - 3, footerHint(this), dim);
    let cta: string;
    switch (this.step as Step) {
      case "presets":
        cta = this.mode === "keyboard" && this.preset !== "cmux" ? "[ Enter Save ]" : "[ Enter Continue → ]";
        break;
      case "keymap":
        cta = "[ Enter Back ]";
        break;
      case "connect":
        cta = "[ Enter Connect → ]";
        break;
      case "import":
        cta =
          this.selectionCount() === 0
            ? this.mode === "import"
              ? "[ Enter Close ]"
              : "[ Enter Skip import → ]"
            : this.activeHandoff()
              ? "[ Enter Handoff → ]"
              : "[ Enter Import → ]";
        break;
      case "progress":
        cta = this.progress.phase === "failed" ? "[ Enter Back ]" : "[ Importing… ]";
        break;
      case "complete":
        cta = this.mode === "import" ? "[ Enter Done ]" : "[ Enter Open Corgi → ]";
        break;
    }
    put(w, b, sat(b.w, 27), b.h - 3, cta, this.step === "presets" && this.focus === 0 ? palette.keycap : bright);
    put(
      w,
      b,
      3,
      b.h - 2,
      this.step === "import" ? "←→ sources · ↑↓ choose · PgUp/PgDn scroll · R refresh · S skip" : "",
      dim,
    );
    w.write("\x1b[0m");
    return w.buffered();
  }
  private drawImport(w: Writer, b: Rect) {
    if (this.step === "import") {
      catalog.available_sources.forEach((source, i) => {
        put(w, b, 3 + i * 14, 6, `[ ${i + 1} ${source} ]`, source === this.source ? bright : dim);
      });
      put(w, b, sat(b.w, 23), 6, "[ S Skip import ]", dim);
      if (this.source === "herdr") {
        if (this.handoff && this.items().length > 0 && !this.activeHandoff())
          put(w, b, 3, 9, "Live handoff unavailable for this Herdr session; H switches to copy.", warm);
        if (this.activeHandoff())
          put(w, b, 3, 9, `All ${this.selectionCount()} workspaces in this session move together.`, dim);
        put(
          w,
          b,
          3,
          8,
          this.handoff
            ? "[● ON ] Handoff processes  Keep your processes running"
            : "[  OFF] Handoff processes  Keep your processes running",
          bright,
        );
      } else if (!this.cmuxConfused())
        put(
          w,
          b,
          3,
          8,
          this.source === "cmux"
            ? "Visible splits first · remaining surfaces in additional tabs"
            : "Up to 3 recent groups selected · Return in each pane restarts its command",
          dim,
        );
    } else {
      put(w, b, 3, 6, `${this.progress.phase}  ${this.progress.completed}/${this.progress.total}`, text);
      const status =
        this.step === "complete"
          ? "[✓] Complete"
          : this.progress.phase === "failed"
            ? "[!] Import stopped · Enter returns to selection"
            : "[···] Working";
      put(w, b, 3, 8, status, bright);
    }
    if (this.cmuxConfused()) {
      const y = this.step === "import" ? 8 : 9;
      put(w, b, 3, y, this.blink_closed ? "ᐱ─ᴥ─ᐱ" : "ᐱoᴥ°ᐱ", text);
      put(w, b, 10, y, "I'm confused by this cmux version.", warm);
      put(
        w,
        b,
        10,
        y + 1,
        this.step === "complete" ? "Imported what I could. See details below." : "I'll bring over what I can.",
        dim,
      );
    }
    const wk = this.worker();
    if (wk) {
      if (!wk.done) put(w, b, 5, 12, "Looking for running sessions…", dim);
      else if (this.items().length === 0) {
        const empty = this.cmuxConfused()
          ? "No workspaces could be recovered yet."
          : wk.catalog.message.length > 0
            ? "Couldn't read this source. R retries; S skips import."
            : "No available sessions found. Continue without importing.";
        put(w, b, 5, 12, empty, text);
        put(w, b, 5, 14, wk.catalog.message, dim);
      }
    }
    let row = 0;
    let cursor_row = 0;
    this.items().forEach((ws, i) => {
      if (this.step !== "import" && !this.chosen(i)) return;
      if (i === this.cursor) cursor_row = row;
      row += this.preview(ws, i).rows;
    });
    const capacity = b.h - 16;
    if (this.step === "import" && this.reveal_cursor) {
      this.reveal_cursor = false;
      if (cursor_row < this.scroll) this.scroll = cursor_row;
      if (cursor_row >= this.scroll + capacity) this.scroll = cursor_row - capacity + 1;
    }
    this.scroll = Math.min(this.scroll, sat(row, capacity));
    row = 0;
    let pane_number = 0;
    const handoff = this.activeHandoff();
    this.items().forEach((ws, i) => {
      if (this.step !== "import" && !this.chosen(i)) return;
      const preview_layout = this.preview(ws, i);
      const cursor_mark = i === this.cursor && this.step === "import" ? "›" : " ";
      const check_mark = this.chosen(i) ? "[x]" : "[ ]";
      treeLine(w, b, row, this.scroll, `${cursor_mark}${check_mark} ${short(ws.name)}`, bright, "");
      row += 1;
      if (ws.recovery !== "full") {
        if (ws.recovery === "workspace") {
          treeLine(w, b, row, this.scroll, "    Workspace only · opens a new shell", warm, "");
          row += 1;
        }
        treeLine(w, b, row, this.scroll, `    ${ws.recovery_note}`, warm, "");
        row += 1;
      }
      if (preview_layout.toggle_row !== null && preview_layout.hidden === 0) {
        treeLine(w, b, row, this.scroll, "    ▾ Show less", bright, "");
        row += 1;
      }
      let remaining = preview_layout.pane_limit;
      for (const [tab_index, tab] of ws.tabs.entries()) {
        if (remaining === 0) break;
        const visible = Math.min(remaining, tab.panes.length);
        remaining -= visible;
        const last_tab = tab_index + 1 === ws.tabs.length;
        const branch = last_tab ? "└─" : "├─";
        if (tab.panes.length === 1) {
          const pane = tab.panes[0];
          const done = this.step !== "import" && pane_number < this.progress.completed;
          const label = `    ${branch} ${short(tab.name)} · ${done ? "✓ " : ""}${short(pane.name)}`;
          treeLine(w, b, row, this.scroll, label, text, paneAnnotation(this.source, handoff, pane));
          row += 1;
          pane_number += 1;
          continue;
        }
        treeLine(w, b, row, this.scroll, `    ${branch} ${short(tab.name)}`, text, "");
        row += 1;
        tab.panes.slice(0, visible).forEach((pane, pane_index) => {
          const annotation = paneAnnotation(this.source, handoff, pane);
          const rail = last_tab ? " " : "│";
          const twig = pane_index + 1 === tab.panes.length ? "└─" : "├─";
          const check = this.step !== "import" && pane_number < this.progress.completed ? "✓ " : "";
          treeLine(w, b, row, this.scroll, `    ${rail}  ${twig} ${check}${short(pane.name)}`, text, annotation);
          row += 1;
          pane_number += 1;
        });
      }
      if (preview_layout.hidden > 0) {
        treeLine(w, b, row, this.scroll, `    …${preview_layout.hidden} more`, bright, "");
        row += 1;
      }
      row += 1;
    });
  }
}
export function bounds(cols: number, rows: number): Rect {
  const w = Math.min(cols, 112),
    h = Math.min(rows, 36);
  return new Rect(Math.floor((cols - w) / 2), Math.floor((rows - h) / 2), w, h);
}
const border = new palette.Style({ fg: "line", bg: "surface" }).sgr(),
  text = new palette.Style({ fg: "text", bg: "surface" }).sgr(),
  bright = new palette.Style({ fg: "strong", bg: "surface", bold: true }).sgr(),
  muted = new palette.Style({ fg: "muted", bg: "surface" }).sgr(),
  dim = new palette.Style({ fg: "faint", bg: "surface" }).sgr(),
  warm = new palette.Style({ fg: "warm", bg: "surface" }).sgr(),
  selected_style = new palette.Style({ fg: "text", bg: "selected" }).sgr();
const short = (value: string) => byteSlice(value, 300);
function safeText(w: Writer, value: string, room: number) {
  let clean = "";
  let n = 0;
  for (const ch of value) {
    if (n >= 2048 - 4) break;
    const cp = ch.codePointAt(0)!;
    // Lone surrogates stand in for invalid UTF-8.
    const invalid = cp >= 0xd800 && cp <= 0xdfff;
    if (invalid || cp < 32 || cp === 127) {
      clean += " ";
      n += 1;
      continue;
    }
    clean += ch;
    n += utf8Size(cp);
  }
  writeEllipsis(w, clean, room);
}
function put(w: Writer, b: Rect, x: number, y: number, str: string, style: string) {
  if (x >= b.w - 1 || (y >= b.h - 1 && y !== 0)) return;
  w.write(`\x1b[${b.y + y + 1};${b.x + x + 1}H${style}`);
  safeText(w, str, b.w - x - 2);
}
function box(w: Writer, b: Rect, on: boolean) {
  for (let row = 0; row < b.h; row++) {
    w.write(`\x1b[${b.y + row + 1};${b.x + 1}H${on ? selected_style : border}`);
    w.write(row === 0 ? "╭" : row === b.h - 1 ? "╰" : "│");
    if (row === 0 || row === b.h - 1) w.write("─".repeat(b.w - 2));
    else w.splat(" ", b.w - 2);
    w.write(row === 0 ? "╮" : row === b.h - 1 ? "╯" : "│");
  }
}
function treeLine(w: Writer, b: Rect, row: number, scroll: number, label: string, style: string, hint: string) {
  if (row < scroll || row - scroll >= b.h - 16) return;
  const y = 11 + row - scroll;
  const split = sat(b.w, 32);
  w.write(`\x1b[${b.y + y + 1};${b.x + 4}H${style}`);
  safeText(w, label, hint.length > 0 ? split - 5 : b.w - 7);
  if (hint.length > 0) put(w, b, split, y, hint, muted);
}
function footerHint(s: State): string {
  switch (s.step) {
    case "presets":
      return s.dismissable ? "Esc close · ↑↓ choose · P prefix · ? keymap" : "↑↓ choose · P prefix · ? keymap";
    case "keymap":
      return "";
    case "connect":
    case "progress":
      return "Esc Back";
    case "import":
      return s.source === "herdr"
        ? "Esc · Space select · E expand · H handoff"
        : s.mode === "import"
          ? "Esc close · Space select · E expand"
          : "Esc Back · Space select · E expand";
    case "complete":
      return "";
  }
}
function recoveryRows(ws: catalog.Workspace): number {
  return ws.recovery === "full" ? 0 : ws.recovery === "workspace" ? 2 : 1;
}
function paneAnnotation(source: catalog.Source, handoff: boolean, pane: catalog.Pane): string {
  if (source === "tmux") return "";
  if (handoff) {
    if (pane.pid != null && pane.pid > 0) return `${String(pane.pid).padStart(7)} · Herdr → Corgi`;
    return "      ? · Herdr → Corgi";
  }
  return pane.url ? "↗ Browser link" : pane.resume_available ? "↻ Resume available" : "+ New shell";
}
// Rendering and mouse hit regions share one layout at every supported size.
export function presetLayout(b: Rect) {
  const compact = b.h < 32;
  const card_w = b.w >= 100 ? 32 : 24;
  const x = card_w + 7;
  const width = b.w - x - 4;
  const hero_h = compact ? 3 : 6;
  const prefix_h = width < 64 ? 4 : 3;
  const panes_y = 6 + hero_h + prefix_h;
  const panes_h = compact ? 6 : 7;
  const split_w = Math.floor((width - 2) / 2);
  const summary_y = panes_y + panes_h + (compact ? 0 : 1);
  return {
    cards: km.available_presets.map((_, i) => new Rect(b.x + 3, b.y + 6 + i * 4, card_w, 4)),
    hero: new Rect(b.x + x, b.y + 6 + prefix_h, width, hero_h),
    prefix: new Rect(b.x + x, b.y + 6, width, prefix_h),
    split: new Rect(b.x + x, b.y + panes_y, split_w, panes_h),
    focus: new Rect(b.x + x + split_w + 2, b.y + panes_y, width - split_w - 2, panes_h),
    detail_x: x,
    summary_y,
    help_y: summary_y + (compact ? 2 : 3),
  };
}
/** An action's key on a card. Under cmux, whose cards teach held keys, a
 * prefixed key names the prefix too. */
function cardKey(s: State, act: Action): string {
  const b = bindings.find(s.preset, act);
  if (!b) return "";
  return (s.preset === "cmux" && b.prefixed ? km.prefixName(s.prefix) + " " : "") + bindings.compact(b);
}
const action = (name: string, value?: string) => (value === undefined ? { name } : { name, value }) as Action;
function drawPresets(w: Writer, b: Rect, s: State) {
  const layout = presetLayout(b);
  const direct = s.preset === "cmux";
  const prefix_name = km.prefixName(s.prefix);
  km.available_presets.forEach((preset, i) => {
    const card = layout.cards[i];
    const picked = s.preset === preset;
    box(w, card, picked);
    const dot = picked ? "●" : "○";
    const paw = preset === "corgi" ? "🐕 " : "";
    put(w, card, 2, 1, `${dot} ${paw}${km.name(preset)}`, picked ? selected_style : bright);
    const description =
      card.w >= 32
        ? km.description(preset)
        : { corgi: "Made for Corgi", tmux: "Classic splits", herdr: "Home row", cmux: "Command keys" }[preset];
    put(w, card, 4, 2, description, picked ? selected_style : dim);
  });

  const hero = layout.hero;
  const narrow = hero.w < 64;
  box(w, hero, false);
  put(w, hero, 2, 0, narrow || hero.h === 3 ? " New tab → agent picker " : " New tab ", bright);
  const key_y = hero.h === 3 ? 1 : 2;
  put(w, hero, 3, key_y, `[ ${direct ? "Cmd" : prefix_name} ]`, palette.keycap);
  put(w, hero, direct ? 11 : 15, key_y, direct ? "+" : "then", text);
  put(w, hero, direct ? 15 : 22, key_y, `[ ${cardKey(s, action("new"))} ]`, bright);
  if (hero.h > 3) {
    if (narrow) {
      put(w, hero, 3, key_y + 2, "Choose an agent or terminal", text);
    } else {
      put(w, hero, 36, key_y, "Open the agent picker", text);
      put(w, hero, 36, key_y + 1, "Agent or new terminal", dim);
    }
  }

  const band = layout.prefix;
  box(w, band, false);
  put(w, band, 2, 1, direct ? "MODIFIER" : "PREFIX", bright);
  put(w, band, 12, 1, `[ ${direct ? "Cmd" : prefix_name} ]`, palette.keycap);
  const explanation = direct ? "Hold with the action key." : "Release, then press a key.";
  if (narrow) put(w, band, 2, 2, explanation, text);
  else put(w, band, 24, 1, explanation, text);
  if (!direct) put(w, band, band.w - 14, 1, "[ P change ]", s.focus === 1 ? palette.keycap : bright);

  const split = layout.split;
  box(w, split, false);
  put(w, split, 2, 0, " Split ", bright);
  const diagram_y = split.h === 6 ? 1 : 2;
  const diagram_w = split.w < 28 ? 5 : 9;
  const left_x = 2;
  const right_x = Math.floor(split.w / 2) + 1;
  drawSplitDiagram(w, new Rect(split.x + left_x, split.y + diagram_y, diagram_w, 3), false);
  drawSplitDiagram(w, new Rect(split.x + right_x, split.y + diagram_y, diagram_w, 3), true);
  put(w, split, left_x, diagram_y + 3, `${cardKey(s, action("split", "right"))} Right`, bright);
  put(w, split, right_x, diagram_y + 3, `${cardKey(s, action("split", "down"))} Down`, bright);

  const focus = layout.focus;
  box(w, focus, false);
  put(w, focus, 2, 0, " Focus pane ", bright);
  const nav_y = focus.h === 6 ? 1 : 2;
  put(
    w,
    focus,
    2,
    nav_y,
    direct ? "[ Cmd+Option ]" : s.preset === "tmux" ? "Arrow keys" : "Home row",
    direct ? palette.keycap : dim,
  );
  const nav_x = Math.floor((focus.w - 17) / 2);
  put(w, focus, nav_x + 6, nav_y + 1, `[ ${cardKey(s, action("focus", "up"))} ]`, bright);
  put(
    w,
    focus,
    nav_x,
    nav_y + 2,
    `[ ${cardKey(s, action("focus", "left"))} ] [ ${cardKey(s, action("focus", "down"))} ] [ ${cardKey(s, action("focus", "right"))} ]`,
    bright,
  );

  // The Command band applies to all direct keys; detach uses the portable prefix.
  const detail = new Rect(b.x + layout.detail_x, b.y, hero.w, b.h);
  const col = Math.floor(detail.w / 3);
  put(w, detail, 0, layout.summary_y, "TABS", dim);
  put(w, detail, col, layout.summary_y, narrow ? "COPY" : "SCROLL / COPY", dim);
  put(w, detail, col * 2, layout.summary_y, "DETACH", dim);
  put(w, detail, 0, layout.summary_y + 1, `${cardKey(s, action("next"))} / ${cardKey(s, action("prev"))}`, bright);
  put(w, detail, col, layout.summary_y + 1, cardKey(s, action("copy-mode")), bright);
  put(w, detail, col * 2, layout.summary_y + 1, cardKey(s, action("detach")), bright);
  put(w, detail, 0, layout.help_y, "[ ? Full keymap ]", s.focus === 2 ? palette.keycap : bright);
  if (direct) {
    const prefix_hint = narrow ? `[ P ${prefix_name} ]` : `Prefix [ ${prefix_name} ]  P change`;
    put(w, detail, 22, layout.help_y, prefix_hint, s.focus === 1 ? palette.keycap : bright);
  } else if (!narrow) put(w, detail, 23, layout.help_y, `${prefix_name} twice sends it through.`, dim);
}
function drawSplitDiagram(w: Writer, b: Rect, down: boolean) {
  box(w, b, false);
  if (down) {
    w.write(`\x1b[${b.y + 2};${b.x + 1}H${border}├`);
    w.write("─".repeat(b.w - 2));
    w.write("┤");
  } else {
    for (let row = 0; row < 3; row++)
      w.write(
        `\x1b[${b.y + row + 1};${b.x + Math.floor(b.w / 2) + 1}H${border}${row === 0 ? "┬" : row === 2 ? "┴" : "│"}`,
      );
  }
}
function ghosttyHost(): boolean {
  return (
    ghostty_integration.available() &&
    process.env.GHOSTTY_RESOURCES_DIR !== undefined &&
    process.env.CMUX_WORKSPACE_ID === undefined
  );
}
