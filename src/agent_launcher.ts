//! The agent launcher popover: rows, keys, hit areas and drawing. The daemon
//! fills the preview; this file only shows it, and the shared runtime
//! remembers the choice. Its Manage agents is agent_manager.ts, in its card.
//! Mirrors agent_launcher.zig.
import * as palette from "./palette";
import { Style, keycap } from "./palette";
import { Provider, byProvider, adapter } from "./providers";
import type { ByProvider } from "./providers";
import { Rect } from "./layout";
import { Dialog, View as DialogView, writeField } from "./name_dialog";
import { Entry as CommandEntry, Semantics, Resolution, capacity as command_capacity } from "./launch/command";
import * as accounts from "./accounts";
import { writeModel } from "./agent_models";
import * as effort from "./providers/effort";
import { Model } from "./providers/model";
import type { Profile } from "./agent_profiles";
import * as launcherOrder from "./launch/order";
import * as agentManager from "./agent_manager";
import { Slide } from "./card_transition";
import { milliTimestamp } from "./clock";
import { restoreLimits, type Limits } from "./usage/account";
import * as spend from "./usage/spend";
import * as limitHistory from "./usage/limits";
import { Cell, Grid, expired } from "./launcher_usage";
import * as launcherResume from "./launcher_resume";
import { writeKey } from "./launcher_resume";
import * as launcherWorktree from "./launcher_worktree";
import * as worktreeFolder from "./worktree_folder";
import * as dropdown from "./dropdown";
import type * as worktrees from "./worktrees";
import type { View as SidebarView, Spotlight } from "./sidebar";
import { Writer, displayWidth, ellipsis, writeEllipsis, sat } from "./text";
import { Row, customs, type Launch } from "./launch/row";
import { writeMark, type Marks } from "./provider_mark";
export { Row, type Launch };

const providers = Provider.all;

/** The agent a launcher key starts. */
export function keyAgent(byte: number): Provider | null {
  for (const provider of providers) if (adapter(provider).launcher_key.charCodeAt(0) === byte) return provider;
  return null;
}

