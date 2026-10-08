//! The agent launcher popover: rows, keys, hit areas and drawing. The daemon
//! fills the preview; this file only shows it, and the shared runtime
//! remembers the choice. Mirrors agent_launcher.zig.
import { basename } from "node:path";
import * as palette from "./palette";
import { Style } from "./palette";
import { Provider } from "./providers";
import { Rect } from "./layout";
import { Dialog } from "./name_dialog";
import { Entry as CommandEntry, Semantics, Resolution, capacity as command_capacity } from "./launch/command";
import { restoreLimits, type Limits } from "./usage/account";
import { Cell, Grid, expired } from "./launcher_usage";
import * as launcherResume from "./launcher_resume";
import { writeKey } from "./launcher_resume";
import type { View as SidebarView } from "./sidebar";
import { Writer, displayWidth, writeEllipsis, sat } from "./text";

export type PerProvider<T> = { codex: T; claude: T };
const providers: Provider[] = ["codex", "claude"];

/** Launcher rows: one per provider, then saved commands and a plain terminal. */
export type Row =
  | "codex"
  | "claude"
  | "custom0"
  | "custom1"
  | "custom2"
  | "custom3"
  | "custom4"
  | "custom5"
  | "terminal"
  | "add"
  | "manage";
export const rows: Row[] = [
  "codex",
  "claude",
  "custom0",
  "custom1",
  "custom2",
  "custom3",
  "custom4",
  "custom5",
  "terminal",
  "add",
  "manage",
];
export const Row = {
  of(provider: Provider): Row {
    return provider;
  },
  custom(row: Row): number | null {
    const i = rows.indexOf(row);
    return i >= 2 && i <= 7 ? i - 2 : null;
  },
  agent(row: Row): Provider | null {
    return row === "codex" || row === "claude" ? row : null;
  },
};
/** The agent a launcher key starts. */
export function keyAgent(byte: number): Provider | null {
  for (const provider of providers) if (Provider.info(provider).launcher_key.charCodeAt(0) === byte) return provider;
  return null;
}

/** A launch preview's option for one provider, as launch/preview.zig's `Option`. */
export interface Option {
  signed_in: boolean | null;
  /** As configured, such as "opus" or "gpt-6-astra". */
  model: string;
  /** Its name, such as "Opus" or "GPT-6 Astra"; empty for an unknown shape. */
  model_name: string;
  source: string;
  account: string;
  plan: string;
  limits: Limits;
  usage_fetched_at: number;
  usage_error: string;
  usage_needs_consent: boolean;
  history: unknown;
}
export function option(value: any = {}): Option {
  return {
    signed_in: typeof value.signed_in === "boolean" ? value.signed_in : null,
    model: value.model ?? "",
    model_name: value.model_name ?? "",
    source: value.source ?? "",
    account: value.account ?? "",
    plan: value.plan ?? "",
    limits: restoreLimits(value.limits ?? "none"),
    usage_fetched_at: Number(value.usage_fetched_at ?? 0),
    usage_error: value.usage_error ?? "",
    usage_needs_consent: value.usage_needs_consent === true,
    history: value.history ?? null,
  };
}
/** The model's name, or its id when it has none. */
export function modelLabel(o: { model: string; model_name: string }): string {
  return o.model_name.length > 0 ? o.model_name : o.model;
}
export interface Preview {
  pending: boolean;
  options: PerProvider<Option>;
  installed: PerProvider<boolean>;
}
export function preview(value: any = {}): Preview {
  return {
    pending: value.pending !== false,
    options: { codex: option(value.options?.codex), claude: option(value.options?.claude) },
    installed: { codex: value.installed?.codex !== false, claude: value.installed?.claude !== false },
  };
}
/** A saved launch command from the snapshot, with its methods. */
export function commandEntry(value: any = {}): CommandEntry {
  const entry = Object.assign(new CommandEntry(), value ?? {});
  entry.semantics = Object.assign(new Semantics(), value?.semantics ?? {});
  return entry;
}
export function resolution(value: any = {}): Resolution {
  const result = Object.assign(new Resolution(), value ?? {});
  result.semantics = Object.assign(new Semantics(), value?.semantics ?? {});
  result.command = commandEntry(value?.command);
  return result;
}
const headings = ["Agent", "YOLO", "Model", "Account", "Plan", "Usage (used) · resets in"];
type Hint = { key: string; label: string };
const manage_label = " Manage agents ";
const now = () => Math.floor(Date.now() / 1000);

