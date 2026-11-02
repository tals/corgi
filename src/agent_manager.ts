import * as i18n from "./i18n";
//! Manage agents: the accounts agents start in and the saved commands, under
//! a search, then Add agent: a strip of agents whose focused one lists the
//! accounts found for it, to add back what was removed or sign in to a new
//! one, beside a saved command's. It draws in a box its host gives it, takes
//! keys and clicks, and answers with an `Action` for the host to carry out;
//! what it lists comes from the host's `Model`. The launcher shows it in
//! its card; settings shows it beside its section list.
import * as palette from "./palette";
import { Style, keycap } from "./palette";
import { type Provider, adapter } from "./providers";
import { Rect } from "./layout";
import { Dialog, View as DialogView, writeField } from "./name_dialog";
import { matches } from "./search";
import { Entry as CommandEntry, Semantics, Resolution } from "./launch/command";
import * as keys from "./keys";
import { Writer, displayWidth, writeEllipsis, ellipsis, sat, clamp, shortPath, byteLength, byteSlice } from "./text";
import { Grid } from "./cell_grid";
import { KeyHold } from "./key_hold";
import { milliTimestamp } from "./clock";
import * as worktreeRemoval from "./worktree_removal";
import * as launcherUsage from "./launcher_usage";
import * as agentForm from "./agent_form";
import type { Options } from "./agent_options";
import { Slide } from "./card_transition";
import type { Effort } from "./providers/effort";
import * as agentModels from "./agent_models";
import * as agentName from "./agent_name";
import { Row } from "./launch/row";
import * as launcherOrder from "./launch/order";
import { Model as AgentModel } from "./providers/model";
import { Preview, writeExit, writeTint } from "./sidebar";
import * as rowGlide from "./row_glide";
import type { Cell as PixelCell } from "./fork_hero";
import { writeMark, type Marks } from "./provider_mark";

/** An account an agent starts in, as the list shows it. */
export type Agent = {
  profile?: string;
  provider: Provider;
  /** Its folder; "" for the default. */
  account: string;
  /** "" for the default, which goes by its agent's name. */
  name: string;
  /** Its row's name, such as `Claude Code · work`. */
  label: string;
  /** Who signed in, or why that's unknown. */
  who: string;
  signed_out: boolean;
  shown: boolean;
  /** It shows in the current workspace's launcher, once it's in the launcher. */
  here: boolean;
  /** Corgi made its folder. */
  managed: boolean;
  usage: launcherUsage.Cell;
};
/** An agent Add agent offers, with the accounts found for it. */
export type Offer = {
  provider: Provider;
  installed: boolean;
  /** Corgi can sign in to a new account of it. */
  signin: boolean;
};
/** An account taken out of the list whose folder is still there. */
export type Removed = { provider: Provider; account: string; name: string };
/** What the host has to list. */
export type Model = {
  agents: Agent[];
  /** The saved commands' slots; an empty one lists nothing. */
  commands: CommandEntry[];
  /** The current workspace's name, which the Show column's toggles apply to. */
  workspace: string;
  /** Whether saved command `index` shows in the current workspace's launcher. */
  here(index: number): boolean;
  /** The agents Add agent lists, in order. */
  offers: Offer[];
  /** Accounts removed from the list that can be added back. */
  removed: Removed[];
  /** Where an account keeps its settings, as the user would write it. */
  folder(provider: Provider, account: string): string;
  /** The account a saved command's agent runs in, for its form. */
  account(info: Semantics): string;
  /** A name for an account, from who signed in to it. */
  suggest(agent: Agent): string;
  options(agent: Agent): Options;
  order?: Row[];
};
/** What a key or click asks the host to do. */
export type Action =
  | { kind: "close" }
  | { kind: "back" }
  | { kind: "show"; agent: Agent }
  | { kind: "show_command"; index: number }
  | { kind: "here"; agent: Agent; shown: boolean }
  | { kind: "here_command"; index: number; shown: boolean }
  | { kind: "configure"; agent: Agent; name: string; options: Options }
  | { kind: "clone"; agent: Agent; name: string; options: Options }
  | { kind: "models"; agent: Agent; picker: agentModels.Picker }
  | { kind: "model"; agent: Agent; model: string; effort?: Effort }
  | { kind: "move"; row: Row; before: Row | null; shown: boolean; order: Row[] }
  | { kind: "remove"; agent: Agent }
  | { kind: "remove_command"; index: number }
  | { kind: "add"; provider: Provider }
  | { kind: "restore"; provider: Provider; account: string }
  | { kind: "save" };

/** A row: the list's accounts and commands, then Add agent's strip, open on
 * the focused agent's accounts, listed or not, and what can be added. */
type Item =
  | { kind: "agent"; agent: Agent }
  | { kind: "command"; index: number }
  | { kind: "tile"; tile: Tile }
  | { kind: "found"; agent: Agent }
  | { kind: "removed"; removed: Removed }
  | { kind: "add"; provider: Provider }
  | { kind: "custom" };
/** One of Add agent's agents, or saved commands. */
type Tile = Provider | "custom";
const foundKey = (provider: Provider, account: string) => `found:${provider}:${account}`;
/** An account's name beside its agent's mark: the one it was given, else its agent's. */
const title = (a: Agent) => a.name || adapter(a.provider).label;
/** The agent whose mark a row of the list wears; none for a command that
 * runs another program, nor under Add agent, whose strip has them. */
function markOf(item: Item, model: Model): Provider | null {
  if (item.kind === "agent") return item.agent.provider;
  return item.kind === "command" ? model.commands[item.index].semantics.provider : null;
}
/** Whether a key names one of Add agent's rows or its strip. */
const adding = (key: string) => /^(tile|found|removed|add):|^custom$/.test(key);
/** An Add agent row that adds something: not one already in the list. */
const addable = (item: Item) =>
  item.kind === "removed" ||
  item.kind === "add" ||
  item.kind === "custom" ||
  (item.kind === "found" && !item.agent.shown);
function itemKey(item: Item): string {
  switch (item.kind) {
    case "agent":
      return item.agent.profile
        ? `profile:${item.agent.profile}`
        : `agent:${item.agent.provider}:${item.agent.account}`;
    case "command":
      return `command:${item.index}`;
    case "tile":
      return `tile:${item.tile}`;
    case "found":
      return foundKey(item.agent.provider, item.agent.account);
    case "removed":
      return `removed:${item.removed.provider}:${item.removed.account}`;
    case "add":
      return `add:${item.provider}`;
    case "custom":
      return "custom";
  }
}
/** The key of an agent's row, to open the list on it. */
export const agentKey = (provider: Provider, account: string) => `agent:${provider}:${account}`;
export const agentRow = (agent: Agent): Row =>
  agent.profile ? Row.ofProfile(agent.profile) : Row.of(agent.provider, agent.account);
function itemRow(item: Item): Row | null {
  return item.kind === "agent" ? agentRow(item.agent) : item.kind === "command" ? Row.ofCommand(item.index) : null;
}
function cleanControls(text: string): string {
  return text.replace(/[\x00-\x1f\x7f]/g, " ");
}
type Hint = [key: string, label: string];
type Line = { item: Item | null; section: "have" | "hidden" | "add"; heading: boolean; empty: boolean; strip: boolean };
type Removal = {
  item: Item;
  label: string;
  detail: string;
  note: string;
  section: "have" | "hidden" | "add";
  index: number;
  phase: "held" | "removing" | "removed";
  committed_at: number;
};

/** A saved command's form: its command line and name, as Corgi resolves them. */
export class Form {
  editor = Object.assign(Dialog.init({ agent_command: 0 }, ""), { selected: false });
  name_editor = Object.assign(Dialog.init({ agent_name: null }, ""), { selected: false });
  name_focused = false;
  show_command = false;
  name_customized = false;
  /** The command it edits; null for a new one. */
  edit_index: number | null = null;
  save_error = "";
  draft = new CommandEntry();
  draft_changed = 0;
  request_id = 0;
  resolution_checked = 0;
  resolution = new Resolution();
  save_requested = false;

  /** Opens on command `index` of `commands`, or empty for a new one. */
  edit(index: number | null, commands: CommandEntry[]): void {
    this.draft = new CommandEntry();
    this.request_id = 0;
    this.resolution = new Resolution();
    this.save_requested = false;
    this.save_error = "";
    this.edit_index = index;
    const source = index !== null ? commands[index].inputText() : "";
    this.editor = Dialog.init({ agent_command: 0 }, source);
    this.name_focused = false;
    this.show_command = false;
    this.name_customized = index !== null;
    this.name_editor = Dialog.init({ agent_name: null }, index !== null ? commands[index].label() : "");
    if (index !== null) {
      try {
        this.draft.set(source);
      } catch {}
      const resolved = new Resolution();
      resolved.pending = false;
      resolved.command = commands[index];
      resolved.semantics = commands[index].semantics;
      this.resolution = resolved;
    }
  }
  input(): Dialog {
    return this.name_focused ? this.name_editor : this.editor;
  }
  /** Rows it takes: its fields, what Corgi resolved, and its buttons. */
  height(): number {
    return 18 + (this.show_command ? 2 : 0);
  }
  /** The row its fields start on, and its buttons'. */
  private static top = (b: Rect) => b.y + 2;
  private actions = (b: Rect) => Form.top(b) + 12 + (this.show_command ? 2 : 0);