/** A launch preview's option for one provider, as launch/preview.zig's `Option`. */
export interface Option {
  /** Null for older previews, which only report loading for the whole list. */
  pending: boolean | null;
  signed_in: boolean | null;
  /** As configured, such as "opus" or "gpt-6-astra". */
  model: string;
  /** Its name, such as "Opus" or "GPT-6 Astra"; empty for an unknown shape. */
  model_name: string;
  source: string;
  account: string;
  plan: string;
  limits: Limits;
  spend: spend.Reading | null;
  usage_fetched_at: number;
  usage_error: string;
  usage_needs_consent: boolean;
  history: unknown;
  spend_history: limitHistory.SpendCell[];
}
export function option(value: any = {}): Option {
  return {
    pending: typeof value.pending === "boolean" ? value.pending : null,
    signed_in: typeof value.signed_in === "boolean" ? value.signed_in : null,
    model: value.model ?? "",
    model_name: value.model_name ?? "",
    source: value.source ?? "",
    account: value.account ?? "",
    plan: value.plan ?? "",
    limits: restoreLimits(value.limits ?? "none"),
    spend: spend.restore(value.spend),
    usage_fetched_at: Number(value.usage_fetched_at ?? 0),
    usage_error: value.usage_error ?? "",
    usage_needs_consent: value.usage_needs_consent === true,
    history: value.history ?? null,
    spend_history: limitHistory.spendCells(value.spend_history),
  };
}
/** The model's name, or its id when it has none. */
export function modelLabel(o: { model: string; model_name: string }): string {
  return o.model_name.length > 0 ? o.model_name : o.model;
}
/** An account besides a provider's default, and what its launcher row reads. */
export interface AccountOption {
  provider: Provider;
  /** Its settings folder, which picks it. */
  account: string;
  name: string;
  managed: boolean;
  option: Option;
}
export interface Preview {
  pending: boolean;
  options: ByProvider<Option>;
  installed: ByProvider<boolean>;
  /** The version of each agent that is there but too old for Corgi, or "". */
  outdated: ByProvider<string>;
  /** What each default account is called; "" for one that goes by its agent's name. */
  names: ByProvider<string>;
  accounts: AccountOption[];
}
export function preview(value: any = {}): Preview {
  return {
    pending: value.pending !== false,
    options: byProvider(p => option(value.options?.[p])),
    installed: byProvider(p => value.installed?.[p] !== false),
    outdated: byProvider(p => (typeof value.outdated?.[p] === "string" ? value.outdated[p] : "")),
    names: byProvider(p => (typeof value.names?.[p] === "string" ? value.names[p] : "")),
    accounts: (Array.isArray(value.accounts) ? value.accounts : []).flatMap((a: any): AccountOption[] => {
      const provider = Provider.parse(a?.provider);
      if (!provider || typeof a.account !== "string" || !a.account || typeof a.name !== "string") return [];
      return [{ provider, account: a.account, name: a.name, managed: a.managed === true, option: option(a.option) }];
    }),
  };
}
// Semantics naming a provider this viewer doesn't know; sending them back would erase it.
const foreign = new WeakSet<Semantics>();
/** What a command runs, with a provider this viewer doesn't know read as none. */
function semantics(value: any): Semantics {
  const result = Object.assign(new Semantics(), value ?? {});
  result.provider = Provider.parse(result.provider);
  if (value?.provider != null && result.provider === null) foreign.add(result);
  return result;
}
/** The semantics to send back with a command, or null to leave them to the daemon. */
export function returned(s: Semantics): Semantics | null {
  return foreign.has(s) ? null : s;
}
/** A saved launch command from the snapshot, with its methods. */
export function commandEntry(value: any = {}): CommandEntry {
  const entry = Object.assign(new CommandEntry(), value ?? {});
  entry.semantics = semantics(value?.semantics);
  return entry;
}
export function resolution(value: any = {}): Resolution {
  const result = Object.assign(new Resolution(), value ?? {});
  result.semantics = semantics(value?.semantics);
  result.command = commandEntry(value?.command);
  return result;
}
const headings = ["Agent", "YOLO", "Model", "Account", "Plan", "Usage (used) · resets in"];
/** Columns for a row's brand mark. */
const mark_w = 2;
// Reserve metadata and two usage windows before their readings arrive.
const column_widths = [26 + mark_w, 6, 24 - mark_w, 28, 12, 50];
export const preferred_width = 4 + column_widths.reduce((sum, size) => sum + size, 0);
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
  selected: Row = Provider.first;
  /** Each provider's own row's YOLO and Show; an account's row has its own. */
  yolo = byProvider(() => false);
  hidden = byProvider(() => false);
  /** The accounts whose rows have YOLO on, and those the picker hides. */
  account_yolo: string[] = [];
  account_hidden: string[] = [];
  /** The rows hidden in this workspace only. */
  workspace_hidden: Row[] = [];
  workspace_order: Row[] = [];
  profiles: Profile[] = [];
  workspace_name = "";
  /** Manage agents has the card. */
  managing = false;
  manager = new agentManager.View();
  transition = new Slide();
  commands: CommandEntry[] = Array.from({ length: command_capacity }, () => new CommandEntry());
  last: Provider = Provider.first;
  pinned = false;
  /** The prefix arrived while pinned. Cmd+T sends the prefix and `c`, so a
   * repeat is ignored instead of read as a launcher key. */
  prefix = false;
  preview: Preview = preview();
  /** The accounts Corgi knows besides each default, which name the conversations they ran. */
  accounts: launcherResume.Account[] = [];
  /** The workspace's checkouts, for the title's button and its list. */
  worktrees: worktrees.Snapshot | null = null;
  worktree = new launcherWorktree.Chooser();
  /** Where a new worktree goes, as the viewer's preferences say. */
  worktree_folder = worktreeFolder.default_template;
  /** Places brand marks where the host shows images; the glyph otherwise. */
  marks: Marks | null = null;

  constructor(fields: Partial<Menu> = {}) {
    Object.assign(this, fields);
  }
  /** The account a row starts in, as the preview lists it; null for a
   * provider's own row and for an account it no longer lists. */
  profileOf(row: Row): Profile | null {
    const id = Row.profile(row);
    return id ? (this.profiles.find(p => p.id === id) ?? null) : null;
  }
  launchOf(row: Row): Launch | null {
    return this.profileOf(row) ?? Row.launch(row);
  }
  /** The agent a row starts, for its brand mark; null for a terminal or a
   * saved command that runs something else. */
  providerOf(row: Row): Provider | null {
    const custom = Row.custom(row);
    return custom !== null ? this.commands[custom].semantics.provider : (this.launchOf(row)?.provider ?? null);
  }
  accountOf(row: Row): AccountOption | null {
    const profile = this.profileOf(row);
    if (profile) row = Row.of(profile.provider, profile.account);
    return this.preview.accounts.find(a => Row.of(a.provider, a.account) === row) ?? null;
  }
  /** What a provider's or an account's row reads; null for any other row. */
  optionOf(row: Row): Option | null {
    const profile = this.profileOf(row);
    if (profile) row = Row.of(profile.provider, profile.account);
    const provider = Row.agent(row);
    return provider !== null
      ? this.preview.options[provider]
      : (this.accountOf(row)?.option ?? (profile ? option() : null));
  }
  /** Whether a provider's or an account's row starts its agent with YOLO. */
  yoloOf(row: Row): boolean {
    const profile = this.profileOf(row);
    if (profile) return profile.yolo;
    const l = this.launchOf(row);
    return l === null ? false : l.account ? this.account_yolo.includes(l.account) : this.yolo[l.provider];
  }
  /** Whether Manage agents took a provider's or an account's row out of the picker. */
  hiddenOf(row: Row): boolean {
    if (this.profileOf(row)) return false;
    const l = this.launchOf(row);
    return l === null ? false : l.account ? this.account_hidden.includes(l.account) : this.hidden[l.provider];
  }
  /** The account a row signs in to instead of starting its agent: one signed out. */
  signsIn(row: Row): AccountOption | null {
    const a = this.accountOf(row);
    return a !== null && a.option.signed_in === false && adapter(a.provider).accounts.signin !== null ? a : null;
  }
  /** A provider's or an account's row's name, such as `Claude Code · work`,
   * or for a default account that has no name, its provider's. Short of
   * `room`, it shortens its provider's name first. */
  label(row: Row, room = Infinity): string {
    const profile = this.profileOf(row);
    if (profile) return ellipsis(profile.name, room);
    const l = this.launchOf(row)!,
      name = l.account ? (this.accountOf(row)?.name ?? "") : this.preview.names[l.provider],
      p = adapter(l.provider);
    if (!name) return displayWidth(p.label) <= room ? p.label : p.name;
    const suffix = ` · ${name}`;
    if (displayWidth(p.label + suffix) <= room) return p.label + suffix;
    const short = ellipsis(p.name, sat(room, displayWidth(suffix)));
    return short.length > 0 ? short + suffix : name;
  }
  modelCell(row: Row): { name: string; effort?: effort.Effort } {
    const target = this.launchOf(row),
      settings =
        this.profileOf(row)?.options ?? (target ? accounts.launchOptions(target.provider, target.account) : null),
      o = this.optionOf(row) ?? option();
    return {
      name: settings?.model
        ? Model.resolve(settings.model).label()
        : o.model.length
          ? modelLabel(o)
          : (o.pending ?? this.preview.pending)
            ? "Reading…"
            : "Default",
      ...(settings?.effort ? { effort: settings.effort } : {}),
    };
  }
  /** A provider's or an account's row's text columns; usageCell draws the last one. */
  cells(row: Row): string[] {
    const o = this.optionOf(row) ?? option(),
      model = this.modelCell(row),
      pending = o.pending ?? this.preview.pending,
      out = this.signsIn(row) !== null;
    return [
      this.label(row),
      adapter(this.launchOf(row)!.provider).bypass === false ? "—" : this.yoloOf(row) ? "✓" : "·",
      model.name + effort.suffix(model.effort),
      out ? "—" : o.account.length > 0 ? o.account : pending ? "Reading…" : "Unavailable",
      out ? "—" : o.plan.length > 0 ? o.plan : pending ? "…" : "Unknown",
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
    const custom = Row.custom(row);
    const shared = custom === null ? null : this.commands[custom].semantics;
    const o =
      shared === null
        ? this.optionOf(row)
        : shared.default_account && shared.provider
          ? this.preview.options[shared.provider]
          : null;
    if (o === null) return Cell.status("—");
    if (custom === null && this.signsIn(row)) return Cell.status("Sign in");
    // Agent rows offer an actionable "Track usage" link instead; saved
    // commands sharing that provider show unavailable data (no action).
    if (this.consenting(o)) return custom === null ? Cell.status("Track usage") : Cell.status("—");
    const at = now();
    const limits = o.limits;
    if (limits === "none") return (o.pending ?? this.preview.pending) ? Cell.status("Reading…") : Cell.status("—");
    if (limits === "metered") {
      if (o.spend === null) return Cell.status("Metered");
      if (expired(o.usage_fetched_at, at) || !spend.current(o.spend, at)) return Cell.status("—");
      return Cell.monthly(o.spend, at);
    }
    if (limits === "rate_limited") return Cell.status("—");
    return expired(o.usage_fetched_at, at) ? Cell.status("—") : Cell.init(limits.windows as any, at);
  }
  shown(row: Row): boolean {
    if (this.workspace_hidden.includes(row)) return false;
    const index = Row.custom(row);
    if (index !== null) return this.commands[index].command.length > 0 && !this.commands[index].hidden;
    if (row === "terminal") return true;
    const o = this.optionOf(row);
    if (o === null) return false;
    // A signed-out account's row offers to sign in; a signed-out default's is left out.
    const l = this.launchOf(row);
    if (!l || (this.profileOf(row)?.account && !this.accountOf(row))) return false;
    return this.preview.installed[l.provider] && !this.hiddenOf(row) && (l.account.length > 0 || o.signed_in !== false);
  }
  /** Every row, shown or not: each provider's and then its accounts'. */
  rows(): Row[] {
    const agents = providers.flatMap((p): Row[] => [
      p,
      ...this.preview.accounts.filter(a => a.provider === p).map(a => Row.of(p, a.account)),
    ]);
    return [
      ...launcherOrder.arrange(
        [...agents, ...this.profiles.map(p => Row.ofProfile(p.id)), ...customs],
        this.workspace_order,
      ),
      "terminal",
    ];
  }
  emptyCommand(): number | null {
    const i = this.commands.findIndex(entry => entry.command.length === 0);
    return i < 0 ? null : i;
  }
  count(): number {
    return this.rows().filter(row => this.shown(row)).length;
  }
  rowAt(index: number): Row | null {
    return this.rows().filter(row => this.shown(row))[index] ?? null;
  }
  position(row: Row): number {
    let n = 0;
    for (const candidate of this.rows()) {
      if (candidate === row) return n;
      n += this.shown(candidate) ? 1 : 0;
    }
    return n;
  }
  /** Keep the selection on a visible row after the installed set changes.
   * An account's row that went away leaves its provider's selected. */
  normalize(): void {
    if (this.shown(this.selected)) return;
    const provider = this.launchOf(this.selected)?.provider ?? null;
    this.selected = provider !== null && this.shown(provider) ? provider : this.rowAt(0)!;
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
    return row !== null && Row.starts(row) ? row : null;
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
    if (this.managing) return this.manager.height(this.manageModel());
    const conversations = !this.hasResume()
      ? 0
      : this.resume_view.expanded
        ? 8
        : this.resume_view.collapsedHeight(this.resumeContext()) + 1;
    // The worktree box hangs from the title above the footer.
    const c = this.worktree;
    const hanging =
      c.mode !== "open"
        ? 0
        : launcherWorktree.boxHeight(
            Math.min(c.count(this.worktrees), launcherWorktree.list_rows),
            c.error.length > 0,
            c.focus === "from" ? launcherWorktree.pickChoices(c, now()).length : null,
          );
    return Math.max(5 + this.count() + conversations, hanging);
  }
  bounds(cols: number, rowsCount: number, side: SidebarView): Rect {
    const width = Math.min(cols, preferred_width);
    let height = Math.min(rowsCount, this.rowsHeight());
    // Expanded conversations take the room a table of them needs.
    if (this.resume_view.expanded && this.history.entries.length > 0) {
      if (!this.managing) height = Math.min(rowsCount, Math.max(30, height));
    }
    return new Rect(
      Math.min(sat(side.width, 10), cols - width),
      Math.min(side.middle() + 1, rowsCount - height),
      width,
      height,
    );
  }
  /** Hidden entries share the usage grid with the rows in the picker. */
  private tableRows(): Row[] {
    return this.rows().filter(row => {
      const custom = Row.custom(row);
      return custom !== null ? this.commands[custom].command.length > 0 : Row.starts(row);
    });
  }
  /** Every row's usage shares one grid, so limits and resets line up. */
  usageGrid(): Grid {
    const grid = new Grid();
    for (const row of this.tableRows()) grid.add(this.usageCell(row));
    return grid;
  }
  columns(width: number): number[] {
    const widths = column_widths.slice();
    const available = sat(width, 4);
    const minimum = [width >= 100 ? 26 + mark_w : 17, 6, width >= 120 ? 24 - mark_w : 9, 18, 6, 36];
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
    if (this.managing) return null;
    if (x <= b.x || x >= b.x + b.w - 1 || y < b.y + 2) return null;
    const index = y - b.y - 2;
    return index < this.count() ? this.rowAt(index) : null;
  }
  /** A provider's or an account's row under a pointer. */
  private agentHit(cols: number, rowsCount: number, side: SidebarView, x: number, y: number): Row | null {
    if (this.managing) return null;
    const row = this.hit(cols, rowsCount, side, x, y);
    return row !== null && this.launchOf(row) !== null ? row : null;
  }
  /** The row whose YOLO toggle is under a pointer. */
  yoloHit(cols: number, rowsCount: number, side: SidebarView, x: number, y: number): Row | null {
    const row = this.agentHit(cols, rowsCount, side, x, y);
    if (row === null || adapter(this.launchOf(row)!.provider).bypass === false) return null;
    const b = this.bounds(cols, rowsCount, side);
    if (b.w < 24 || b.h < this.rowsHeight()) return null;
    const widths = this.columns(b.w);
    const start = b.x + 3 + widths[0];
    return x >= start && x < start + sat(widths[1], 2) ? row : null;
  }
  trackable(row: Row): boolean {
    const o = this.launchOf(row) !== null ? this.optionOf(row) : null;
    return o !== null && this.consenting(o) && this.signsIn(row) === null;
  }
  /** Usage waits on the user's consent to read it. */
  private consenting(o: Option): boolean {
    return !this.managing && !(o.pending ?? this.preview.pending) && o.usage_needs_consent;
  }
  usageHit(cols: number, rowsCount: number, side: SidebarView, x: number, y: number): Row | null {
    const row = this.agentHit(cols, rowsCount, side, x, y);
    if (row === null || adapter(this.launchOf(row)!.provider).bypass === false) return null;
    const b = this.bounds(cols, rowsCount, side);
    if (b.w < 24 || b.h < this.rowsHeight()) return null;
    const widths = this.columns(b.w);
    const start = b.x + 3 + widths[0] + widths[1] + widths[2] + widths[3] + widths[4];
    return x >= start && x < start + sat(widths[5], 1) ? row : null;
  }
  resumeContext(): launcherResume.Context {
    return new launcherResume.Context(
      this.history,
      this.destination(),
      this.workspace_cwd,
      this.open,
      now(),
      this.accounts,
      this.preview.names,
    );
  }
  /** Where agents start: the new worktree named for them, else `cwd`. */
  destination(): string {
    return this.worktree.planned?.path ?? this.cwd;
  }
  place() {
    return launcherWorktree.place(this.worktrees, this.cwd, this.worktree.planned);
  }
  /** Where agents start, which the agent list lights as the overview lights
   * a browsed worktree: a linked worktree's group, a new one's (none yet),
   * or with no path, the workspace's own rows. */
  spotlight(): Spotlight | null {
    if (this.managing) return null;
    const planned = this.worktree.planned;
    if (planned) return { workspace: this.workspace, path: planned.path };
    const at = launcherWorktree.containing(this.worktrees, this.cwd);
    return { workspace: this.workspace, path: at && !at.primary ? at.path : null };
  }
  /** The title's worktree button, in 0-based cells; null when it has none. */
  worktreeButton(cols: number, rowsCount: number, side: SidebarView): Rect | null {
    if (this.managing) return null;
    const b = this.bounds(cols, rowsCount, side);
    const p = this.place();
    const span = p.worktree ? launcherWorktree.button(b, p, Menu.titleRight(b)) : null;
    return span ? new Rect(span.x, b.y, span.w, 1) : null;
  }
  worktreeChoices(): dropdown.Choice[] {
    return launcherWorktree.choices(this.worktrees, this.cwd, this.worktree);
  }
  /** The open box's parts, in 0-based cells. */
  worktreeBox(cols: number, rowsCount: number, side: SidebarView): launcherWorktree.Box | null {
    const button = this.worktreeButton(cols, rowsCount, side);
    if (!button || this.worktree.mode === "closed") return null;
    const b = this.bounds(cols, rowsCount, side);
    const count = this.worktree.count(this.worktrees);
    const picks = this.worktree.focus === "from" ? launcherWorktree.pickChoices(this.worktree, now()).length : 0;
    return launcherWorktree.box(b, button.x, count, this.worktree.error.length > 0, picks);
  }
  /** From's branch list under its field, while From has the caret. */
  worktreePickRect(cols: number, rowsCount: number, side: SidebarView): Rect | null {
    const bx = this.worktreeBox(cols, rowsCount, side);
    if (!bx || this.worktree.focus !== "from" || bx.picks === 0) return null;
    launcherWorktree.pickChoices(this.worktree, now(), bx.picks);
    return launcherWorktree.pickRect(bx);
  }
  /** What a pointer is on in the open box: a checkout, a field, or a branch in From's list. */
  worktreeHit(cols: number, rowsCount: number, side: SidebarView, x: number, y: number): launcherWorktree.Spot | null {
    const pick = this.worktreePickRect(cols, rowsCount, side);
    if (pick?.contains(x, y))
      return this.worktree.branches === null || this.worktree.matches().length === 0
        ? null
        : { pick: this.worktree.pick_scroll + y - pick.y };
    const bx = this.worktreeBox(cols, rowsCount, side);
    if (!bx || x <= bx.rect.x || x >= bx.rect.x + bx.rect.w - 1) return null;
    if (y >= bx.list && y < bx.list + bx.shown) {
      launcherWorktree.visible(this.worktree, this.worktreeChoices(), bx.shown);
      const index = this.worktree.scroll + y - bx.list;
      return index < this.worktree.count(this.worktrees) ? { checkout: index } : null;
    }
    if (y === bx.branch) return "branch";
    if (y === bx.from && this.worktree.creating(this.worktrees)) return "from";
    if (y === bx.footer && x >= bx.field_x) return "confirm";
    return null;
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
  /** The column the title's own text stops before: Manage, or the corner. */
  private static titleRight(b: Rect): number {
    const span = Menu.manageSpan(b);
    return span ? span.x - 1 : b.x + b.w - 2;
  }
  private drawTitle(w: Writer, b: Rect, panel: string): void {
    const p = this.place();
    launcherWorktree.drawTitle(w, b, p, Menu.titleRight(b), this.worktree.mode !== "closed", panel);
    const span = Menu.manageSpan(b);
    if (!span) return;
    // Like a footer hint: a keycap, then a faint label.
    w.write(`\x1b[${b.y + 1};${span.x + 1}H${panel} `);
    writeKey(w, "→", panel);
    w.write(manage_label);
  }
  private static drawFooter(w: Writer, b: Rect, panel: string, what: string, hints: Hint[]): void {
    let hint_width = 0;
    hints.forEach((hint, i) => (hint_width += displayWidth(hint.key) + 2 + 1 + hint.label.length + (i > 0 ? 2 : 0)));
    const footer_row = b.y + b.h - 1;
    w.write(`\x1b[${footer_row};${b.x + 3}H${panel}`);
    writeEllipsis(w, what, sat(b.w, hint_width + 6));
    w.write(`\x1b[${footer_row};${b.x + b.w - 1 - hint_width}H`);
    hints.forEach((hint, i) => {
      if (i > 0) w.write("  ");
      writeKey(w, hint.key, panel);
      w.write(` ${hint.label}`);
    });
  }
  input(): Dialog {
    return this.managing ? this.manager.input() : this.worktree.input();
  }
  /** Opens Manage agents in the card with its own selection. */
  manage(at = milliTimestamp()): void {
    if (this.managing) return;
    this.transition.start(1, at);
    this.managing = true;
    this.manager.open();
    this.pinned = true;
  }
  /** Returns to the picker with its selection and conversation search intact. */
  back(at = milliTimestamp()): void {
    if (!this.managing) return;
    this.transition.start(-1, at);
    this.managing = false;
    this.normalize();
  }
  /** What Manage agents lists: each provider's and its accounts', as the
   * launcher orders them, whether its agent is there or not. */
  manageModel(): agentManager.Model {
    const agents: agentManager.Agent[] = [];
    for (const row of this.rows()) {
      const l = this.launchOf(row),
        o = this.optionOf(row);
      if (!l || !o) continue;
      const a = this.accountOf(row),
        installed = this.preview.installed[l.provider],
        out = installed && o.signed_in === false;
      agents.push({
        ...(this.profileOf(row) ? { profile: this.profileOf(row)!.id } : {}),
        provider: l.provider,
        account: l.account,
        name: this.profileOf(row)?.name ?? (l.account ? (a?.name ?? "") : this.preview.names[l.provider]),
        label: this.label(row),
        who: !installed
          ? this.preview.outdated[l.provider]
            ? `${this.preview.outdated[l.provider]} · needs ${adapter(l.provider).requires ?? "an update"}`
            : "Not installed"
          : out
            ? "Not signed in"
            : o.account || ((o.pending ?? this.preview.pending) ? "Reading…" : "Unavailable"),
        signed_out: out,
        shown: !this.hiddenOf(row),
        here: !this.workspace_hidden.includes(row),
        managed: a?.managed ?? false,
        usage: !installed || out || o.usage_needs_consent ? Cell.status("—") : this.usageCell(row),
      });
    }
    return {
      agents,
      commands: this.commands,
      workspace: this.workspace_name,
      here: index => !this.workspace_hidden.includes(Row.ofCommand(index)),
      add: providers.filter(p => this.preview.installed[p] && adapter(p).accounts.signin !== null),
      account: info => this.account(info),
      suggest: a => accounts.suggest(a.provider, accounts.identity(a.provider, a.account), a.account),
      options: a =>
        (a.profile ? this.profiles.find(p => p.id === a.profile)?.options : null) ??
        accounts.launchOptions(a.provider, a.account),
      order: this.rows(),
    };
  }
  account(info: Semantics): string {
    if (info.account.length > 0) return info.account;
    if (info.default_account && info.provider) {
      const o = this.preview.options[info.provider];
      return o.account.length > 0
        ? o.account
        : (o.pending ?? this.preview.pending)
          ? "Reading default account…"
          : "Default account · unavailable";
    }
    return "Account unknown";
  }
  /** A field on `selected`: its text in `fg`, its selection while focused, or the placeholder. */
  private static drawInput(
    w: Writer,
    editor: Dialog,
    placeholder: string,
    x: number,
    y: number,
    width: number,
    focused: boolean,
    fg: palette.Token = "text",
  ): void {
    const plain = new Style({ fg, bg: "selected" }).sgr();
    w.write(`\x1b[${y};${x}H` + plain);
    w.splat(" ", width);
    w.write(`\x1b[${y};${x}H`);
    if (editor.len === 0) writeEllipsis(w, placeholder, width);
    else writeField(w, editor, DialogView.scroll(editor, width), width, plain, { selecting: focused });
    w.write(new Style({ fg: "text", bg: "surface" }).sgr());
  }
  draw(w: Writer, cols: number, rowsCount: number, side: SidebarView): void {
    const body = new Writer();
    this.drawCard(body, cols, rowsCount, side);
    this.transition.draw(w, body.s, this.bounds(cols, rowsCount, side), cols, rowsCount);
  }
  private drawCard(w: Writer, cols: number, rowsCount: number, side: SidebarView): void {
    const m = this;
    const b = m.bounds(cols, rowsCount, side);
    if (m.managing) {
      if (b.w >= 40 && b.h >= m.manager.minimumHeight()) m.manager.draw(w, b, m.manageModel());
      return;
    }
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
    m.drawTitle(w, b, panel);
    // Images can't follow the card as it slides; its glyphs can.
    const marks = m.transition.active ? null : m.marks;
    const widths = m.columns(b.w);
    let heading_x = b.x + 4;
    headings.forEach((heading, column) => {
      const width = widths[column];
      if (width === 0) return;
      w.write(`\x1b[${b.y + 2};${heading_x + (column === 0 ? 4 + mark_w : 0)}H${panel}`);
      const room = sat(width, column === 0 ? 6 + mark_w : column === 5 ? 1 : 2);
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
      const row = b.y + 3 + visible;
      const style = selected
        ? new Style({ fg: "strong", bg: "selected" }).sgr()
        : new Style({ fg: "text", bg: "surface" }).sgr();
      w.write(`\x1b[${row};${b.x + 2}H${style}`);
      w.splat(" ", b.w - 2);
      w.write(`\x1b[${row};${b.x + 2}H${selected ? "›" : " "}`);
      if (Row.starts(current)) {
        w.write(`\x1b[${row};${b.x + 4}H`);
        writeKey(w, String.fromCharCode(48 + visible), style);
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
      const values = custom !== null ? m.customCells(custom) : m.cells(current);
      const yolo = custom !== null ? m.commands[custom].semantics.yolo : m.yoloOf(current);
      // The agent's brand mark leads its name.
      const provider = m.providerOf(current);
      if (provider && widths[0] > 0) {
        // This card writes 1-based positions; marks take 0-based cells.
        writeMark(w, provider, x + 3, row - 1, marks);
        w.write(style);
      }
      if (custom === null) values[0] = m.label(current, sat(widths[0], 6 + mark_w));
      widths.forEach((width, column) => {
        if (width === 0) return;
        w.write(`\x1b[${row};${x + (column === 0 ? 4 + mark_w : 0)}H`);
        if (column === 5 && m.trackable(current)) w.write("\x1b[4m");
        if (column === 1 && yolo) w.write("\x1b[1m" + palette.fg("strong"));
        const room = sat(width, column === 0 ? 6 + mark_w : column === 5 ? 1 : 2);
        if (column === 5) m.usageCell(current).write(w, grid, room, style, selected);
        else if (column === 2 && custom === null) {
          const model = m.modelCell(current);
          writeModel(w, model.name, model.effort, room, style);
        } else writeEllipsis(w, values[column], room);
        w.write("\x1b[24m");
        if (column === 1 && yolo) w.write(style);
        x += width;
      });
    }
    if (m.hasResume()) {
      // A rule across the gap between the agents and the conversations.
      w.write(`\x1b[${m.resumeTop(b) - 1};${b.x + 4}H${rule}`);
      w.write("─".repeat(b.w - 6));
      if (m.resume_view.expanded) m.resume_view.draw(w, m.resumeContext(), m.resumeArea(cols, rowsCount, side), marks);
      else m.resume_view.drawCollapsed(w, m.resumeContext(), b.x + 1, m.resumeTop(b), b.w, marks);
    }
    const view = m.resume_view;
    const c = m.resumeContext();
    const on_more = view.focused && view.entry(c, view.lines(c)) === null;
    let hints: Hint[];
    if (m.worktree.mode === "open" && m.worktree.focus === "from")
      hints = [
        { key: "↑↓", label: "pick" },
        { key: "↵", label: "use" },
        { key: "esc", label: "back" },
      ];
    else if (m.worktree.mode === "open")
      hints = [
        { key: "↑↓", label: "choose" },
        ...(m.worktree.creating(m.worktrees) ? [{ key: "tab", label: "from" }] : []),
        { key: "esc", label: "close" },
      ];
    else if (view.searching && view.query.len > 0)
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
    else if (Row.custom(m.selected) !== null) hints = [{ key: "a", label: "launch" }];
    else if (m.selected === "terminal") hints = [{ key: "a", label: "open" }];
    else if (m.trackable(m.selected))
      hints = [
        { key: "u", label: "Track usage" },
        { key: "a", label: "launch" },
        { key: "y", label: "YOLO" },
      ];
    else
      hints = [
        { key: "a", label: m.signsIn(m.selected) ? "sign in" : "launch" },
        { key: "y", label: "YOLO" },
      ];
    const launch = m.launchOf(m.selected);
    if (launch && adapter(launch.provider).bypass === false) hints = hints.filter(h => h.key !== "y");
    const planned = m.worktree.planned;
    const what = !planned
      ? "new tab"
      : m.worktree.adding
        ? `adding ${launcherWorktree.folderLabel(planned.path, launcherWorktree.projectRoot(m.worktrees, m.cwd))}…`
        : `new worktree from ${planned.base_name} · new tab`;
    Menu.drawFooter(w, b, panel, what, hints);
    w.write("\x1b[0m\x1b[?25l");
    const bx = m.worktreeBox(cols, rowsCount, side);
    if (bx) m.drawWorktreeBox(w, bx, cols, rowsCount, side);
  }
  /** Branch searches the checkouts and offers creation alongside its matches. */
  private drawWorktreeBox(
    w: Writer,
    bx: launcherWorktree.Box,
    cols: number,
    rowsCount: number,
    side: SidebarView,
  ): void {
    const c = this.worktree,
      r = bx.rect;
    const at = (x: number, y: number) => `\x1b[${y + 1};${x + 1}H`;
    const text = new Style({ fg: "text", bg: "surface" }).sgr(),
      panel = new Style({ fg: "faint", bg: "surface" }).sgr(),
      rule = new Style({ fg: "line", bg: "surface" }).sgr();
    dropdown.draw(w, r, []);
    w.write(at(r.x + 2, r.y) + text + " Worktree " + rule);
    launcherWorktree
      .visible(c, this.worktreeChoices(), bx.shown)
      .forEach((choice, i) => dropdown.row(w, r, bx.list - r.y + i, choice));
    const label = (y: number, name: string) => w.write(at(bx.label_x, y) + panel + name);
    // The text is strong, a placeholder faint.
    const input = (d: Dialog, placeholder: string, y: number, focused: boolean) =>
      Menu.drawInput(w, d, placeholder, bx.field_x + 1, y + 1, bx.field_w, focused, d.len === 0 ? "faint" : "strong");
    label(bx.branch, "Branch");
    input(c.field, "search or create", bx.branch, c.focus === "branch");
    const selected = c.selected(this.worktrees),
      creating = c.creating(this.worktrees);
    if (creating) {
      label(bx.from, "From");
      const from = c.focus === "from" ? c.from : Dialog.init({ rename: 0 }, c.base?.name ?? "");
      input(from, "", bx.from, c.focus === "from");
    }
    label(bx.folder, "Folder");
    w.write(at(bx.field_x, bx.folder) + text);
    const root = launcherWorktree.projectRoot(this.worktrees, this.cwd),
      path =
        selected?.path ??
        (creating
          ? launcherWorktree.plannedPath(this.worktrees, this.cwd, c.field.name(), this.worktree_folder)
          : this.cwd);
    writeEllipsis(w, launcherWorktree.folderLabel(path, root), bx.field_w);
    label(bx.footer, "↑↓ choose");
    const action =
      c.focus === "from" ? "↵ use branch" : creating ? "hold ↵ to create" : selected ? "↵ switch" : "type to search";
    w.write(at(r.x + r.w - displayWidth(action) - 3, bx.footer) + text + action);
    if (c.create.progress > 0)
      w.write(
        at(r.x + 1, r.y + r.h - 1) + palette.fg("accent") + "━".repeat(Math.floor((r.w - 2) * c.create.progress)),
      );
    if (bx.error !== null) {
      w.write(at(bx.label_x, bx.error) + palette.fg("hot"));
      writeEllipsis(w, c.error, sat(r.x + r.w - 2, bx.label_x));
    }
    // From's branches on the field's own background, its width, so the field
    // opens downward; the highlighted one a step lighter.
    const pick = this.worktreePickRect(cols, rowsCount, side);
    if (pick) {
      const message = c.branches === null || c.matches().length === 0;
      launcherWorktree.pickChoices(c, now(), pick.h).forEach((choice, i) => {
        const style = new Style(choice.hovered ? { fg: "strong", bg: "line" } : { fg: "text", bg: "selected" }).sgr();
        const note_x = pick.x + pick.w - displayWidth(choice.note);
        w.write(at(pick.x, pick.y + i) + style);
        w.splat(" ", pick.w);
        w.write(at(note_x, pick.y + i) + palette.fg(choice.hovered ? "muted" : "faint") + choice.note);
        w.write(at(pick.x, pick.y + i) + (message ? palette.fg("faint") : style));
        writeEllipsis(w, choice.text, sat(note_x - 1, pick.x));
      });
    }
    // The caret, where the focused field's text ends or the cursor stands.
    const field = c.input(),
      offset = DialogView.scroll(field, bx.field_w),
      caret = Math.min(sat(bx.field_w, 1), displayWidth(field.bytes(offset, field.cursor)));
    const y = c.focus === "from" ? bx.from : bx.branch;
    w.write(`\x1b[0m${at(bx.field_x + caret, y)}\x1b[?25h`);
  }
}
function cleanControls(text: string): string {
  return Buffer.from(Uint8Array.from(Buffer.from(text), ch => (ch < 32 || ch === 127 ? 32 : ch))).toString();
}