export class Menu {
  workspace = 0;
  cwd = "";
  /** The workspace's default folder, for the conversations' workspace scope. */
  workspace_cwd = "";
  resume_view = new launcherResume.View();
  history: launcherResume.History = { pending: true, entries: [] };
  /** Conversations panes run now, which the list jumps to instead. */
  open: launcherResume.Open[] = [];
  selected: Row = "codex";
  yolo: PerProvider<boolean> = { codex: false, claude: false };
  hidden: PerProvider<boolean> = { codex: false, claude: false };
  managing = false;
  editor = Object.assign(Dialog.init({ agent_command: 0 }, ""), { selected: false });
  name_editor = Object.assign(Dialog.init({ rename: 0 }, ""), { selected: false });
  name_focused = false;
  show_command = false;
  name_customized = false;
  edit_index: number | null = null;
  edit_provider: Provider | null = null;
  save_error = "";
  draft = new CommandEntry();
  draft_changed = 0;
  request_id = 0;
  resolution_checked = 0;
  resolution = new Resolution();
  save_requested = false;
  commands: CommandEntry[] = Array.from({ length: command_capacity }, () => new CommandEntry());
  last: Provider = "codex";
  pinned = false;
  /** The prefix arrived while pinned. Cmd+T sends the prefix and `c`, so a
   * repeat is ignored instead of read as a launcher key. */
  prefix = false;
  preview: Preview = preview();