  draw(w: Writer, b: Rect, model: Model): void {
    const at = (x: number, y: number) => `\x1b[${y + 1};${x + 1}H`,
      panel = new Style({ fg: "text", bg: "surface" }).sgr(),
      dim = palette.fg("faint"),
      top = Form.top(b),
      width = sat(b.w, 10);
    for (let i = 0; i < 2; i++) {
      const y = top + i * 4,
        focused = this.name_focused === (i === 1);
      w.write(at(b.x + 3, y) + dim + (i === 0 ? i18n.t`Command` : i18n.t`Name`));
      const border = focused ? palette.fg("accent") : palette.fg("line");
      for (let line = 0; line < 3; line++) {
        w.write(at(b.x + 3, y + line + 1) + border + (line === 0 ? "┌" : line === 2 ? "└" : "│"));
        if (line !== 1) w.write("─".repeat(width + 2));
        else w.splat(" ", width + 2);
        w.write(line === 0 ? "┐" : line === 2 ? "┘" : "│");
      }
      w.write(panel);
      field(
        w,
        i === 0 ? this.editor : this.name_editor,
        i === 0 ? i18n.t`Paste a command…` : i18n.t`Suggested automatically`,
        b.x + 5,
        y + 2,
        width,
        focused,
      );
    }
    w.write(panel);
    if (this.editor.len > 0 || (this.editor.failed && this.save_error)) {
      const same = this.draft.text() === this.editor.name(),
        resolved =
          same && !this.editor.failed && !this.resolution.pending && this.resolution.error_message.length === 0,
        status =
          this.editor.failed && this.save_error.length > 0
            ? this.save_error
            : this.editor.overflow
              ? i18n.t`Command too long`
              : !same || this.resolution.pending
                ? i18n.t`Resolving command…`
                : this.resolution.error_message.length > 0
                  ? this.resolution.error_message
                  : model.account(this.resolution.semantics);
      const info = this.resolution.semantics,
        provider = info.provider ? adapter(info.provider).label : i18n.t`Custom agent`;
      w.write(at(b.x + 3, top + 9));
      writeEllipsis(w, resolved ? `${provider} · ${status}` : status, b.w - 8);
      w.write(at(b.x + 3, top + 10) + dim);
      if (resolved) {
        const mode = info.yolo ? info.mode : "";
        writeEllipsis(
          w,
          `${info.modelLabel()}${info.model.length > 0 && mode.length > 0 ? " · " : ""}${mode}`,
          b.w - 26,
        );
        const label = this.commandLabel();
        w.write(at(b.x + b.w - displayWidth(label) - 4, top + 10) + label);
        if (this.show_command) {
          w.write(at(b.x + 3, top + 12) + i18n.t`Runs: `);
          writeEllipsis(w, cleanControls(this.resolution.command.text()), b.w - 14);
        }
      }
    }
    const cancel = i18n.t`[Cancel]`,
      save = this.saveLabel();
    w.write(
      panel + at(b.x + b.w - displayWidth(cancel) - displayWidth(save) - 6, this.actions(b)) + `${cancel}  ${save}`,
    );
  }
  private commandLabel(): string {
    return this.show_command ? i18n.t`[Hide command]` : i18n.t`[Show command]`;
  }
  private saveLabel(): string {
    return this.edit_index !== null ? i18n.t`[Save]` : i18n.t`[Add]`;
  }
  /** Where the caret goes, 0-based. */
  caret(b: Rect): { x: number; y: number } {
    const editor = this.input(),
      width = sat(b.w, 10),
      offset = DialogView.scroll(editor, width),
      column = Math.min(sat(width, 1), displayWidth(editor.bytes(offset, editor.cursor)));
    return { x: b.x + 5 + column, y: Form.top(b) + 2 + (this.name_focused ? 4 : 0) };
  }
  /** A click at (`x`, `y`): a field takes the caret; its buttons save, cancel, or show what runs. */
  click(b: Rect, x: number, y: number): "save" | "cancel" | null {
    const top = Form.top(b),
      actions = this.actions(b);
    if (y === actions && x >= b.x + b.w - displayWidth(this.saveLabel()) - 4) return "save";
    if (y === actions && x >= b.x + b.w - displayWidth(this.saveLabel()) - displayWidth(i18n.t`[Cancel]`) - 6)
      return "cancel";
    if (y === top + 10 && x >= b.x + b.w - displayWidth(this.commandLabel()) - 4)
      this.show_command = !this.show_command;
    else if (y === top + 2 || y === top + 6) {
      this.name_focused = y === top + 6;
      const width = sat(b.w, 10),
        editor = this.input(),
        offset = DialogView.scroll(editor, width);
      editor.position(editor.byteAtColumn(offset, sat(x, b.x + 5)));
    }
    return null;
  }
}
/** A field on `selected`: its text, its selection while focused, or the placeholder. */
function field(
  w: Writer,
  editor: Dialog,
  placeholder: string,
  x: number,
  y: number,
  width: number,
  focused: boolean,
  bg: palette.Token = "selected",
  hint: palette.Token = "text",
): void {
  const plain = new Style({ fg: "text", bg }).sgr();
  w.write(`\x1b[${y + 1};${x + 1}H` + plain);
  w.splat(" ", width);
  w.write(`\x1b[${y + 1};${x + 1}H`);
  if (editor.len === 0) {
    w.write(palette.fg(hint));
    writeEllipsis(w, placeholder, width);
  } else writeField(w, editor, DialogView.scroll(editor, width), width, plain, { selecting: focused });
  w.write(new Style({ fg: "text", bg: "surface" }).sgr());
}

/** The list and its agent and saved-command editors. */
export class View {
  last_box: Rect | null = null;
  cell: PixelCell | null = null;
  /** Places brand marks where the host shows images; the glyph otherwise. */
  marks: Marks | null = null;
  /** The agent Add agent shows the accounts of, while no row of its is selected. */
  tile: Tile | null = null;
  /** Add agent opened since the list did, and keeps the room it took. */
  private grown = false;
  pointer_at: { x: number; y: number } | null = null;
  private glide: {
    key: string;
    from: number;
    section: "have" | "hidden";
    requested: number;
    started: number | null;
    ms: number;
    query: string;
  } | null = null;
  page: "list" | "command" | "agent" = "list";
  agent_form = new agentForm.Form();
  transition = new Slide();
  back: "launcher" | "settings" = "launcher";
  private backText(): string {
    return this.back === "settings" ? i18n.t`Settings` : i18n.t`New tab`;
  }
  private first = 0;
  focus: "search" | "list" = "list";
  query = Dialog.init({ agent_name: null }, "");
  /** The selected row's key. */
  at = "";
  /** The row being buried, kept until the corgi has left. */
  removal: Removal | null = null;
  private hold = new KeyHold(worktreeRemoval.hold_ms, worktreeRemoval.heal_ms);
  /** What went wrong with the last action, in place of the keys. */
  error = "";
  form = new Form();
  picker: { view: agentModels.Picker; agent: Agent; editing: boolean } | null = null;
  empty_section: "have" | "hidden" | null = null;
  drag: {
    item: Item;
    x: number;
    y: number;
    active: boolean;
    drop: { before: Row | null; shown: boolean; y: number } | null;
    width: number;
    height: number;
    ids: string[];
    again: boolean;
  } | null = null;

