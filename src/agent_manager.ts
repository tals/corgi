//! Manage agents: the accounts agents start in and the saved commands, under
//! a search, then an Available to add section that restores accounts or signs in to
//! an agent or saves a command. It draws in a box its host gives it, takes
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
import { Writer, displayWidth, writeEllipsis, ellipsis, sat, clamp } from "./text";
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
import { Row } from "./launch/row";
import * as launcherOrder from "./launch/order";
import { Model as AgentModel } from "./providers/model";
import { Preview, writeExit, writeTint } from "./sidebar";
import * as rowGlide from "./row_glide";
import type { Cell as PixelCell } from "./fork_hero";

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
/** What the host has to list. */
export type Model = {
  agents: Agent[];
  /** The saved commands' slots; an empty one lists nothing. */
  commands: CommandEntry[];
  /** The current workspace's name, which the Show column's toggles apply to. */
  workspace: string;
  /** Whether saved command `index` shows in the current workspace's launcher. */
  here(index: number): boolean;
  /** The agents a new account can be added for. */
  add: Provider[];
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
  | { kind: "save" };

type Item =
  | { kind: "agent"; agent: Agent }
  | { kind: "command"; index: number }
  | { kind: "add"; provider: Provider }
  | { kind: "custom" };
function itemKey(item: Item): string {
  switch (item.kind) {
    case "agent":
      return item.agent.profile
        ? `profile:${item.agent.profile}`
        : `agent:${item.agent.provider}:${item.agent.account}`;
    case "command":
      return `command:${item.index}`;
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
      w.write(at(b.x + 3, y) + dim + (i === 0 ? "Command" : "Name"));
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
        i === 0 ? "Paste a command…" : "Suggested automatically",
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
              ? "Command too long"
              : !same || this.resolution.pending
                ? "Resolving command…"
                : this.resolution.error_message.length > 0
                  ? this.resolution.error_message
                  : model.account(this.resolution.semantics);
      const info = this.resolution.semantics,
        provider = info.provider ? adapter(info.provider).label : "Custom agent";
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
        w.write(at(b.x + b.w - 18, top + 10) + `[${this.show_command ? "Hide" : "Show"} command]`);
        if (this.show_command) {
          w.write(at(b.x + 3, top + 12) + "Runs: ");
          writeEllipsis(w, cleanControls(this.resolution.command.text()), b.w - 14);
        }
      }
    }
    w.write(panel + at(b.x + b.w - 20, this.actions(b)) + `[Cancel]  [${this.edit_index !== null ? "Save" : "Add"}]`);
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
    if (y === actions && x >= sat(b.x + b.w, 10)) return "save";
    if (y === actions && x >= sat(b.x + b.w, 20)) return "cancel";
    if (y === top + 10 && x >= sat(b.x + b.w, 18)) this.show_command = !this.show_command;
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
  back_label = "New tab";
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
  }
  /** The rows the search leaves: what there is, then what can be added. */
  items(model: Model): { have: Item[]; hidden: Item[]; add: Item[] } {
    const q = this.query.name();
    const found: Item[] = [
      ...model.agents.filter(a => matches(q, `${a.label} ${a.who}`)).map(agent => ({ kind: "agent" as const, agent })),
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
    const add: Item[] = [
      ...model.add
        .filter(p => matches(q, `add new account ${adapter(p).label}`))
        .map(provider => ({ kind: "add" as const, provider })),
      ...(matches(q, "add custom command") ? [{ kind: "custom" as const }] : []),
    ];
    return { have, hidden, add };
  }
  private all(model: Model): Item[] {
    const { have, hidden, add } = this.items(model);
    return [...have, ...hidden, ...add];
  }
  /** The selected row: the one `at` names, else the first. */
  selected(model: Model): Item | null {
    if (this.empty_section) return null;
    const all = this.all(model);
    return all.find(i => itemKey(i) === this.at) ?? all[0] ?? null;
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
    const now = all.findIndex(i => itemKey(i) === this.at);
    const next = Math.max(0, now) + delta;
    if (next < 0 || next >= all.length) this.focus = "search";
    else this.at = itemKey(all[next]);
  }
  /** After the search changed, the selected row stays while it's listed;
   * else the first row takes it, what there is before what can be added. */
  private searched(model: Model): void {
    this.empty_section = null;
    const { have, hidden, add } = this.items(model);
    if ([...have, ...hidden, ...add].some(i => itemKey(i) === this.at)) return;
    const first = have[0] ?? hidden[0] ?? add[0];
    if (first) this.at = itemKey(first);
  }
  private inLauncher(item: Item, model: Model): boolean {
    if (item.kind === "agent") return item.agent.shown;
    return item.kind === "command" && !model.commands[item.index].hidden;
  }
  private removable(item: Item, model: Model): boolean {
    if (item.kind === "agent") return !!item.agent.profile || item.agent.account.length > 0 || item.agent.shown;
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
      this.form.name_editor = Dialog.init({ agent_name: null }, model.commands[item.index].label() + " copy");
      this.form.name_customized = true;
      return;
    }
    if (item.kind !== "agent") return;
    const names = new Set(model.agents.map(a => a.name || adapter(a.provider).label)),
      base = item.agent.name || adapter(item.agent.provider).label;
    let name = base + " copy",
      n = 2;
    while (names.has(name)) name = base + " copy " + n++;
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
      this.error = "Clear search to reorder agents.";
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
    if (!item || item.kind === "add" || item.kind === "custom") return null;
    if (!this.removable(item, model)) return null;
    if (!this.removal) {
      const a = item.kind === "agent" ? item.agent : null,
        c = item.kind === "command" ? model.commands[item.index] : null;
      this.removal = {
        item,
        label: a?.label ?? c!.label(),
        detail: a?.who ?? c!.text(),
        note: a
          ? a.profile
            ? "Deletes this configuration; keeps the account"
            : !a.account
              ? "Default account stays in Hidden"
              : a.managed
                ? "Signs out and deletes its folder"
                : "Removes account; keeps its folder"
          : "Deletes the saved command",
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
      this.searched(model);
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
    if (y === b.y && this.page === "list" && x >= b.x + 2 && x < b.x + 2 + this.backLabel(b).length)
      return { kind: "back" };
    if (y === b.y && x >= View.closeX(b) && x < View.closeX(b) + 13)
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
      const button = this.buttons(b, model).find(button => x >= button.x && x < button.x + button.label.length);
      const item = this.selected(model);
      switch (button?.kind) {
        case "edit":
          return item ? this.act(item, model) : null;
        case "clone":
          this.clone(item, model);
          return null;
        case "toggle":
          return this.toggleHere(item, model);
        case "model":
          return item?.kind === "agent" ? this.models(item.agent, model) : null;
        case "up":
          return this.reorder(model, -1);
        case "down":
          return this.reorder(model, 1);
      }
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
    if (row.item.kind === "agent" && x >= columns.model && x < b.x + b.w - 3) return this.models(row.item.agent, model);
    return again ? this.act(row.item, model) : null;
  }

  /** Where the title's Esc hint starts, as the launcher's Manage button sits. */
  private static closeX = (b: Rect) => b.x + b.w - 15;
  /** The columns its rows' names and accounts start at. */
  private static columns(b: Rect) {
    const name = b.x + 5,
      model = Math.max(name + 16, b.x + b.w - 28),
      who = b.w >= 76 ? name + 24 : model,
      usage = b.w >= 140 ? b.x + Math.max(58, Math.floor(b.w * 0.48)) : null;
    return { name, who, usage, model };
  }
  private static workspace = (model: Model) => model.workspace || "workspace";
  private backLabel(b: Rect): string {
    return b.w >= 56 ? ` ← ${this.back_label} ` : " ← ";
  }
  private lines(
    model: Model,
    preview = false,
  ): { item: Item | null; section: "have" | "hidden" | "add"; heading: boolean; empty: boolean }[] {
    const groups = this.groups(model, preview),
      out: ReturnType<View["lines"]> = [];
    for (const section of ["have", "hidden", "add"] as const) {
      const items = groups[section];
      if (section === "add" && !items.length) continue;
      if (out.length) out.push({ item: null, section: out[out.length - 1].section, heading: false, empty: false });
      out.push({ item: null, section, heading: true, empty: false });
      if (!items.length) out.push({ item: null, section, heading: false, empty: true });
      for (const item of items) out.push({ item, section, heading: false, empty: false });
    }
    return out;
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
  ): { kind: "edit" | "clone" | "toggle" | "model" | "up" | "down"; label: string; x: number }[] {
    const item = this.selected(model);
    if (!item || itemRow(item) === null || this.removal) return [];
    const labels = [
      ["edit", " e Edit "],
      ["clone", " c Clone "],
      ["toggle", this.section(item, model) === "have" ? " h Hide " : " h Activate "],
      ...(item.kind === "agent" ? [["model", " m Model ▾ "]] : []),
      ["up", b.w >= 96 ? " Shift+↑ Move up " : " Shift+↑ Up "],
      ["down", b.w >= 96 ? " Shift+↓ Move down " : " Shift+↓ Down "],
    ] as const;
    let x = b.x + 3;
    return labels.flatMap(([kind, label]) => {
      const at = x;
      x += displayWidth(label) + 1;
      return x < b.x + b.w - 2
        ? [{ kind: kind as "edit" | "clone" | "toggle" | "model" | "up" | "down", label, x: at }]
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
    const row = this.rows(b, model).find(row => row.y === y);
    if (row) return itemRow(row.item) && !this.query.len && x < View.columns(b).model ? "grab" : "pointer";
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
      x < View.columns(b).model
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
    const title =
      this.page === "list"
        ? "Manage agents"
        : this.page === "agent"
          ? this.agent_form.cloning
            ? "Clone agent · draft"
            : "Edit agent"
          : this.form.edit_index !== null
            ? `Edit ${model.commands[this.form.edit_index]?.label() ?? "command"}`
            : "New command";
    if (this.page === "list") w.write(at(b.x + 2, b.y) + faint + this.backLabel(b));
    w.write(
      at(b.x + (this.page === "list" ? 3 + this.backLabel(b).length : 2), b.y) +
        new Style({ fg: "strong", bg: "surface", bold: true }).sgr() +
        ` ${title} `,
    );
    w.write(
      at(View.closeX(b), b.y) + faint + " " + keycap + " esc " + faint + (this.page !== "list" ? " back " : " close "),
    );
    let caret: { x: number; y: number };
    if (this.page === "command") {
      this.form.draw(w, b, model);
      View.footer(w, b, [
        ["tab", "command / name"],
        ["↵", "save"],
        ["esc", "back"],
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
      "Search",
      b.x + 7,
      b.y + 2,
      search_w,
      searching,
      searching ? "selected" : "surface",
      searching ? "muted" : "faint",
    );
    w.write(at(columns.name, b.y + 4) + faint + "Agent");
    if (columns.who < columns.model) w.write(at(columns.who, b.y + 4) + "Account");
    w.write(at(columns.model, b.y + 4) + "Model");
    const grid = new launcherUsage.Grid();
    for (const a of model.agents) grid.add(a.usage);
    if (columns.usage !== null) {
      w.write(at(columns.usage, b.y + 4));
      writeEllipsis(w, "Usage · resets in", columns.model - columns.usage - 2);
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
      const title = line.section === "have" ? "Active" : line.section === "hidden" ? "Hidden" : "Add agent";
      writeEllipsis(
        w,
        line.heading
          ? title + (line.section === "add" ? "" : " · " + groups[line.section].length + " · " + View.workspace(model))
          : line.empty
            ? this.query.len
              ? "No matching agents"
              : "Drop an agent here"
            : "",
        b.w - 6,
      );
    });
    for (const { item, y } of this.rows(b, model, true)) {
      const row_start = w.s.length;
      const on = focused && this.focus === "list" && chosen !== null && itemKey(item) === itemKey(chosen),
        hidden = itemRow(item) !== null && this.section(item, model) === "hidden",
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
          (itemRow(item) ? palette.fg("faint") + "≡" + style : "+"),
      );
      if (this.removal && itemKey(item) === itemKey(this.removal.item)) {
        this.drawRemoval(w, b, y, now);
        continue;
      }
      w.write(at(columns.name, y));
      switch (item.kind) {
        case "add":
          writeEllipsis(w, "New " + adapter(item.provider).label + " account", b.w - 8);
          break;
        case "custom":
          writeEllipsis(w, "Custom command", b.w - 8);
          break;
        case "command": {
          const c = model.commands[item.index];
          writeEllipsis(w, c.label(), columns.who - columns.name - 2);
          w.write(at(columns.who, y));
          writeEllipsis(w, cleanControls(c.text()), b.x + b.w - columns.who - 3);
          break;
        }
        case "agent": {
          const a = item.agent;
          writeEllipsis(w, a.label, columns.who - columns.name - 2);
          if (columns.who < columns.model) {
            w.write(at(columns.who, y) + palette.fg(a.signed_out ? "warm" : on ? "muted" : "faint"));
            writeEllipsis(w, cleanControls(a.who), (columns.usage ?? columns.model) - columns.who - 2);
          }
          if (columns.usage !== null) {
            w.write(at(columns.usage, y) + style);
            a.usage.write(w, grid, columns.model - columns.usage - 2, style, on);
          }
          const value = model.options(a).model;
          w.write(at(columns.model, y) + style);
          agentModels.writeModel(
            w,
            value ? AgentModel.resolve(value).label() : "Auto (last chosen)",
            model.options(a).effort,
            b.x + b.w - columns.model - 5,
            style,
          );
          w.write(at(b.x + b.w - 4, y) + "▾");
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
    if (last && chosen && this.removable(chosen, model) && remove_x + 16 < b.x + b.w - 2)
      w.write(at(remove_x, b.y + b.h - 3) + keycap + " hold ⌫ " + faint + " remove");
    if (this.error) {
      w.write(at(b.x + 3, b.y + b.h - 2) + new Style({ fg: "hot", bg: "surface" }).sgr());
      writeEllipsis(w, this.error, sat(b.w, 6));
    } else if (this.removal) {
      const r = this.removal;
      w.write(at(b.x + 3, b.y + b.h - 3) + new Style({ fg: "strong", bg: "surface" }).sgr());
      writeEllipsis(w, `${r.phase === "held" ? "Hold ⌫ to remove" : "Removing"} ${r.label}`, sat(b.w, 6));
      w.write(at(b.x + 3, b.y + b.h - 2) + new Style({ fg: "muted", bg: "surface" }).sgr());
      writeEllipsis(w, `${r.note}${r.phase === "held" ? " · release to cancel" : ""}`, sat(b.w, 6));
    } else if (focused && this.buttons(b, model).length === 0) View.footer(w, b, this.hints(chosen, model));
    return caret;
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
  private drawRemoval(w: Writer, b: Rect, y: number, now: number): void {
    const r = this.removal!,
      grid = new Grid(b.w - 2, 1, palette.colors.text),
      { name, who } = View.columns(new Rect(-1, 0, b.w, 1)),
      finale =
        r.phase === "held" ? 0 : Math.max(0.0001, Math.min(1, (now - r.committed_at) / worktreeRemoval.finale_ms.bury));
    grid.text(0, 0, "›", palette.colors.strong);
    grid.text(name, 0, ellipsis(r.label, sat(who, name + 2)), palette.colors.strong);
    grid.text(who, 0, ellipsis(cleanControls(r.detail), sat(b.w - 3, who)), palette.colors.muted);
    const area = { y: 0, lines: 1, left: 0, right: grid.w - 1, top: 0, bottom: 0 };
    worktreeRemoval.paint(grid, area, "bury", this.hold.progress, finale, now);
    if (r.phase === "removing" && finale >= 1) worktreeRemoval.progress(grid, area, now);
    grid.write(w, b.x + 1, y, new Style({ fg: "text", bg: "selected" }).sgr());
  }
  /** The keys the selected row takes. */
  private hints(item: Item | null, model: Model): Hint[] {
    if (this.focus === "search")
      return [
        ["tab / ↓", "list"],
        ["←", this.back_label.toLowerCase()],
        ["esc", "close"],
      ];
    switch (item?.kind) {
      case undefined:
        return [["esc", "close"]];
      case "add":
        return [["↵", `sign in to a new ${adapter(item.provider).label} account`]];
      case "custom":
        return [["↵", "new command"]];
      case "command":
      case "agent":
        return [
          ["⇧ ↑↓", "reorder"],
          ["h", this.section(item, model) === "have" ? "hide" : "activate"],
          ["c", "clone"],
          ...(item.kind === "agent" ? [["m", "model"] as Hint] : []),
          ["hold ⌫", "remove"],
          ["/", "search"],
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