  constructor(fields: Partial<Menu> = {}) {
    Object.assign(this, fields);
  }
  /** The text columns; `usageCell` draws the last one. */
  cells(provider: Provider): string[] {
    const o = this.preview.options[provider];
    return [
      Provider.info(provider).label,
      this.yolo[provider] ? "✓" : "·",
      o.model.length > 0 ? modelLabel(o) : this.preview.pending ? "Reading…" : "Default",
      o.account.length > 0 ? o.account : this.preview.pending ? "Reading…" : "Unavailable",
      o.plan.length > 0 ? o.plan : this.preview.pending ? "…" : "Unknown",
    ];
  }
  customCells(index: number): string[] {
    const entry = this.commands[index];
    const info = entry.semantics;
    const shared = info.default_account ? info.provider : null;
    const values = shared ? this.cells(shared) : ["", "", "Default", "", "—"];
    values[0] = entry.label();
    values[1] = info.yolo ? "✓" : "·";
    if (info.model.length > 0) values[2] = info.modelLabel();
    values[3] = this.account(info);
    return values;
  }
  usageCell(row: Row): Cell {
    let provider = Row.agent(row);
    const custom = Row.custom(row);
    if (provider === null && custom !== null) {
      const info = this.commands[custom].semantics;
      provider = info.default_account ? info.provider : null;
    }
    if (provider === null) return Cell.status("—");
    const o = this.preview.options[provider];
    // Built-in rows offer an actionable "Track usage" link instead; saved
    // commands sharing that provider show unavailable data (no action).
    if (this.trackable(provider)) return Row.custom(row) === null ? Cell.status("Track usage") : unavailableCell(o);
    const at = now();
    const limits = o.limits;
    if (limits === "none") return this.preview.pending ? Cell.status("Reading…") : unavailableCell(o);
    if (limits === "metered") return Cell.status("Metered");
    if (limits === "rate_limited") return unavailableCell(o);
    return expired(o.usage_fetched_at, at) ? unavailableCell(o) : Cell.init(limits.windows as any, at);
  }
  /** Management includes unavailable providers so preferences stay editable. */
  shown(row: Row): boolean {
    // Outside management, Manage is the title's button.
    if (row === "manage") return this.managing;
    if (row === "add") return this.managing;
    const index = Row.custom(row);
    if (index !== null)
      return this.commands[index].command.length > 0 && (this.managing || !this.commands[index].hidden);
    if (row === "terminal") return !this.managing;
    if (this.managing) return true;
    const provider = Row.agent(row)!;
    return (
      this.preview.installed[provider] && !this.hidden[provider] && this.preview.options[provider].signed_in !== false
    );
  }
  emptyCommand(): number | null {
    const i = this.commands.findIndex(entry => entry.command.length === 0);
    return i < 0 ? null : i;
  }
  countRows(): number {
    return this.count() - 2;
  }
  count(): number {
    return rows.filter(row => this.shown(row)).length;
  }
  rowAt(index: number): Row | null {
    return rows.filter(row => this.shown(row))[index] ?? null;
  }
  position(row: Row): number {
    let n = 0;
    for (const candidate of rows) {
      if (candidate === row) return n;
      n += this.shown(candidate) ? 1 : 0;
    }
    return n;
  }
  /** Keep the selection on a visible row after the installed set changes. */
  normalize(): void {
    if (!this.shown(this.selected)) this.selected = this.rowAt(0)!;
  }
  first(): Row {
    return this.rowAt(0)!;
  }
  lastRow(): Row {
    return this.rowAt(this.count() - 1)!;
  }
  /** Digits enumerate visible agents only, matching the picker keycaps. */
  shortcutRow(key: number): Row | null {
    if (this.managing || key < 48 || key > 57) return null;
    const row = this.rowAt(key - 48);
    if (row === null) return null;
    return Row.agent(row) !== null || Row.custom(row) !== null ? row : null;
  }
  move(next: boolean, wrap: boolean): void {
    this.normalize();
    const n = this.count();
    const index = this.position(this.selected);
    this.selected = this.rowAt(
      wrap ? (next ? index + 1 : index + n - 1) % n : next ? Math.min(index + 1, n - 1) : sat(index, 1),
    )!;
  }
  /** Rows the menu needs: border, headings, agent rows and a gap, the
   * conversations and a gap, footer and border. */
  rowsHeight(): number {
    if (this.managing) return this.count() + 20;
    const conversations = !this.hasResume()
      ? 0
      : this.resume_view.expanded
        ? 8
        : this.resume_view.collapsedHeight(this.resumeContext()) + 1;
    return 5 + this.count() + conversations;
  }
  bounds(cols: number, rowsCount: number, side: SidebarView): Rect {
    let content = 4;
    for (const width of this.columnSizes().preferred) content += width;
    let width = Math.min(cols, this.managing ? 82 : Math.max(this.hasResume() ? 80 : 40, content));
    let height = Math.min(rowsCount, this.rowsHeight());
    // Expanded conversations take the room a table of them needs.
    if (this.resume_view.expanded && this.hasResume()) {
      width = Math.max(width, Math.min(cols, 104));
      height = Math.min(rowsCount, Math.max(30, height));
    }
    return new Rect(
      Math.min(sat(side.width, 10), cols - width),
      Math.min(side.middle() + 1, rowsCount - height),
      width,
      height,
    );
  }
  /** Every row's usage shares one grid, so limits and resets line up. */
  usageGrid(): Grid {
    const grid = new Grid();
    for (const row of rows) {
      if (!this.shown(row) || (Row.agent(row) === null && Row.custom(row) === null)) continue;
      grid.add(this.usageCell(row));
    }
    return grid;
  }
  columnSizes(): { preferred: number[]; usage_minimum: number } {
    const widths = headings.map(heading => displayWidth(heading));
    for (const row of rows) {
      if (!this.shown(row) || (Row.agent(row) === null && Row.custom(row) === null)) continue;
      const custom = Row.custom(row);
      const values = custom !== null ? this.customCells(custom) : this.cells(Row.agent(row)!);
      values.forEach((text, i) => (widths[i] = Math.max(widths[i], displayWidth(text))));
    }
    const grid = this.usageGrid();
    const usage_minimum = Math.max(widths[5], grid.minimumWidth());
    widths[5] = Math.max(widths[5], grid.preferredWidth());
    widths.forEach((size, column) => (widths[column] = size + (column === 5 ? 1 : 2)));
    widths[0] += 4; // Left shortcut keycap and its following space.
    return { preferred: widths, usage_minimum: usage_minimum + 1 };
  }
  columns(width: number): number[] {
    const sizes = this.columnSizes();
    const widths = sizes.preferred.slice();
    const available = sat(width, 4);
    const minimum = [17, 6, 9, 18, 6, sizes.usage_minimum];
    if (width < 64) {
      widths[1] = 3; // A one-cell Y heading and toggle, plus its gutter.
      minimum[1] = 3;
    }
    // Give up metadata columns before truncating reported limits and resets.
    for (const column of [3, 2, 4]) {
      let needed = 0;
      minimum.forEach((size, i) => (needed += Math.min(size, widths[i])));
      if (needed <= available) break;
      widths[column] = 0;
      minimum[column] = 0;
    }
    let total = widths.reduce((sum, size) => sum + size, 0);
    while (total > available) {
      // Remove spare space from the most oversized column first. Keep
      // headings readable until even their minimum widths cannot fit.
      let largest = 0;
      widths.forEach((size, i) => {
        if (sat(size, minimum[i]) > sat(widths[largest], minimum[largest])) largest = i;
      });
      if (widths[largest] <= minimum[largest]) {
        widths.forEach((size, i) => {
          if (size > widths[largest]) largest = i;
        });
      }
      widths[largest] -= 1;
      total -= 1;
    }
    return widths;
  }
  hit(cols: number, rowsCount: number, side: SidebarView, x: number, y: number): Row | null {
    const b = this.bounds(cols, rowsCount, side);
    if (this.managing) {
      if (x <= b.x || x >= b.x + b.w - 1) return null;
      const n = this.count() - 2;
      if (y >= b.y + 4 && y < b.y + 4 + n) return this.rowAt(y - b.y - 4);
      if (y >= b.y + n + 5 && y <= b.y + n + 17 + (this.show_command ? 2 : 0)) return "add";
      if (y === b.y + b.h - 2 && x >= sat(b.x + b.w, 10)) return "manage";
      return null;
    }
    if (x <= b.x || x >= b.x + b.w - 1 || y < b.y + 2) return null;
    const index = y - b.y - 2;
    return index < this.count() ? this.rowAt(index) : null;
  }
  private providerHit(cols: number, rowsCount: number, side: SidebarView, x: number, y: number): Provider | null {
    if (this.managing) return null;
    const row = this.hit(cols, rowsCount, side, x, y);
    return row === null ? null : Row.agent(row);
  }
  yoloHit(cols: number, rowsCount: number, side: SidebarView, x: number, y: number): Provider | null {
    const provider = this.providerHit(cols, rowsCount, side, x, y);
    if (provider === null) return null;
    const b = this.bounds(cols, rowsCount, side);
    if (b.w < 24 || b.h < this.rowsHeight()) return null;
    const widths = this.columns(b.w);
    const start = b.x + 3 + widths[0];
    return x >= start && x < start + sat(widths[1], 2) ? provider : null;
  }
  trackable(row: Row): boolean {
    if (this.managing) return false;
    const provider = Row.agent(row);
    if (provider === null) return false;
    return !this.preview.pending && this.preview.options[provider].usage_needs_consent;
  }
  usageHit(cols: number, rowsCount: number, side: SidebarView, x: number, y: number): Provider | null {
    const provider = this.providerHit(cols, rowsCount, side, x, y);
    if (provider === null) return null;
    const b = this.bounds(cols, rowsCount, side);
    if (b.w < 24 || b.h < this.rowsHeight()) return null;
    const widths = this.columns(b.w);
    const start = b.x + 3 + widths[0] + widths[1] + widths[2] + widths[3] + widths[4];
    return x >= start && x < start + sat(widths[5], 1) ? provider : null;
  }
  resumeContext(): launcherResume.Context {
    return new launcherResume.Context(this.history, this.cwd, this.workspace_cwd, this.open, now());
  }
  /** Whether conversations show: once the daemon has sent some. A first
   * read takes seconds; the menu does not wait on it or show a placeholder. */
  hasResume(): boolean {
    return !this.managing && this.history.entries.length > 0;
  }
  /** The terminal row the conversations start on, a gap below the agents. */
  resumeTop(b: Rect): number {
    return b.y + 4 + this.count();
  }
  resumeArea(cols: number, rowsCount: number, side: SidebarView): launcherResume.Area {
    const b = this.bounds(cols, rowsCount, side);
    const top = this.resumeTop(b);
    return new launcherResume.Area(b.x + 1, top, b.w, sat(b.y + b.h - 1, top));
  }
  /** The conversation row or scope under a pointer, in 0-based cells. */
  resumeHit(cols: number, rowsCount: number, side: SidebarView, x: number, y: number): launcherResume.Hit | null {
    if (!this.hasResume()) return null;
    const b = this.bounds(cols, rowsCount, side);
    if (x <= b.x || x >= b.x + b.w - 1) return null;
    if (this.resume_view.expanded)
      return this.resume_view.hit(this.resumeContext(), this.resumeArea(cols, rowsCount, side), x + 1, y + 1);
    // Below the collapsed list's heading.
    const lines_top = this.resumeTop(b) + 1;
    if (y + 1 < lines_top) return null;
    const row = this.resume_view.collapsedHit(this.resumeContext(), y + 1 - lines_top);
    return row === null ? null : { row };
  }
  /** The title's Manage button, ` m  Manage agents `, in 0-based cells;
   * null when the menu is too narrow for it. */
  static manageSpan(b: Rect): { x: number; w: number } | null {
    const width = 1 + 3 + manage_label.length;
    if (b.w < width + 18) return null;
    return { x: b.x + b.w - 2 - width, w: width };
  }
  manageHit(cols: number, rowsCount: number, side: SidebarView, x: number, y: number): boolean {
    if (this.managing) return false;
    const b = this.bounds(cols, rowsCount, side);
    const span = Menu.manageSpan(b);
    if (!span) return false;
    return y === b.y && x >= span.x && x < span.x + span.w;
  }
  private static drawTitle(w: Writer, b: Rect, panel: string): void {
    w.write(`\x1b[${b.y + 1};${b.x + 3}H\x1b[1m` + palette.fg("strong") + ` New agent ${panel}`);
    const span = Menu.manageSpan(b);
    if (!span) return;
    // Like a footer hint: a keycap, then a faint label.
    w.write(`\x1b[${b.y + 1};${span.x + 1}H${panel} `);
    writeKey(w, "m", panel);
    w.write(manage_label);
  }
  private static drawFooter(w: Writer, b: Rect, panel: string, cwd: string, what: string, hints: Hint[]): void {
    let hint_width = 0;
    hints.forEach((hint, i) => (hint_width += displayWidth(hint.key) + 2 + 1 + hint.label.length + (i > 0 ? 2 : 0)));
    const footer_row = b.y + b.h - 1;
    w.write(`\x1b[${footer_row};${b.x + 3}H${panel}`);
    writeEllipsis(w, `${basename(cwd)} · ${what}`, sat(b.w, hint_width + 6));
    w.write(`\x1b[${footer_row};${b.x + b.w - 1 - hint_width}H`);
    hints.forEach((hint, i) => {
      if (i > 0) w.write("  ");
      writeKey(w, hint.key, panel);
      w.write(` ${hint.label}`);
    });
  }
  edit(row: Row): void {
    this.draft = new CommandEntry();
    this.request_id = 0;
    this.resolution = new Resolution();
    this.save_requested = false;
    this.edit_index = Row.custom(row);
    this.edit_provider = Row.agent(row);
    const source =
      this.edit_index !== null
        ? this.commands[this.edit_index].inputText()
        : this.edit_provider !== null
          ? this.edit_provider
          : "";
    this.editor = Dialog.init({ agent_command: 0 }, source);
    this.name_focused = false;
    this.show_command = false;
    this.name_customized = this.edit_index !== null;
    this.name_editor = Dialog.init(
      { rename: 0 },
      this.edit_index !== null ? this.commands[this.edit_index].label() : "",
    );
    if (this.edit_index !== null) {
      try {
        this.draft.set(source);
      } catch {}
      const resolved = new Resolution();
      resolved.pending = false;
      resolved.command = this.commands[this.edit_index];
      resolved.semantics = this.commands[this.edit_index].semantics;
      this.resolution = resolved;
    }
    this.selected = "add";
    this.pinned = true;
  }
  input(): Dialog {
    return this.name_focused ? this.name_editor : this.editor;
  }
  account(info: Semantics): string {
    if (info.account.length > 0) return info.account;
    if (info.default_account && info.provider) {
      const o = this.preview.options[info.provider];
      return o.account.length > 0
        ? o.account
        : this.preview.pending
          ? "Reading default account…"
          : "Default account · unavailable";
    }
    return "Account unknown";
  }
  private static drawInput(
    w: Writer,
    editor: Dialog,
    placeholder: string,
    x: number,
    y: number,
    width: number,
    focused: boolean,
  ): void {
    let offset = sat(editor.cursor, sat(width, 1));
    while (offset < editor.cursor && (editor.text[offset] & 0xc0) === 0x80) offset += 1;
    const end = editor.byteAtColumn(offset, width);
    w.write(`\x1b[${y};${x}H` + palette.bg("selected"));
    w.splat(" ", width);
    w.write(`\x1b[${y};${x}H`);
    if (editor.len === 0) writeEllipsis(w, placeholder, width);
    else {
      if (focused && editor.selected) w.write("\x1b[7m");
      w.write(
        Buffer.from(
          Uint8Array.from(editor.text.subarray(offset, end), ch => (ch < 32 || ch === 127 ? 32 : ch)),
        ).toString(),
      );
    }
    w.write(new Style({ fg: "text", bg: "surface" }).sgr());
  }
  private drawManager(w: Writer, cols: number, rowsCount: number, side: SidebarView): void {
    const m = this;
    const b = m.bounds(cols, rowsCount, side);
    if (b.w < 40 || b.h < m.rowsHeight()) return;
    const panel = new Style({ fg: "text", bg: "surface" }).sgr();
    const rule = new Style({ fg: "line", bg: "surface" }).sgr();
    for (let y = 0; y < b.h; y++) {
      w.write(`\x1b[${b.y + y + 1};${b.x + 1}H${rule}${y === 0 ? "╭" : y === b.h - 1 ? "╰" : "│"}`);
      if (y === 0 || y === b.h - 1) w.write("─".repeat(b.w - 2));
      else w.splat(" ", b.w - 2);
      w.write(y === 0 ? "╮" : y === b.h - 1 ? "╯" : "│");
    }
    w.write(`\x1b[${b.y + 1};${b.x + 3}H${panel} Manage agents `);
    const name_width = Math.min(24, Math.floor(b.w / 3));
    const command_x = b.x + 10 + name_width;
    w.write(`\x1b[${b.y + 3};${b.x + 4}HShow\x1b[${b.y + 3};${b.x + 10}HAgent\x1b[${b.y + 3};${command_x}HAccount`);
    w.write(`\x1b[${b.y + 4};${b.x + 4}H${rule}`);
    w.write("─".repeat(b.w - 6));
    w.write(panel);
    const n = m.count() - 2;
    for (let i = 0; i < n; i++) {
      const row = m.rowAt(i)!;
      const custom = Row.custom(row);
      const hidden = custom !== null ? m.commands[custom].hidden : m.hidden[Row.agent(row)!];
      const label = custom !== null ? m.commands[custom].label() : Provider.info(Row.agent(row)!).label;
      const info =
        custom !== null
          ? m.commands[custom].semantics
          : Object.assign(new Semantics(), { provider: Row.agent(row)!, default_account: true });
      const source = m.account(info);
      w.write(
        `\x1b[${b.y + 5 + i};${b.x + 2}H${m.selected === row ? "›" : " "} [${hidden ? " " : "✓"}]\x1b[${b.y + 5 + i};${b.x + 10}H`,
      );
      writeEllipsis(w, label, name_width - 2);
      w.write(`\x1b[${b.y + 5 + i};${command_x}H`);
      writeEllipsis(w, cleanControls(source), sat(sat(b.x + b.w, 19), command_x));
      w.write(`\x1b[${b.y + 5 + i};${b.x + b.w - 17}H[Edit]`);
      if (custom !== null) w.write(`\x1b[${b.y + 5 + i};${b.x + b.w - 10}H[Delete]`);
    }
    const field_y = b.y + n + 6;
    const input_x = b.x + 5;
    const width = sat(b.w, 10);
    const dim = palette.fg("faint");
    for (let i = 0; i < 2; i++) {
      const top = field_y + i * 4;
      const focused = m.selected === "add" && m.name_focused === (i === 1);
      w.write(`\x1b[${top};${b.x + 4}H${dim}${i === 0 ? "Command" : "Name"}`);
      const border = focused ? palette.fg("accent") : palette.fg("line");
      for (let line = 0; line < 3; line++) {
        w.write(`\x1b[${top + line + 1};${b.x + 4}H${border}${line === 0 ? "┌" : line === 2 ? "└" : "│"}`);
        if (line !== 1) w.write("─".repeat(width + 2));
        else w.splat(" ", width + 2);
        w.write(line === 0 ? "┐" : line === 2 ? "┘" : "│");
      }
      w.write(panel);
      Menu.drawInput(
        w,
        i === 0 ? m.editor : m.name_editor,
        i === 0 ? "Paste a command…" : "Suggested automatically",
        input_x + 1,
        top + 2,
        width,
        focused,
      );
    }
    if (m.editor.len > 0) {
      const matches = m.draft.text() === m.editor.name();
      const resolved = matches && !m.resolution.pending && m.resolution.error_message.length === 0;
      const status =
        m.editor.failed && m.save_error.length > 0
          ? m.save_error
          : m.editor.overflow
            ? "Command too long"
            : !matches || m.resolution.pending
              ? "Resolving command…"
              : m.resolution.error_message.length > 0
                ? m.resolution.error_message
                : m.account(m.resolution.semantics);
      w.write(`\x1b[${field_y + 9};${b.x + 4}H`);
      const info = m.resolution.semantics;
      const provider = info.provider ? Provider.info(info.provider).label : "Custom agent";
      writeEllipsis(w, resolved ? `${provider} · ${status}` : status, b.w - 8);
      w.write(`\x1b[${field_y + 10};${b.x + 4}H${dim}`);
      if (resolved) {
        const mode = info.yolo ? info.mode : "";
        writeEllipsis(
          w,
          `${info.modelLabel()}${info.model.length > 0 && mode.length > 0 ? " · " : ""}${mode}`,
          b.w - 26,
        );
        w.write(`\x1b[${field_y + 10};${b.x + b.w - 17}H[${m.show_command ? "Hide" : "Show"} command]`);
        if (m.show_command) {
          w.write(`\x1b[${field_y + 12};${b.x + 4}HRuns: `);
          writeEllipsis(w, cleanControls(m.resolution.command.text()), b.w - 14);
        }
      }
    }
    const action = m.edit_index !== null || m.edit_provider !== null ? "Save" : "Add";
    w.write(`${panel}\x1b[${field_y + 12 + (m.show_command ? 2 : 0)};${b.x + b.w - 19}H[Cancel]  [${action}]`);
    w.write(
      `\x1b[${b.y + b.h - 1};${b.x + 4}H${dim}Tab: command / name\x1b[${b.y + b.h - 1};${b.x + b.w - 9}H${panel}[Done]\x1b[?25l`,
    );
    if (m.selected === "add") {
      const editor = m.name_focused ? m.name_editor : m.editor;
      let offset = sat(editor.cursor, sat(width, 1));
      while (offset < editor.cursor && (editor.text[offset] & 0xc0) === 0x80) offset += 1;
      const cursor = Math.min(sat(width, 1), displayWidth(editor.bytes(offset, editor.cursor)));
      w.write(`\x1b[${field_y + 2 + (m.name_focused ? 4 : 0)};${input_x + 1 + cursor}H\x1b[?25h`);
    }
  }
  draw(w: Writer, cols: number, rowsCount: number, side: SidebarView): void {
    const m = this;
    if (m.managing) return m.drawManager(w, cols, rowsCount, side);
    const b = m.bounds(cols, rowsCount, side);
    if (b.w < 24 || b.h < m.rowsHeight()) return;
    const panel = new Style({ fg: "faint", bg: "surface" }).sgr();
    const rule = new Style({ fg: "line", bg: "surface" }).sgr();
    for (let row = 0; row < b.h; row++) {
      w.write(`\x1b[${b.y + row + 1};${b.x + 1}H${rule}`);
      w.write(row === 0 ? "╭" : row === b.h - 1 ? "╰" : "│");
      if (row === 0 || row === b.h - 1) w.write("─".repeat(b.w - 2));
      else w.splat(" ", b.w - 2);
      w.write(row === 0 ? "╮" : row === b.h - 1 ? "╯" : "│");
    }
    Menu.drawTitle(w, b, panel);
    const widths = m.columns(b.w);
    let heading_x = b.x + 4;
    headings.forEach((heading, column) => {
      const width = widths[column];
      if (width === 0 || (m.managing && column !== 0)) return;
      w.write(`\x1b[${b.y + 2};${heading_x + (column === 0 ? 4 : 0)}H${panel}`);
      const room = sat(width, column === 0 ? 6 : column === 5 ? 1 : 2);
      const label =
        column === 1 && room < 4
          ? "Y"
          : column === 5 && room < displayWidth(heading)
            ? room >= 14
              ? "Usage · resets"
              : "Usage"
            : heading;
      writeEllipsis(w, label, room);
      heading_x += width;
    });
    const grid = m.usageGrid();
    for (let visible = 0; visible < m.count(); visible++) {
      const current = m.rowAt(visible)!;
      const selected = current === m.selected && !m.resume_view.focused;
      const row = b.y + 3 + visible + (current === "manage" ? 2 : 0);
      if (current === "manage") {
        w.write(`\x1b[${row - 1};${b.x + 4}H${rule}`);
        w.write("─".repeat(b.w - 6));
      }
      const style = selected
        ? new Style({ fg: "strong", bg: "selected" }).sgr()
        : new Style({ fg: "text", bg: "surface" }).sgr();
      w.write(`\x1b[${row};${b.x + 2}H${style}`);
      w.splat(" ", b.w - 2);
      w.write(`\x1b[${row};${b.x + 2}H${selected ? "›" : " "}`);
      if (Row.agent(current) !== null || Row.custom(current) !== null) {
        w.write(`\x1b[${row};${b.x + 4}H`);
        writeKey(w, String.fromCharCode(48 + visible), style);
      }
      if (current === "add") {
        w.write(`\x1b[${row};${b.x + 4}H`);
        writeEllipsis(w, "+ Add agent…", sat(b.w, 6));
        continue;
      }
      if (current === "manage") {
        // A step above a selected row, so the button keeps its edge.
        const button = selected
          ? new Style({ fg: "strong", bg: "line", bold: true }).sgr()
          : new Style({ fg: "strong", bg: "selected", bold: true }).sgr();
        w.write(`\x1b[${row};${b.x + 4}H${button}`);
        writeEllipsis(w, " → Manage agents… ", sat(b.w, 6));
        w.write(style);
        continue;
      }
      if (m.managing) {
        const provider = Row.agent(current)!;
        const status = !m.preview.installed[provider]
          ? "Not installed"
          : m.preview.options[provider].signed_in === false
            ? "Not signed in"
            : m.hidden[provider]
              ? "Hidden"
              : "In picker";
        w.write(`\x1b[${row};${b.x + 4}H`);
        writeEllipsis(
          w,
          `${Provider.info(provider).label} · ${status}   [${m.hidden[provider] ? "Add" : "Remove"}]`,
          sat(b.w, 6),
        );
        continue;
      }
      if (current === "terminal") {
        w.write(`\x1b[${row};${b.x + 4}H`);
        writeKey(w, "t", style);
        w.write(" ");
        writeEllipsis(w, "New terminal", sat(b.w, 10));
        continue;
      }
      let x = b.x + 4;
      const custom = Row.custom(current);
      const values = custom !== null ? m.customCells(custom) : m.cells(Row.agent(current)!);
      const yolo = custom !== null ? m.commands[custom].semantics.yolo : m.yolo[Row.agent(current)!];
      widths.forEach((width, column) => {
        if (width === 0) return;
        w.write(`\x1b[${row};${x + (column === 0 ? 4 : 0)}H`);
        if (column === 5 && m.trackable(current)) w.write("\x1b[4m");
        if (column === 1 && yolo) w.write("\x1b[1m" + palette.fg("strong"));
        const room = sat(width, column === 0 ? 6 : column === 5 ? 1 : 2);
        if (column === 5) m.usageCell(current).write(w, grid, room, style, selected);
        else writeEllipsis(w, values[column], room);
        w.write("\x1b[24m");
        if (column === 1 && yolo) w.write(style);
        x += width;
      });
    }
    if (m.hasResume()) {
      // A rule across the gap between the agents and the conversations.
      w.write(`\x1b[${m.resumeTop(b) - 1};${b.x + 4}H${rule}`);
      w.write("─".repeat(b.w - 6));
      if (m.resume_view.expanded) m.resume_view.draw(w, m.resumeContext(), m.resumeArea(cols, rowsCount, side));
      else m.resume_view.drawCollapsed(w, m.resumeContext(), b.x + 1, m.resumeTop(b), b.w);
    }
    const view = m.resume_view;
    const c = m.resumeContext();
    const on_more = view.focused && view.entry(c, view.lines(c)) === null;
    let hints: Hint[];
    if (view.searching && view.query.len > 0)
      hints = [
        { key: "↵", label: "resume" },
        { key: "tab", label: "scope" },
        { key: "esc", label: "clear" },
      ];
    else if (view.searching)
      hints = [
        { key: "↵", label: "resume" },
        { key: "tab", label: "scope" },
        { key: "esc", label: "close" },
      ];
    else if (view.focused && view.expanded)
      hints = [
        { key: "↵", label: "resume" },
        { key: "/", label: "search" },
        { key: "tab", label: "scope" },
        { key: "esc", label: "less" },
      ];
    else if (on_more)
      hints = [
        { key: "↵", label: "show all" },
        { key: "/", label: "search" },
      ];
    else if (view.focused)
      hints = [
        { key: "↵", label: "resume" },
        { key: "/", label: "search" },
      ];
    else if (m.managing || m.selected === "manage") {
      const label =
        m.selected === "manage"
          ? "back/open"
          : m.selected === "add"
            ? "add"
            : Row.custom(m.selected) !== null
              ? "edit"
              : Row.agent(m.selected) !== null && m.hidden[Row.agent(m.selected)!]
                ? "add"
                : "remove";
      hints = [{ key: "↵", label }];
    } else if (Row.custom(m.selected) !== null) hints = [{ key: "a", label: "launch" }];
    else if (m.selected === "terminal") hints = [{ key: "a", label: "open" }];
    else if (m.trackable(m.selected))
      hints = [
        { key: "u", label: "Track usage" },
        { key: "a", label: "launch" },
        { key: "y", label: "YOLO" },
      ];
    else
      hints = [
        { key: "a", label: "launch" },
        { key: "y", label: "YOLO" },
      ];
    Menu.drawFooter(w, b, panel, m.cwd, "new tab", hints);
    w.write("\x1b[0m\x1b[?25l");
  }
}
function unavailableCell(o: Option): Cell {
  const reason =
    o.usage_error.length > 0 ? o.usage_error : o.usage_fetched_at > 0 ? "last success 10m+ ago" : "no usage received";
  return Cell.unavailable(reason);
}
function cleanControls(text: string): string {
  return Buffer.from(Uint8Array.from(Buffer.from(text), ch => (ch < 32 || ch === 127 ? 32 : ch))).toString();
}