  /** Opens on the list, at the row `at` names. */
  open(at = ""): void {
    this.page = "list";
    this.glide = null;
    this.first = 0;
    this.focus = "list";
    this.query = Dialog.init({ agent_name: null }, "");
    this.at = at;
    this.transition = new Slide();
    this.removal = null;
    this.hold = new KeyHold(worktreeRemoval.hold_ms, worktreeRemoval.heal_ms);
    this.error = "";
    this.picker = null;
    this.drag = null;
    this.empty_section = null;
    this.tile = null;
    this.grown = false;
  }
  /** The rows the search leaves: what there is, then the focused agent's
   * under Add agent. A removed account isn't listed; Add agent has it. */
  items(model: Model): { have: Item[]; hidden: Item[]; add: Item[] } {
    const q = this.query.name();
    const found: Item[] = [
      ...model.agents
        .filter(a => a.shown && matches(q, `${a.label} ${a.who}`))
        .map(agent => ({ kind: "agent" as const, agent })),
      ...model.commands.flatMap((c, index): Item[] =>
        c.command.length > 0 && matches(q, `${c.label()} ${c.text()}`) ? [{ kind: "command", index }] : [],
      ),
    ];
    const order = launcherOrder.arrange(
      found.flatMap(i => itemRow(i) ?? []),
      model.order ?? [],
    );
    found.sort((a, b) => order.indexOf(itemRow(a)!) - order.indexOf(itemRow(b)!));
    const have = found.filter(item => this.inLauncher(item, model) && this.hereOf(item, model)),
      hidden = found.filter(item => !have.includes(item)),
      r = this.removal;
    if (r && r.phase !== "held" && matches(q, `${r.label} ${r.detail}`)) {
      // Keep the burial in its original section until the corgi leaves.
      for (const items of [have, hidden]) {
        const index = items.findIndex(item => itemKey(item) === itemKey(r.item));
        if (index >= 0) items.splice(index, 1);
      }
      const items = r.section === "have" ? have : hidden;
      items.splice(Math.min(r.index, items.length), 0, r.item);
    }
    const tile = this.current(model);
    return {
      have,
      hidden,
      add: tile === null ? [] : adding(this.at) ? this.entries(model, tile) : [{ kind: "tile", tile }],
    };
  }
  /** `tile` on the strip, then what it lists. */
  private entries(model: Model, tile: Tile): Item[] {
    return [{ kind: "tile", tile }, ...this.details(model, tile)];
  }
  /** What Add agent lists under `tile` that the search leaves: its accounts,
   * listed or removed, then a new one where Corgi can sign in. */
  private details(model: Model, tile: Tile): Item[] {
    const q = this.query.name();
    if (tile === "custom") return matches(q, "add new custom command") ? [{ kind: "custom" }] : [];
    const offer = model.offers.find(o => o.provider === tile),
      label = adapter(tile).label,
      every = matches(q, `add new account ${label}`);
    return [
      ...model.agents
        .filter(a => a.provider === tile && !a.profile && (every || matches(q, `${a.label} ${a.who}`)))
        .map(agent => ({ kind: "found" as const, agent })),
      ...model.removed
        .filter(r => r.provider === tile && (every || matches(q, `${label} ${r.name} ${r.account}`)))
        .map(removed => ({ kind: "removed" as const, removed })),
      ...(offer?.installed && offer.signin && every ? [{ kind: "add" as const, provider: tile }] : []),
    ];
  }
  /** Add agent's agents that list something the search leaves. */
  private tiles(model: Model): Tile[] {
    return [...model.offers.map(o => o.provider), "custom" as const].filter(t => this.details(model, t).length > 0);
  }
  /** The agent whose accounts Add agent shows: that of the selected row of
   * Add agent's, else the last one focused on its strip. The list's rows
   * leave it where it was. */
  private current(model: Model): Tile | null {
    const tiles = this.tiles(model),
      named = this.at === "custom" ? "custom" : /^(?:tile|found|removed|add):([^:]+)/.exec(this.at)?.[1];
    return (
      tiles.find(t => t === named) ?? (this.tile !== null && tiles.includes(this.tile) ? this.tile : (tiles[0] ?? null))
    );
  }
  /** The rows Add agent keeps under its strip: none until it opens, then
   * the most any of its agents lists, so focusing another doesn't resize
   * the box, nor does leaving it. */
  private detailRows(model: Model): number {
    this.grown ||= adding(this.at);
    return this.grown ? Math.max(0, ...this.tiles(model).map(t => this.details(model, t).length)) : 0;
  }
  private all(model: Model): Item[] {
    const { have, hidden, add } = this.items(model);
    return [...have, ...hidden, ...add];
  }
  /** The selected row: the one `at` names, else the first. One of Add
   * agent's that went, such as a removed account added back, leaves its
   * agent's first row selected. */
  selected(model: Model): Item | null {
    if (this.empty_section) return null;
    const { have, hidden, add } = this.items(model),
      all = [...have, ...hidden, ...add];
    // A key that went selects its agent's first row in Add agent, or else a
    // row of the list; never Add agent's by default.
    return all.find(i => itemKey(i) === this.at) ?? (adding(this.at) ? add[0] : [...have, ...hidden][0]) ?? null;
  }
  height(model: Model): number {
    if (this.page === "command") return this.form.height();
    if (this.page === "agent") return this.agent_form.height();
    return 10 + this.lines(model).length;
  }
  minimumHeight(): number {
    return this.page === "command" ? this.form.height() : this.page === "agent" ? 22 : 14;
  }
  /** The field that has the keyboard, which takes pastes. */
  input(): Dialog {
    if (this.picker) return this.picker.view.query;
    if (this.page === "command") return this.form.input();
    return this.page === "agent" ? this.agent_form.input() : this.query;
  }
  typing(): boolean {
    if (this.picker) return true;
    return this.page === "agent" ? this.agent_form.typing() : this.page === "command" || this.focus === "search";
  }
  paste(byte: number, model: Model): void {
    if (!this.typing()) return;
    if (this.page === "command" && this.form.name_focused) this.form.name_customized = true;
    this.input().pasteByte(byte);
    if (this.picker) {
      this.picker.view.searched();
      return;
    }
    if (this.page === "list") this.searched(model);
  }
  /** An action didn't take: retain its draft and show why. */
  fail(message: string): void {
    if (this.page === "agent") this.agent_form.error = message;
    else this.error = message;
  }
  configured(now = milliTimestamp()): void {
    this.cancelAgent(now);
    this.error = "";
  }
  /** Back on the list once a command saved, on its row. */
  saved(index: number): void {
    this.page = "list";
    this.focus = "list";
    this.at = itemKey({ kind: "command", index });
  }
  /** Opens a command's form: `index`'s, or a new one's. */
  command(index: number | null, model: Model): void {
    this.page = "command";
    this.form.edit(index, model.commands);
  }

  private move(model: Model, delta: number): void {
    this.cancelRemoval();
    const all = this.all(model);
    if (all.length === 0) {
      this.focus = "search";
      return;
    }
    if (this.empty_section) {
      const section = this.items(model)[this.empty_section];
      this.empty_section = null;
      this.at = itemKey(section[0] ?? all[delta < 0 ? all.length - 1 : 0]);
      return;
    }
    if (this.focus === "search") {
      this.focus = "list";
      this.at = itemKey(all[delta < 0 ? all.length - 1 : 0]);
      return;
    }
    // From the selected row; with none, from either end.
    const chosen = this.selected(model),
      now = chosen ? all.findIndex(i => itemKey(i) === itemKey(chosen)) : -1;
    if (now < 0) {
      this.at = itemKey(all[delta < 0 ? all.length - 1 : 0]);
      return;
    }
    const next = now + delta;
    if (next < 0 || next >= all.length) this.focus = "search";
    else this.at = itemKey(all[next]);
  }
  /** After the search changed, the selected row stays while it's listed;
   * else the first row takes it, what there is before what can be added.
   * After a removal it stays in the list, off the row that would add the
   * removed account straight back. */
  private searched(model: Model, into_add = true): void {
    this.empty_section = null;
    const { have, hidden, add } = this.items(model);
    if ([...have, ...hidden, ...add].some(i => itemKey(i) === this.at)) return;
    const tile = this.current(model),
      rows = tile === null ? add : this.entries(model, tile),
      first = have[0] ?? hidden[0] ?? (into_add ? (rows.find(addable) ?? rows[0]) : undefined);
    if (first) this.at = itemKey(first);
  }
  /** Focuses the agent `delta` along Add agent's strip, on the row as far
   * down its list as the selected one was. */
  private step(model: Model, delta: number): void {
    const tiles = this.tiles(model),
      next = tiles[tiles.indexOf(this.current(model)!) + delta];
    if (!next) return;
    const index = Math.max(
        0,
        this.items(model).add.findIndex(i => itemKey(i) === this.at),
      ),
      rows = this.entries(model, next);
    this.tile = next;
    this.at = itemKey(rows[Math.min(index, rows.length - 1)]);
  }
  /** Selects `tile` on the strip, which opens its list. */
  private focusTile(tile: Tile): void {
    this.tile = tile;
    this.focus = "list";
    this.empty_section = null;
    this.at = itemKey({ kind: "tile", tile });
  }
  private inLauncher(item: Item, model: Model): boolean {
    if (item.kind === "agent") return item.agent.shown;
    return item.kind === "command" && !model.commands[item.index].hidden;
  }
  private removable(item: Item, model: Model): boolean {
    if (item.kind === "agent") return true;
    return item.kind === "command" && model.commands[item.index].command.length > 0;
  }
  /** Whether a row in the launcher shows in this workspace; null for the rows that aren't. */
  private hereOf(item: Item, model: Model): boolean | null {
    if (!this.inLauncher(item, model)) return null;
    if (item.kind === "agent") return item.agent.here;
    return item.kind === "command" ? model.here(item.index) : null;
  }
  private toggleHere(item: Item | null, model: Model, keyboard = false, now = milliTimestamp()): Action | null {
    if (!item || this.removal || itemRow(item) === null) return null;
    this.glide = keyboard
      ? {
          key: itemKey(item),
          from: this.lines(model).findIndex(line => line.item && itemKey(line.item) === itemKey(item)),
          section: this.section(item, model),
          requested: now,
          started: null,
          ms: 0,
          query: this.query.name(),
        }
      : null;
    this.stay(item, model);
    if (item.kind === "agent" && !item.agent.shown) return { kind: "show", agent: item.agent };
    if (item.kind === "command" && model.commands[item.index].hidden)
      return { kind: "show_command", index: item.index };
    if (item.kind === "agent") return { kind: "here", agent: item.agent, shown: !item.agent.here };
    return item.kind === "command" ? { kind: "here_command", index: item.index, shown: !model.here(item.index) } : null;
  }
  private act(item: Item, model: Model, now = milliTimestamp()): Action | null {
    switch (item.kind) {
      case "agent": {
        this.transition.start(1, now);
        this.agent_form.open(item.agent, model.options(item.agent), model.suggest(item.agent));
        this.page = "agent";
        return null;
      }
      case "command":
        this.command(item.index, model);
        return null;
      case "tile": {
        if (item.tile === "custom") {
          this.command(null, model);
          return null;
        }
        // Into its list, on the first row that adds something.
        const rows = this.details(model, item.tile),
          first = rows.find(addable) ?? rows[0];
        if (first) this.at = itemKey(first);
        return null;
      }
      case "found": {
        if (!item.agent.shown) return { kind: "show", agent: item.agent };
        // A listed one's row is up the list, where the search may hide it.
        const row: Item = { kind: "agent", agent: item.agent };
        if (!this.all(model).some(i => itemKey(i) === itemKey(row))) this.query = Dialog.init({ agent_name: null }, "");
        this.at = itemKey(row);
        return null;
      }
      case "removed":
        this.at = foundKey(item.removed.provider, item.removed.account);
        return { kind: "restore", provider: item.removed.provider, account: item.removed.account };
      case "add":
        return { kind: "add", provider: item.provider };
      case "custom":
        this.command(null, model);
        return null;
    }
  }
  private toggleFocus(): void {
    this.cancelRemoval();
    this.focus = this.focus === "search" ? "list" : "search";
  }
  private section(item: Item, model: Model): "have" | "hidden" {
    return this.inLauncher(item, model) && this.hereOf(item, model) ? "have" : "hidden";
  }
  private stay(item: Item, model: Model): void {
    const section = this.section(item, model),
      peers = this.items(model)[section],
      index = peers.findIndex(i => itemKey(i) === itemKey(item)),
      next = peers[index + 1] ?? peers[index - 1];
    this.at = next ? itemKey(next) : "";
    this.empty_section = next ? null : section;
    this.focus = "list";
  }
  private clone(item: Item | null, model: Model): void {
    if (!item || this.removal) return;
    if (item.kind === "command") {
      this.command(item.index, model);
      this.form.edit_index = null;
      this.form.name_editor = Dialog.init({ agent_name: null }, copyName(model.commands[item.index].label()));
      this.form.name_customized = true;
      return;
    }
    if (item.kind !== "agent") return;
    const names = new Set(model.agents.map(a => a.name || adapter(a.provider).label)),
      base = item.agent.name || adapter(item.agent.provider).label;
    let name = copyName(base),
      n = 2;
    while (names.has(name)) name = copyName(base, n++);
    this.agent_form.open(item.agent, model.options(item.agent), name);
    this.agent_form.name = Dialog.init({ agent_name: null }, name);
    this.agent_form.cloning = true;
    this.transition.start(1, milliTimestamp());
    this.page = "agent";
  }
  private models(agent: Agent, model: Model, editing = false): Action {
    const options = editing ? this.agent_form.options() : model.options(agent);
    const view = new agentModels.Picker(options.model || "", options.effort);
    this.picker = { agent, view, editing };
    return { kind: "models", agent, picker: view };
  }
  private modelResult(result: agentModels.Result): Action | null {
    if (!result || !this.picker) return null;
    const picker = this.picker;
    this.picker = null;
    if (result === "close") return null;
    if (picker.editing) {
      this.agent_form.model = result.model;
      this.agent_form.effort = result.effort;
      return null;
    }
    return {
      kind: "model",
      agent: picker.agent,
      model: result.model,
      ...(result.effort ? { effort: result.effort } : {}),
    };
  }
  private reorder(model: Model, delta: number): Action | null {
    const item = this.selected(model);
    if (!item || !itemRow(item)) return null;
    if (this.query.len) {
      this.error = i18n.t`Clear search to reorder agents.`;
      return null;
    }
    const peers = this.items(model)[this.section(item, model)],
      index = peers.findIndex(i => itemKey(i) === itemKey(item));
    if (!peers[index + delta]) return null;
    return {
      kind: "move",
      row: itemRow(item)!,
      before: itemRow(peers[delta < 0 ? index - 1 : index + 2] ?? { kind: "custom" }),
      shown: this.section(item, model) === "have",
      order: this.all(model).flatMap(i => itemRow(i) ?? []),
    };
  }
  private cancelRemoval(now = milliTimestamp()): void {
    if (this.removal?.phase !== "held") return;
    this.hold.quiet(now);
    this.hold.reset();
    this.removal = null;
  }
  /** A hold never follows a selection or a command that changed underneath it. */
  private sameRemoval(item: Item | null, model: Model): boolean {
    const r = this.removal;
    if (!r || !item || !this.removable(item, model) || itemKey(item) !== itemKey(r.item)) return false;
    if (item.kind === "agent" && r.item.kind === "agent")
      return item.agent.managed === r.item.agent.managed && item.agent.label === r.label;
    return (
      item.kind === "command" &&
      model.commands[item.index].text() === r.detail &&
      model.commands[item.index].label() === r.label
    );
  }
  private remove(item: Item | null, model: Model, now: number): Action | null {
    if (this.removal && this.removal.phase !== "held") {
      this.hold.quiet(now);
      return null;
    }
    if (this.removal && !this.sameRemoval(item, model)) this.cancelRemoval(now);
    if (this.hold.quieted(now)) {
      this.hold.quiet(now);
      return null;
    }
    if (!item || (item.kind !== "agent" && item.kind !== "command") || !this.removable(item, model)) return null;
    if (!this.removal) {
      const a = item.kind === "agent" ? item.agent : null,
        c = item.kind === "command" ? model.commands[item.index] : null;
      this.removal = {
        item,
        label: a?.label ?? c!.label(),
        detail: a?.who ?? c!.text(),
        note: a
          ? a.profile
            ? i18n.t`Deletes this configuration; keeps the account`
            : a.managed
              ? i18n.t`Signs out and deletes its folder`
              : i18n.t`Keeps its folder; Add agent can add it back`
          : i18n.t`Deletes the saved command`,
        section: this.section(item, model),
        index: this.items(model)[this.section(item, model)].findIndex(i => itemKey(i) === itemKey(item)),
        phase: "held",
        committed_at: 0,
      };
    }
    if (!this.hold.press(now)) return null;
    this.removal.phase = "removing";
    this.removal.committed_at = now;
    return item.kind === "agent"
      ? { kind: "remove", agent: item.agent }
      : { kind: "remove_command", index: item.index };
  }
  removed(error: string | null = null): void {
    if (error !== null) {
      this.removal = null;
      this.hold.reset();
      this.fail(error);
    } else if (this.removal) this.removal.phase = "removed";
  }
  /** Advances release/healing and keeps the ending on screen after removal. */
  moving(): boolean {
    return this.glide !== null && this.glide.started !== null;
  }
  private tickGlide(model: Model, now: number): boolean {
    const glide = this.glide;
    if (!glide) return false;
    const item = this.all(model).find(i => itemKey(i) === glide.key);
    if (
      this.page !== "list" ||
      this.drag ||
      this.picker ||
      this.query.name() !== glide.query ||
      !item ||
      (glide.started === null && now - glide.requested > 5000)
    ) {
      this.glide = null;
      return true;
    }
    if (glide.started === null) {
      if (this.section(item, model) === glide.section) return false;
      glide.started = now;
    }
    glide.ms = Math.max(0, now - glide.started);
    if (glide.ms >= rowGlide.total_ms) this.glide = null;
    return true;
  }
  tick(model: Model, now = milliTimestamp()): boolean {
    const glide = this.tickGlide(model, now),
      slide = this.transition.tick(now),
      row = this.agent_form.tick(now),
      motion = glide || slide || row || this.picker?.view.pending === true;
    const r = this.removal;
    if (!r) return motion;
    if (r.phase === "held") {
      if (!this.sameRemoval(this.selected(model), model)) this.cancelRemoval(now);
      else {
        this.hold.advance(now);
        if (!this.hold.active) this.removal = null;
      }
    } else if (r.phase === "removed" && now - r.committed_at >= worktreeRemoval.finale_ms.bury) {
      this.removal = null;
      this.hold.reset();
      this.searched(model, false);
    }
    return true;
  }

  /** A key, as a byte. */
  key(byte: number, model: Model, now = milliTimestamp()): Action | null {
    this.tick(model, now);
    if (this.picker) return this.modelResult(this.picker.view.key(byte));
    if (this.drag && byte === 27) {
      this.drag = null;
      return null;
    }
    if (this.page === "command") return this.formKey(byte);
    if (this.page === "agent") return this.agentResult(this.agent_form.key(byte, now), now, model);
    const item = this.selected(model);
    this.error = "";
    if (byte === 27 && this.removal?.phase === "held") {
      this.cancelRemoval(now);
      return null;
    }
    if (byte !== 8 && byte !== 127) this.cancelRemoval(now);
    if (this.focus === "list" && byte === 101 && item && itemRow(item)) return this.act(item, model, now);
    if (this.focus === "list" && byte === 104) return this.toggleHere(item, model, true, now);
    if (this.focus === "list" && byte === 99) {
      this.clone(item, model);
      return null;
    }
    if (this.focus === "list" && byte === 109 && item?.kind === "agent") return this.models(item.agent, model);
    switch (byte) {
      case 47:
        if (this.focus === "list" || !this.query.len) {
          this.focus = "search";
          return null;
        }
        break;
      case 27:
        return { kind: "close" };
      case 13:
        if (this.focus === "search") {
          this.focus = "list";
          return null;
        }
        if (this.removal) return null;
        return item ? this.act(item, model, now) : null;
      case 9:
        this.toggleFocus();
        return null;
      case 14:
        this.move(model, 1);
        return null;
      case 16:
        this.move(model, -1);
        return null;
      case 32:
        if (this.focus === "list") return this.toggleHere(item, model, true, now);
        break;
      case 8:
      case 127:
        if (this.focus === "list") return this.remove(item, model, now);
        break;
    }
    if (this.focus === "list") return null;
    this.query.key(byte);
    this.searched(model);
    return null;
  }
  private cancelAgent(now: number): null {
    this.transition.start(-1, now);
    this.page = "list";
    this.focus = "list";
    return null;
  }
  private agentResult(result: "save" | "cancel" | "model" | null, now: number, model: Model): Action | null {
    if (result === "cancel") return this.cancelAgent(now);
    const form = this.agent_form;
    if (result === "model" && form.agent) return this.models(form.agent, model, true);
    return result === "save" && form.agent
      ? { kind: form.cloning ? "clone" : "configure", agent: form.agent, name: form.label(), options: form.options() }
      : null;
  }
  private formKey(byte: number): Action | null {
    const f = this.form;
    switch (byte) {
      case 9:
        f.name_focused = !f.name_focused;
        return null;
      case 27:
        return this.cancelCommand();
      case 13:
        return { kind: "save" };
      default:
        if (f.name_focused) f.name_customized = true;
        f.input().key(byte);
        return null;
    }
  }
  private cancelCommand(): null {
    this.form.save_requested = false;
    this.page = "list";
    return null;
  }
  /** A key that came as an escape sequence: arrows move, the rest edit the field. */
  sequence(seq: string, model: Model, now = milliTimestamp()): Action | null {
    this.tick(model, now);
    const key = keys.parse(seq);
    if (this.picker) {
      this.picker.view.sequence(seq);
      return null;
    }
    if (this.page === "list" && this.focus === "list" && (key === "shift_up" || key === "shift_down"))
      return this.reorder(model, key === "shift_up" ? -1 : 1);
    if (this.page === "agent") {
      this.agent_form.sequence(seq);
      return null;
    }
    if (this.page === "list" && this.focus === "list" && key === "delete")
      return this.remove(this.selected(model), model, now);
    this.cancelRemoval(now);
    if (this.page === "list" && (key === "up" || key === "down")) {
      this.move(model, key === "up" ? -1 : 1);
      return null;
    }
    const item = this.page === "list" && this.focus === "list" ? this.selected(model) : null;
    if (item && adding(this.at) && itemRow(item) === null && (key === "left" || key === "right")) {
      this.step(model, key === "left" ? -1 : 1);
      return null;
    }
    if (this.page === "list" && key === "shift_tab") {
      this.toggleFocus();
      return null;
    }
    if (this.page === "list" && key === "left" && (this.focus === "list" || this.query.len === 0))
      return { kind: "back" };
    if (!this.typing()) return null;
    const before = this.query.name();
    this.input().sequence(seq);
    if (this.page === "list" && this.query.name() !== before) this.searched(model);
    return null;
  }
  /** A click at (`x`, `y`) in the box `b`. */
  click(b: Rect, x: number, y: number, model: Model): Action | null {
    if (this.picker) return this.modelResult(this.picker.view.click(this.pickerBounds(b, model), x, y));
    if (y === b.y && this.page === "list" && x >= b.x + 2 && x < b.x + 2 + displayWidth(this.backLabel(b)))
      return { kind: "back" };
    if (y === b.y && x >= View.closeX(b) && x < b.x + b.w - 2)
      return this.page === "command"
        ? this.cancelCommand()
        : this.page === "agent"
          ? this.cancelAgent(milliTimestamp())
          : { kind: "close" };
    if (this.transition.active) return null;
    if (this.page === "agent") return this.agentResult(this.agent_form.click(b, x, y), milliTimestamp(), model);
    if (this.page === "command") {
      const hit = this.form.click(b, x, y);
      if (hit === "save") return { kind: "save" };
      if (hit === "cancel") return this.cancelCommand();
      return null;
    }
    if (y === b.y + 2 && x >= b.x + 3 && x < b.x + b.w - 4) {
      this.cancelRemoval();
      this.focus = "search";
      const offset = DialogView.scroll(this.query, sat(b.w, 11));
      this.query.position(this.query.byteAtColumn(offset, Math.max(0, x - b.x - 7)));
      return null;
    }
    const row = this.rows(b, model).find(r => r.y === y);
    if (y === b.y + b.h - 3) {
      const button = this.buttons(b, model).find(button => x >= button.x && x < button.x + displayWidth(button.label));
      const item = this.selected(model);
      switch (button?.kind) {
        case "edit":
          return item ? this.act(item, model) : null;
        case "clone":
          this.clone(item, model);
          return null;
        case "toggle":
          return this.toggleHere(item, model);
        case "up":
          return this.reorder(model, -1);
        case "down":
          return this.reorder(model, 1);
      }
    }
    const tile = this.tileAt(b, model, x, y);
    if (tile !== null) {
      const item: Item = { kind: "tile", tile },
        again = this.focus === "list" && this.at === itemKey(item) && !this.removal;
      this.cancelRemoval();
      this.error = "";
      // As a row does, a selected agent takes a second click: into its list, or the command form.
      if (again) return this.act(item, model);
      this.focusTile(tile);
      return null;
    }
    if (!row || x <= b.x || x >= b.x + b.w - 1) return null;
    const key = itemKey(row.item),
      again = this.focus === "list" && key === this.at && !this.removal,
      columns = View.columns(b);
    this.cancelRemoval();
    this.focus = "list";
    this.at = key;
    this.empty_section = null;
    this.error = "";
    if (this.removal) return null;
    if (row.item.kind === "agent" && x >= columns.key && x < b.x + b.w - 3) return this.models(row.item.agent, model);
    return again ? this.act(row.item, model) : null;
  }

  /** Where the title's Esc hint starts, as the launcher's Manage button sits. */
  private static closeX = (b: Rect) =>
    b.x + b.w - 8 - Math.max(displayWidth(i18n.t` back `), displayWidth(i18n.t` close `));
  /** The columns its rows' names and accounts start at. */
  private static columns(b: Rect) {
    const mark = b.x + 5,
      name = mark + 2,
      model = Math.max(name + 16, b.x + b.w - 28),
      who = b.w >= 76 ? b.x + 29 : model;
    // The selected account's model key sits just before its dropdown, in
    // room every row leaves, so nothing moves with the selection.
    return { mark, name, who, key: model - 4, model };
  }
  /** Where usage starts on a wide card: left of its usual place as far as
   * its groups' full bars need, leaving accounts at least 24 cells. */
  private static usageColumn(b: Rect, grid: launcherUsage.Grid): number | null {
    if (b.w < 140) return null;
    const { who, key } = View.columns(b);
    return Math.max(who + 26, Math.min(b.x + Math.floor(b.w * 0.48), key - 2 - grid.steadyWidth()));
  }
  private static workspace = (model: Model) => model.workspace || i18n.t`workspace`;
  private backLabel(b: Rect): string {
    return b.w >= 56 ? ` ← ${this.backText()} ` : " ← ";
  }
  /** The list's lines: each section's heading and rows, Add agent's strip
   * above its rows, and as many as its longest agent's list needs below, so
   * focusing another agent doesn't resize the box. */
  private lines(model: Model, preview = false): Line[] {
    const groups = this.groups(model, preview),
      out: Line[] = [],
      line = (section: Line["section"], fields: Partial<Line> = {}): Line => ({
        item: null,
        section,
        heading: false,
        empty: false,
        strip: false,
        ...fields,
      });
    for (const section of ["have", "hidden", "add"] as const) {
      const items = groups[section];
      if (section === "add" && !items.length) continue;
      if (out.length) out.push(line(out[out.length - 1].section));
      out.push(line(section, { heading: true }));
      if (section !== "add" && !items.length) out.push(line(section, { empty: true }));
      for (const item of items) out.push(line(section, { item, strip: item.kind === "tile" }));
      if (section === "add") for (let i = items.length - 1; i < this.detailRows(model); i++) out.push(line(section));
    }
    return out;
  }
  /** Where Add agent's strip puts each agent, with a rule between each two
   * so each mark reads with its own name: by name while they all fit, else
   * by short name and then closer, else by mark alone. */
  private spans(b: Rect, model: Model): { tile: Tile; x: number; w: number; text: string }[] {
    const tiles = this.tiles(model),
      name = (t: Tile, size: number) =>
        size === 2
          ? ""
          : t === "custom"
            ? size
              ? i18n.t`Command`
              : i18n.t`Custom command`
            : adapter(t)[size ? "name" : "label"],
      width = (text: string) => (text ? displayWidth(text) + 5 : 4),
      fits = ([size, gap]: number[]) => tiles.reduce((sum, t) => sum + width(name(t, size)) + gap, -gap) <= b.w - 6,
      [size, gap] = [
        [0, 3],
        [1, 3],
        [1, 1],
        [2, 1],
      ].find(fits) ?? [2, 1];
    let x = b.x + 3;
    return tiles.flatMap(tile => {
      const text = name(tile, size),
        at = x;
      x += width(text) + gap;
      return at + width(text) <= b.x + b.w - 3 ? [{ tile, x: at, w: width(text), text }] : [];
    });
  }
  private stripY(b: Rect, model: Model): number | null {
    const index = this.lines(model).findIndex(line => line.strip),
      y = b.y + 6 + index - this.listOffset(b, model);
    return index >= 0 && y >= b.y + 6 && y < b.y + b.h - 4 ? y : null;
  }
  private tileAt(b: Rect, model: Model, x: number, y: number): Tile | null {
    if (this.page !== "list" || y !== this.stripY(b, model)) return null;
    return this.spans(b, model).find(span => x >= span.x && x < span.x + span.w)?.tile ?? null;
  }
  private groups(model: Model, preview = false): ReturnType<View["items"]> {
    const groups = this.items(model),
      drag = this.drag;
    if (!preview || !drag?.active || !drag.drop) return groups;
    const all = [...groups.have, ...groups.hidden],
      source = all.findIndex(i => itemKey(i) === itemKey(drag.item)),
      before =
        drag.drop.before === null
          ? drag.drop.shown
            ? groups.have.length
            : all.length
          : all.findIndex(i => itemRow(i) === drag.drop!.before);
    if (source < 0 || before < 0) return groups;
    const moved = new Preview(source, before - Number(before > source)).apply(all),
      active = new Set(groups.have.map(itemKey));
    if (drag.drop.shown) active.add(itemKey(drag.item));
    else active.delete(itemKey(drag.item));
    return {
      have: moved.filter(i => active.has(itemKey(i))),
      hidden: moved.filter(i => !active.has(itemKey(i))),
      add: groups.add,
    };
  }
  private listOffset(b: Rect, model: Model): number {
    const lines = this.lines(model),
      selected = this.selected(model),
      index = lines.findIndex(line =>
        selected
          ? line.item && itemKey(line.item) === itemKey(selected)
          : line.empty && line.section === this.empty_section,
      ),
      room = Math.max(1, b.h - 10);
    if (!this.drag && this.focus === "list" && index >= 0) this.first = clamp(this.first, index - room + 1, index);
    this.first = clamp(this.first, 0, Math.max(0, lines.length - room));
    return this.first;
  }
  private rows(b: Rect, model: Model, preview = false): { item: Item; y: number }[] {
    const first = this.listOffset(b, model);
    return this.lines(model, preview).flatMap((line, i) => {
      const y = b.y + 6 + i - first;
      return line.item && y >= b.y + 6 && y < b.y + b.h - 4 ? [{ item: line.item, y }] : [];
    });
  }
  private buttons(
    b: Rect,
    model: Model,
  ): { kind: "edit" | "clone" | "toggle" | "up" | "down"; label: string; x: number }[] {
    const item = this.selected(model);
    if (!item || itemRow(item) === null || this.removal) return [];
    const labels = [
      ["edit", i18n.t` e Edit `],
      ["clone", i18n.t` c Clone `],
      ["toggle", this.section(item, model) === "have" ? i18n.t` h Hide ` : i18n.t` h Activate `],
      ["up", b.w >= 96 ? i18n.t` Shift+↑ Move up ` : i18n.t` Shift+↑ Up `],
      ["down", b.w >= 96 ? i18n.t` Shift+↓ Move down ` : i18n.t` Shift+↓ Down `],
    ] as const;
    // Keep removal discoverable before spending the remaining room on reorder buttons.
    const reserved = this.removable(item, model)
      ? displayWidth(i18n.t` hold ⌫ `) + displayWidth(i18n.t` remove`) + 1
      : 0;
    let x = b.x + 3;
    return labels.flatMap(([kind, label]) => {
      const at = x;
      x += displayWidth(label) + 1;
      return x + reserved <= b.x + b.w - 2
        ? [{ kind: kind as "edit" | "clone" | "toggle" | "up" | "down", label, x: at }]
        : [];
    });
  }
  private pickerBounds(b: Rect, model: Model): Rect {
    const selected = this.selected(model),
      row = this.rows(b, model).find(r => selected && itemKey(r.item) === itemKey(selected));
    return this.picker!.view.bounds(
      b,
      this.page === "agent" ? this.agent_form.modelAnchor(b) : { x: View.columns(b).model, y: row?.y ?? b.y + 4 },
    );
  }
  pointerShape(b: Rect, model: Model, x: number, y: number): "default" | "pointer" | "grab" | "grabbing" | "text" {
    if (this.drag?.active) return "grabbing";
    if (!b.contains(x, y)) return "default";
    if (this.picker) {
      const p = this.pickerBounds(b, model);
      return p.contains(x, y) ? (y === p.y + 1 && !this.picker.view.editing ? "text" : "pointer") : "default";
    }
    if (this.page !== "list") return "default";
    if (y === b.y + 2) return "text";
    if (this.tileAt(b, model, x, y) !== null) return "pointer";
    const row = this.rows(b, model).find(row => row.y === y);
    if (row) return itemRow(row.item) && !this.query.len && x < View.columns(b).key ? "grab" : "pointer";
    if (
      y === b.y + b.h - 3 &&
      this.buttons(b, model).some(button => x >= button.x && x < button.x + displayWidth(button.label))
    )
      return "pointer";
    return "default";
  }
  pointer(b: Rect, x: number, y: number, button: number, release: boolean, model: Model): Action | null {
    if (this.picker) {
      if (!release && (button === 64 || button === 65)) this.picker.view.sequence(button === 65 ? "\x1b[B" : "\x1b[A");
      if (!release && (button === 32 || button === 35)) this.picker.view.hover(this.pickerBounds(b, model), x, y);
      return !release && button === 0 ? this.click(b, x, y, model) : null;
    }
    if (this.drag) {
      const drag = this.drag;
      const ids = this.all(model).map(i => `${itemKey(i)}:${this.section(i, model)}`);
      if (
        b.w !== drag.width ||
        b.h !== drag.height ||
        ids.length !== drag.ids.length ||
        ids.some((id, i) => id !== drag.ids[i])
      ) {
        this.drag = null;
        return null;
      }
      if (!release && (button === 64 || button === 65)) {
        this.first = Math.max(0, this.first + (button === 64 ? -1 : 1));
        drag.active = true;
      }
      if (!release && button === 32 && (x !== drag.x || y !== drag.y)) drag.active = true;
      drag.drop = null;
      if (drag.active && b.contains(x, y)) {
        const first = this.listOffset(b, model),
          lines = this.lines(model),
          line = lines[y - b.y - 6 + first];
        if (line && line.section !== "add") {
          const peers = this.items(model)[line.section],
            index = line.item ? peers.findIndex(i => itemKey(i) === itemKey(line.item!)) : -1;
          const source = peers.findIndex(i => itemKey(i) === itemKey(drag.item));
          const before = line.item
            ? itemRow(peers[index + Number(source >= 0 && index > source)] ?? { kind: "custom" })
            : line.heading
              ? itemRow(peers[0] ?? { kind: "custom" })
              : null;
          if (before !== itemRow(drag.item)) drag.drop = { before, shown: line.section === "have", y };
        }
      }
      if (release && (button & 3) === 0) {
        this.drag = null;
        if (!drag.active) return drag.again && b.contains(x, y) && y === drag.y ? this.act(drag.item, model) : null;
        if (!drag.drop) return null;
        const row = itemRow(drag.item)!;
        if (drag.drop.shown !== (this.section(drag.item, model) === "have")) this.stay(drag.item, model);
        return {
          kind: "move",
          row,
          before: drag.drop.before,
          shown: drag.drop.shown,
          order: this.all(model).flatMap(i => itemRow(i) ?? []),
        };
      }
      return null;
    }
    if (
      !release &&
      button === 0 &&
      this.page === "list" &&
      !this.query.len &&
      !this.removal &&
      x >= b.x + 1 &&
      x < View.columns(b).key
    ) {
      const row = this.rows(b, model).find(r => r.y === y);
      if (row && itemRow(row.item)) {
        this.glide = null;
        const again = this.focus === "list" && this.at === itemKey(row.item) && this.empty_section === null;
        this.at = itemKey(row.item);
        this.empty_section = null;
        this.focus = "list";
        this.drag = {
          item: row.item,
          x,
          y,
          active: false,
          drop: null,
          width: b.w,
          height: b.h,
          again,
          ids: this.all(model).map(i => `${itemKey(i)}:${this.section(i, model)}`),
        };
        return null;
      }
    }
    if (!release && (button === 64 || button === 65)) return this.sequence(button === 65 ? "\x1b[B" : "\x1b[A", model);
    return !release && button === 0 ? this.click(b, x, y, model) : null;
  }

  draw(
    w: Writer,
    b: Rect,
    model: Model,
    now = milliTimestamp(),
    presentation: { framed?: boolean; focused?: boolean } = {},
  ): void {
    this.last_box = b;
    const body = new Writer();
    this.drawContent(body, b, model, now, presentation);
    this.transition.draw(w, body.s, b, b.w, 0, presentation.framed !== false);
    if (this.picker) this.picker.view.draw(w, this.pickerBounds(b, model), now);
  }
  private drawContent(
    w: Writer,
    b: Rect,
    model: Model,
    now = milliTimestamp(),
    presentation: { framed?: boolean; focused?: boolean } = {},
  ): void {
    const at = (x: number, y: number) => `\x1b[${y + 1};${x + 1}H`,
      panel = new Style({ fg: "text", bg: "surface" }).sgr(),
      faint = new Style({ fg: "faint", bg: "surface" }).sgr(),
      rule = new Style({ fg: "line", bg: "surface" }).sgr();
    for (let y = 0; presentation.framed !== false && y < b.h; y++) {
      w.write(at(b.x, b.y + y) + rule + (y === 0 ? "╭" : y === b.h - 1 ? "╰" : "│"));
      if (y === 0 || y === b.h - 1) w.write("─".repeat(b.w - 2));
      else w.splat(" ", b.w - 2);
      w.write(y === 0 ? "╮" : y === b.h - 1 ? "╯" : "│");
    }
    const name =
      this.form.edit_index !== null ? (model.commands[this.form.edit_index]?.label() ?? i18n.t`command`) : "";
    const title =
      this.page === "list"
        ? i18n.t`Manage agents`
        : this.page === "agent"
          ? this.agent_form.cloning
            ? i18n.t`Clone agent · draft`
            : i18n.t`Edit agent`
          : this.form.edit_index !== null
            ? i18n.t`Edit ${name}`
            : i18n.t`New command`;
    if (this.page === "list") w.write(at(b.x + 2, b.y) + faint + this.backLabel(b));
    const titleX = b.x + (this.page === "list" ? 3 + displayWidth(this.backLabel(b)) : 2);
    w.write(at(titleX, b.y) + new Style({ fg: "strong", bg: "surface", bold: true }).sgr());
    writeEllipsis(w, ` ${title} `, Math.max(0, View.closeX(b) - titleX));
    w.write(
      at(View.closeX(b), b.y) +
        faint +
        " " +
        keycap +
        " esc " +
        faint +
        (this.page !== "list" ? i18n.t` back ` : i18n.t` close `),
    );
    let caret: { x: number; y: number };
    if (this.page === "command") {
      this.form.draw(w, b, model);
      View.footer(w, b, [
        ["tab", i18n.t`command / name`],
        ["↵", i18n.t`save`],
        ["esc", i18n.t`back`],
      ]);
      caret = this.form.caret(b);
    } else if (this.page === "agent") {
      this.agent_form.draw(w, b, now);
      caret = this.agent_form.caret(b);
    } else caret = this.drawList(w, b, model, now, presentation.focused !== false);
    w.write(
      `\x1b[0m${at(caret.x, caret.y)}${this.typing() && presentation.focused !== false ? "\x1b[?25h" : "\x1b[?25l"}`,
    );
  }
  /** Draws the list; where the caret goes. */
  private drawList(w: Writer, b: Rect, model: Model, now: number, focused: boolean): { x: number; y: number } {
    const at = (x: number, y: number) => `\x1b[${y + 1};${x + 1}H`,
      faint = new Style({ fg: "faint", bg: "surface" }).sgr(),
      columns = View.columns(b),
      chosen = this.selected(model),
      search_w = sat(b.w, 11),
      searching = focused && this.focus === "search";
    w.write(at(b.x + 3, b.y + 2) + keycap + " / " + faint + " ");
    field(
      w,
      this.query,
      i18n.t`Search`,
      b.x + 7,
      b.y + 2,
      search_w,
      searching,
      searching ? "selected" : "surface",
      searching ? "muted" : "faint",
    );
    w.write(at(columns.name, b.y + 4) + faint + i18n.t`Agent`);
    if (columns.who < columns.model) w.write(at(columns.who, b.y + 4) + i18n.t`Account`);
    w.write(at(columns.model + 2, b.y + 4) + i18n.t`Model`);
    const grid = new launcherUsage.Grid();
    for (const a of model.agents) grid.add(a.usage);
    const usage = View.usageColumn(b, grid);
    if (usage !== null) {
      w.write(at(usage, b.y + 4));
      writeEllipsis(w, i18n.t`Usage · resets in`, columns.key - usage - 2);
    }
    const caret = { x: b.x + 7 + this.queryColumn(search_w), y: b.y + 2 },
      first = this.listOffset(b, model),
      groups = this.groups(model, true);
    this.lines(model, true).forEach((line, i) => {
      const y = b.y + 6 + i - first;
      if (y < b.y + 6 || y >= b.y + b.h - 4 || line.item) return;
      const on = focused && this.empty_section === line.section && line.empty;
      w.write(
        at(b.x + 3, y) +
          new Style({
            fg: line.heading || on ? "strong" : "faint",
            bg: on ? "selected" : "surface",
            bold: line.heading,
          }).sgr(),
      );
      const title =
        line.section === "have" ? i18n.t`Active` : line.section === "hidden" ? i18n.t`Hidden` : i18n.t`Add agent`;
      writeEllipsis(
        w,
        line.heading
          ? title + (line.section === "add" ? "" : " · " + groups[line.section].length + " · " + View.workspace(model))
          : line.empty
            ? this.query.len
              ? i18n.t`No matching agents`
              : i18n.t`Drop an agent here`
            : "",
        b.w - 6,
      );
    });
    for (const { item, y } of this.rows(b, model, true)) {
      if (item.kind === "tile") {
        this.drawStrip(w, b, y, model, focused);
        continue;
      }
      const row_start = w.s.length;
      const on = focused && this.focus === "list" && chosen !== null && itemKey(item) === itemKey(chosen),
        hidden =
          (itemRow(item) !== null && this.section(item, model) === "hidden") ||
          (item.kind === "found" && item.agent.shown),
        hovered = this.pointer_at?.y === y && this.pointer_at.x > b.x && this.pointer_at.x < b.x + b.w - 1,
        style =
          new Style({ fg: on ? "strong" : hidden ? "muted" : "text", bg: on ? "selected" : "surface" }).sgr() +
          (!on && hovered ? palette.bgRgb(palette.mix(palette.colors.surface, palette.colors.selected, 50)) : "");
      w.write(at(b.x + 1, y) + style);
      w.splat(" ", b.w - 2);
      const ghost = this.drag?.active && this.drag.drop && itemKey(item) === itemKey(this.drag.item);
      w.write(
        at(b.x + 1, y) +
          (ghost ? "▌" : on ? "›" : " ") +
          " " +
          (itemRow(item) ? palette.fg("faint") + "≡" + style : item.kind === "found" && item.agent.shown ? "✓" : "+"),
      );
      if (this.removal && itemKey(item) === itemKey(this.removal.item)) {
        this.drawRemoval(w, b, y, now, model);
        continue;
      }
      const provider = markOf(item, model);
      if (provider) {
        // Images can't follow the sliding card, nor show through the picker.
        writeMark(w, provider, columns.mark, y, this.transition.active || this.picker ? null : this.marks);
        w.write(style);
      }
      w.write(at(itemRow(item) ? columns.name : columns.mark, y));
      switch (item.kind) {
        case "add": {
          const providerName = adapter(item.provider).label;
          writeEllipsis(w, i18n.t`New ${providerName} account`, b.w - 8);
          break;
        }
        case "custom":
          writeEllipsis(w, i18n.t`New custom command`, b.w - 8);
          break;
        case "found": {
          const a = item.agent;
          writeEllipsis(w, title(a), columns.who - columns.name - 2);
          View.writeFound(w, b, usage, y, a.who, model.folder(a.provider, a.account), a.shown, on, a.signed_out);
          break;
        }
        case "removed": {
          const r = item.removed;
          writeEllipsis(w, r.name, columns.who - columns.name - 2);
          View.writeFound(w, b, usage, y, "", model.folder(r.provider, r.account), false, on);
          break;
        }
        case "command": {
          const c = model.commands[item.index];
          writeEllipsis(w, c.label(), columns.who - columns.name - 2);
          w.write(at(columns.who, y));
          writeEllipsis(w, cleanControls(c.text()), b.x + b.w - columns.who - 3);
          break;
        }
        case "agent": {
          const a = item.agent;
          writeEllipsis(w, title(a), Math.min(columns.who, columns.key) - columns.name - 2);
          if (columns.who < columns.model) {
            w.write(at(columns.who, y) + palette.fg(a.signed_out ? "warm" : on ? "muted" : "faint"));
            writeEllipsis(w, cleanControls(a.who), (usage ?? columns.key) - columns.who - 2);
          }
          if (usage !== null) {
            w.write(at(usage, y) + style);
            a.usage.write(w, grid, columns.key - usage - 2, style, on);
          }
          if (on) w.write(at(columns.key, y) + keycap + " m " + style);
          const value = model.options(a).model;
          // The dropdown's arrow leads its model, beside the key that opens it.
          w.write(at(columns.model, y) + style + "▾ ");
          agentModels.writeModel(
            w,
            value ? AgentModel.resolve(value).label() : i18n.t`Auto (last chosen)`,
            model.options(a).effort,
            b.x + b.w - columns.model - 5,
            style,
          );
          break;
        }
      }
      const glide = this.glide;
      if (glide && glide.started !== null && glide.key === itemKey(item)) {
        const frame = w.s.slice(row_start);
        w.s = w.s.slice(0, row_start);
        if (this.cell) {
          const fade = rowGlide.fade(glide.ms);
          if (fade !== null) writeExit(w, frame, fade, "surface");
          else w.write(frame);
        } else writeTint(w, frame, rowGlide.tint(glide.ms));
      }
    }
    const buttons = this.buttons(b, model);
    for (const button of buttons) w.write(at(button.x, b.y + b.h - 3) + keycap + button.label);
    const last = buttons.at(-1),
      remove_x = last ? last.x + displayWidth(last.label) + 2 : b.x + 3;
    const removeKey = i18n.t` hold ⌫ `,
      removeLabel = i18n.t` remove`;
    if (
      !this.removal &&
      chosen &&
      this.removable(chosen, model) &&
      remove_x + displayWidth(removeKey) + displayWidth(removeLabel) <= b.x + b.w - 2
    )
      w.write(at(remove_x, b.y + b.h - 3) + keycap + removeKey + faint + removeLabel);
    if (this.error) {
      w.write(at(b.x + 3, b.y + b.h - 2) + new Style({ fg: "hot", bg: "surface" }).sgr());
      writeEllipsis(w, this.error, sat(b.w, 6));
    } else if (this.removal) {
      const r = this.removal;
      w.write(at(b.x + 3, b.y + b.h - 3) + new Style({ fg: "strong", bg: "surface" }).sgr());
      writeEllipsis(w, `${r.phase === "held" ? i18n.t`Hold ⌫ to remove` : i18n.t`Removing`} ${r.label}`, sat(b.w, 6));
      w.write(at(b.x + 3, b.y + b.h - 2) + new Style({ fg: "muted", bg: "surface" }).sgr());
      writeEllipsis(w, `${r.note}${r.phase === "held" ? i18n.t` · release to cancel` : ""}`, sat(b.w, 6));
    } else if (focused && this.buttons(b, model).length === 0) View.footer(w, b, this.hints(chosen, model));
    return caret;
  }
  /** An Add agent account's columns: who signed in, its folder, and
   * whether it's in the list. */
  private static writeFound(
    w: Writer,
    b: Rect,
    usage: number | null,
    y: number,
    who: string,
    folder: string,
    listed: boolean,
    on: boolean,
    warm = false,
  ): void {
    const at = (x: number) => `\x1b[${y + 1};${x + 1}H`,
      columns = View.columns(b),
      dim = palette.fg(on ? "muted" : "faint");
    if (columns.who < columns.model) {
      const room = (usage ?? columns.key) - columns.who - 2;
      w.write(at(columns.who) + (who && warm ? palette.fg("warm") : dim));
      if (who) writeEllipsis(w, cleanControls(who), room);
      else w.write(shortPath(cleanControls(folder), room));
    }
    if (usage !== null && who) {
      w.write(at(usage) + dim);
      w.write(shortPath(cleanControls(folder), columns.key - usage - 2));
    }
    w.write(at(columns.model) + dim);
    writeEllipsis(w, listed ? i18n.t`In the list` : i18n.t`Removed`, b.x + b.w - columns.model - 3);
  }
  /** Add agent's strip: each agent's mark and name, the focused one lit
   * while the strip is selected and strong while its list is. */
  private drawStrip(w: Writer, b: Rect, y: number, model: Model, focused: boolean): void {
    const current = this.current(model),
      chosen = this.selected(model),
      selected = focused && this.focus === "list" && chosen?.kind === "tile",
      open = adding(this.at),
      // Images can't follow the card as it slides, nor show through the picker.
      marks = this.transition.active || this.picker ? null : this.marks;
    w.write(`\x1b[${y + 1};${b.x + 2}H` + new Style({ fg: "strong", bg: "surface" }).sgr() + (selected ? "›" : " "));
    const spans = this.spans(b, model),
      rule = new Style({ fg: "line", bg: "surface" }).sgr();
    for (const [i, span] of spans.entries()) {
      const on = open && span.tile === current,
        lit = on && selected,
        installed = span.tile === "custom" || model.offers.find(o => o.provider === span.tile)?.installed !== false,
        hovered = this.pointer_at?.y === y && this.pointer_at.x >= span.x && this.pointer_at.x < span.x + span.w,
        style =
          new Style({
            fg: on ? "strong" : installed ? "muted" : "faint",
            bg: lit ? "selected" : "surface",
            bold: on,
          }).sgr() +
          (!lit && hovered ? palette.bgRgb(palette.mix(palette.colors.surface, palette.colors.selected, 50)) : "");
      w.write(`\x1b[${y + 1};${span.x + 1}H` + style + " ");
      if (span.tile === "custom") w.write("+ ");
      else {
        writeMark(w, span.tile, span.x + 1, y, marks);
        w.write(style);
      }
      w.write(span.text ? ` ${span.text} ` : " ");
      const next = spans[i + 1];
      if (next) {
        const end = span.x + span.w;
        w.write(`\x1b[${y + 1};${end + Math.floor((next.x - end) / 2) + 1}H` + rule + "│");
      }
    }
  }
  glideImage(b: Rect, model: Model): string {
    const glide = this.glide;
    if (this.page !== "list" || this.transition.active || !glide || glide.started === null || !this.cell) return "";
    const first = this.listOffset(b, model),
      index = this.lines(model).findIndex(line => line.item && itemKey(line.item) === glide.key);
    return index < 0
      ? ""
      : rowGlide.place(
          b.x + 1,
          rowGlide.position(b.y + 6 + glide.from - first, b.y + 6 + index - first, glide.ms),
          b.w - 2,
          1,
          { top: b.y + 6, bottom: b.y + b.h - 4 },
          rowGlide.opacity(glide.ms),
          this.cell,
          rowGlide.manager_image_id,
        );
  }
  private queryColumn(width: number): number {
    const offset = DialogView.scroll(this.query, width);
    return Math.min(sat(width, 1), displayWidth(this.query.bytes(offset, this.query.cursor)));
  }
  private drawRemoval(w: Writer, b: Rect, y: number, now: number, model: Model): void {
    const r = this.removal!,
      grid = new Grid(b.w - 2, 1, palette.colors.text),
      { mark, name, who } = View.columns(new Rect(-1, 0, b.w, 1)),
      provider = markOf(r.item, model),
      finale =
        r.phase === "held" ? 0 : Math.max(0.0001, Math.min(1, (now - r.committed_at) / worktreeRemoval.finale_ms.bury));
    grid.text(0, 0, "›", palette.colors.strong);
    if (provider) grid.text(mark, 0, adapter(provider).glyph, palette.colors.strong);
    grid.text(
      name,
      0,
      ellipsis(r.item.kind === "agent" ? title(r.item.agent) : r.label, sat(who, name + 2)),
      palette.colors.strong,
    );
    grid.text(who, 0, ellipsis(cleanControls(r.detail), sat(b.w - 3, who)), palette.colors.muted);
    const area = { y: 0, lines: 1, left: 0, right: grid.w - 1, top: 0, bottom: 0 };
    worktreeRemoval.paint(grid, area, "bury", this.hold.progress, finale, now);
    if (r.phase === "removing" && finale >= 1) worktreeRemoval.progress(grid, area, now);
    grid.write(w, b.x + 1, y, new Style({ fg: "text", bg: "selected" }).sgr());
  }
  /** The keys the selected row takes. */
  private hints(item: Item | null, model: Model): Hint[] {
    const providerName = item?.kind === "add" ? adapter(item.provider).label : "";
    if (this.focus === "search")
      return [
        ["tab / ↓", i18n.t`list`],
        ["←", this.backText().toLowerCase()],
        ["esc", i18n.t`close`],
      ];
    switch (item?.kind) {
      case undefined:
        return [["esc", i18n.t`close`]];
      case "tile":
        return [item.tile === "custom" ? ["↵", i18n.t`new command`] : ["↓", i18n.t`accounts`], ["←→", i18n.t`agents`]];
      case "add":
        return [
          ["↵", i18n.t`sign in to a new ${providerName} account`],
          ["←→", i18n.t`agents`],
        ];
      case "custom":
        return [
          ["↵", i18n.t`new command`],
          ["←→", i18n.t`agents`],
        ];
      case "found":
      case "removed":
        return [
          ["↵", item.kind === "found" && item.agent.shown ? i18n.t`go to its row` : i18n.t`add back to the list`],
          ["←→", i18n.t`agents`],
        ];
      case "command":
      case "agent":
        return [
          ["⇧ ↑↓", i18n.t`reorder`],
          ["h", this.section(item, model) === "have" ? i18n.t`hide` : i18n.t`activate`],
          ["c", i18n.t`clone`],
          ["hold ⌫", i18n.t`remove`],
          ["/", i18n.t`search`],
        ];
    }
  }
  private static footer(w: Writer, b: Rect, hints: Hint[]): void {
    const panel = new Style({ fg: "faint", bg: "surface" }).sgr();
    w.write(`\x1b[${b.y + b.h - 1};${b.x + 3}H`);
    let used = 0;
    for (const [key, label] of hints) {
      const width = displayWidth(key) + displayWidth(label) + 3 + (used ? 2 : 0);
      if (used + width > b.w - 6) break;
      w.write((used ? panel + "  " : "") + keycap + ` ${key} ` + panel + ` ${label}`);
      used += width;
    }
  }
}

function copyName(name: string, number = 1): string {
  const translated = (name: string) => (number === 1 ? i18n.t`${name} copy` : i18n.t`${name} copy ${number}`);
  return translated(byteSlice(name, agentName.limit - byteLength(translated(""))));
}
