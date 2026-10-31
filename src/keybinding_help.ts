import * as model from "./keybindings";
import * as keys from "./keys";
import * as keyboard from "./keyboard";
import * as keymap from "./keymap";
import * as action from "./action";
import { Rect } from "./layout";
import { Writer, displayWidth, clipped, ellipsis, sat } from "./text";
import { Style, type Token } from "./palette";
import { Fetch } from "./corgi_animation";

export type Result =
  { name: "close" } | { name: "action"; action: action.Action } | { name: "save"; config: model.Config } | null;
type Target =
  | { name: "binding"; id: string; index: number }
  | { name: "alternative"; index: number }
  | { name: "modifier"; modifier: keyof keyboard.Mods }
  | { name: "range"; kind: "numbers" | "functions" }
  | {
      name:
        | "close"
        | "customize"
        | "search"
        | "alts"
        | "add"
        | "cancel"
        | "save"
        | "toggle-prefix"
        | "record"
        | "key-set"
        | "modifiers"
        | "finish"
        | "undo"
        | "remove"
        | "restore"
        | "play";
    };
interface Cell {
  column: number;
  lane?: number;
  x: number;
  y: number;
  text: string;
  token: Token;
  target?: Target;
  width: number;
}
interface Hit {
  rect: Rect;
  target: Target;
}
interface Edit {
  id: string;
  index: number;
  prefixed: boolean;
  recorded: keyboard.Key[];
  listening: boolean;
  menu: "keys" | "mods" | null;
  focus: Target;
  shortcuts: model.Shortcut[];
  deleted: { index: number; shortcut: model.Shortcut }[];
  restore: boolean;
  pendingModifiers: keyboard.Mods;
  superAvailable: boolean;
}
interface Control extends Hit {
  disabled?: boolean;
}
const modifiers: readonly (readonly [string, keyof keyboard.Mods])[] = [
  ["Ctrl", "ctrl"],
  ["Alt", "alt"],
  ["Shift", "shift"],
  ["Cmd", "super"],
];
function copy(shortcut: model.Shortcut): model.Shortcut {
  return structuredClone(shortcut);
}
function wrapped(value: string, width: number): string[] {
  const lines: string[] = [];
  while (value) {
    let part = clipped(value, Math.max(1, width));
    if (!part) part = [...value][0];
    if (part.length < value.length && part.lastIndexOf(" ") > width / 2) part = part.slice(0, part.lastIndexOf(" "));
    lines.push(part);
    value = value.slice(part.length).trimStart();
  }
  return lines;
}
const groups: [string, (string | [string, string[]])[]][] = [
  [
    "TABS",
    [
      ["New tab → agent picker", ["new"]],
      ["Next / previous", ["next", "prev"]],
      ["Select tab", ["tab"]],
      ["Rename", ["rename-tab"]],
      ["Close", ["close-tab"]],
    ],
  ],
  [
    "WORKSPACES",
    [
      ["New", ["new-workspace"]],
      ["Edit", ["edit-workspace"]],
      ["Next / previous", ["workspace-next", "workspace-prev"]],
      ["Choose workspace", ["choose-workspace"]],
      ["Select workspace", ["goto-workspace"]],
      ["Close workspace", ["close-workspace"]],
    ],
  ],
  [
    "AGENTS",
    [
      ["● Jump to who needs you", ["attention"]],
      "Navigate",
      ["Find", ["find-agent"]],
      ["Choose", ["choose-agent"]],
      ["Next / previous", ["next-agent", "prev-agent"]],
      ["Last visited", ["last-agent"]],
      "Manage",
      ["New agent", ["new-agent"]],
      ["Close", ["close"]],
      ["Reopen", ["undo-close"]],
      ["Mute / unmute", ["mute"]],
    ],
  ],
];
function sameTarget(a: Target | null, b: Target): boolean {
  return a !== null && JSON.stringify(a) === JSON.stringify(b);
}
function plain(key: keyboard.Key): string | null {
  if (key.mods.ctrl || key.mods.alt || key.mods.super) return null;
  return key.codepoint >= 32 && key.codepoint !== 127 && !(key.codepoint >= 57344 && key.codepoint <= 63743)
    ? String.fromCodePoint(key.codepoint)
    : null;
}
export class State {
  scroll = 0;
  page_rows = 1;
  max_scroll = 0;
  corgi = new Fetch();
  corgi_room = 0;
  customizing = false;
  searching = false;
  query = "";
  show_alts = true;
  selected = { id: "new", index: 0 };
  edit: Edit | null = null;
  error = "";
  private preset: keymap.Preset = "corgi";
  private prefix: keymap.Prefix = "ctrl_b";
  private config: model.Config = {};
  private entries = model.entries("corgi", {});
  private hits: Hit[] = [];
  private controls: Control[] = [];
  private dropdown: Rect | null = null;
  private cells: Cell[] = [];
  private selected_occurrence = 0;
  private panel = new Rect(0, 0, 0, 0);
  private contentTop = 0;
  private dimmed = false;
  private fits = true;
  configure(preset: keymap.Preset, prefix: keymap.Prefix, config: model.Config) {
    this.prefix = prefix;
    if (this.preset === preset && this.config === config) return;
    this.preset = preset;
    this.config = config;
    this.entries = model.entries(preset, config);
    const selected = this.entries.find(e => e.id === this.selected.id) ?? this.entries.find(e => e.id === "new")!;
    this.selected = {
      id: selected.id,
      index: Math.max(0, Math.min(this.selected.index, selected.shortcuts.length - 1)),
    };
  }
  accept(config: model.Config) {
    this.configure(this.preset, this.prefix, config);
    this.edit = null;
    this.error = "";
  }
  move(down: boolean, rows: number) {
    this.scroll = Math.max(0, Math.min(this.max_scroll, this.scroll + (down ? rows : -rows)));
  }
  play(now: number) {
    this.corgi.throwBall(this.corgi_room, now);
  }
  owns(key: keyboard.Key): boolean {
    return (
      this.customizing ||
      this.searching ||
      this.query !== "" ||
      this.edit !== null ||
      keys.normalize(key).codepoint === 27 ||
      keys.same(key, keys.parseChord("ctrl+e")!) ||
      keys.same(key, keys.parseChord("ctrl+l")!) ||
      plain(key) === "/"
    );
  }
  private entry(id: string) {
    return this.entries.find(e => e.id === id)!;
  }
  private draft(): model.Shortcut | null {
    return this.edit?.recorded.length ? { prefixed: this.edit.prefixed, keys: this.edit.recorded } : null;
  }
  private start(id: string, index: number) {
    const entry = this.entry(id),
      current = entry.shortcuts[index];
    this.selected = { id, index: Math.max(index, 0) };
    this.edit = {
      id,
      index: index < 0 ? entry.shortcuts.length : current ? index : -1,
      prefixed: current?.prefixed ?? true,
      recorded: current ? copy(current).keys : [],
      listening: false,
      menu: null,
      focus: { name: current || index < 0 ? (entry.indexed ? "key-set" : "record") : "add" },
      shortcuts: entry.shortcuts.map(copy),
      deleted: [],
      restore: false,
      pendingModifiers: {},
      superAvailable: entry.shortcuts.some(shortcut => shortcut.keys.some(key => key.mods.super)),
    };
    this.controls = [];
    this.error = "";
  }
  private keepDraft() {
    const e = this.edit!,
      draft = this.draft();
    if (e.index < 0 || !draft) return;
    if (e.index < e.shortcuts.length) e.shortcuts[e.index] = copy(draft);
    else e.shortcuts.push(copy(draft));
  }
  private selectAlternative(index: number) {
    const e = this.edit!;
    this.keepDraft();
    e.index = index;
    const current = e.shortcuts[index];
    e.recorded = current ? copy(current).keys : [];
    e.pendingModifiers = {};
    e.prefixed = current?.prefixed ?? true;
    e.listening = false;
    e.menu = null;
    e.focus = { name: index < 0 ? "add" : this.entry(e.id).indexed ? "key-set" : "record" };
    this.error = "";
  }
  private working(): model.Shortcut[] {
    const e = this.edit!,
      shortcuts = e.shortcuts.map(copy),
      draft = this.draft();
    if (e.index >= 0 && draft) shortcuts[e.index] = copy(draft);
    return shortcuts;
  }
  private conflicts() {
    const e = this.edit!,
      shortcuts = this.working();
    return this.entries.filter(
      other => other.id !== e.id && other.shortcuts.some(s => shortcuts.some(k => model.overlaps(s, k))),
    );
  }
  private closeMenu() {
    const e = this.edit!;
    e.focus = { name: e.menu === "keys" ? "key-set" : "modifiers" };
    e.menu = null;
  }
  private modifierState(modifier: keyof keyboard.Mods): boolean | null {
    const e = this.edit!;
    if (!e.recorded.length) return !!e.pendingModifiers[modifier];
    const count = e.recorded.filter(key => key.mods[modifier]).length;
    return count === 0 ? false : count === e.recorded.length ? true : null;
  }
  private commonModifiers(): keyboard.Mods {
    const common: keyboard.Mods = {};
    for (const [, modifier] of modifiers) if (this.modifierState(modifier)) common[modifier] = true;
    return common;
  }
  private mixedModifiers(): boolean {
    return modifiers.some(([, modifier]) => this.modifierState(modifier) === null);
  }
  private modifierLabel(): string {
    if (this.mixedModifiers()) return "Mixed";
    return (
      modifiers
        .filter(([, modifier]) => this.modifierState(modifier))
        .map(([label]) => label)
        .join("+") || "None"
    );
  }
  private options(menu: NonNullable<Edit["menu"]>): { text: string; target: Target }[] {
    switch (menu) {
      case "keys":
        return [
          { text: "[1..9]", target: { name: "range", kind: "numbers" } },
          { text: "[F1..F9]", target: { name: "range", kind: "functions" } },
          { text: "Record a sequence…", target: { name: "record" } },
        ];
      case "mods":
        return modifiers
          .filter(([, modifier]) => modifier !== "super" || this.edit!.superAvailable)
          .map(([label, modifier]) => {
            const checked = this.modifierState(modifier);
            return {
              text: `[${checked === null ? "-" : checked ? "x" : " "}] ${label}`,
              target: { name: "modifier", modifier },
            };
          });
    }
  }
  private activate(t: Target): Result {
    switch (t.name) {
      case "close":
        return { name: "close" };
      case "play":
        this.play(Date.now());
        return null;
      case "customize":
        this.customizing = !this.customizing;
        this.searching = false;
        return null;
      case "search":
        this.searching = true;
        return null;
      case "alts":
        this.show_alts = !this.show_alts;
        this.selected.index = 0;
        return null;
      case "binding": {
        this.selected = { id: t.id, index: t.index };
        if (this.customizing) this.start(t.id, t.index);
        else {
          const e = this.entry(t.id);
          return { name: "action", action: e.indexed ? { name: e.action.name, value: 1 } : e.action };
        }
        return null;
      }
      case "alternative":
        if (this.edit) this.selectAlternative(t.index);
        return null;
      case "add":
        if (this.edit) {
          this.keepDraft();
          this.selectAlternative(this.edit.shortcuts.length);
        } else this.start(this.selected.id, -1);
        return null;
      case "cancel":
        this.edit = null;
        this.error = "";
        return null;
      case "key-set":
      case "modifiers": {
        if (!this.edit) return null;
        const e = this.edit,
          menu = t.name === "key-set" ? "keys" : "mods";
        if (e.menu === menu) this.closeMenu();
        else {
          e.menu = menu;
          e.focus = this.options(menu)[0].target;
        }
        return null;
      }
      case "toggle-prefix":
        if (this.edit) {
          this.edit.prefixed = !this.edit.prefixed;
          this.edit.restore = false;
          this.error = "";
        }
        return null;
      case "range": {
        if (!this.edit) return null;
        const e = this.edit,
          mods = this.commonModifiers();
        e.recorded = Array.from({ length: 9 }, (_, i) => ({
          codepoint: t.kind === "numbers" ? 49 + i : keyboard.f1 + i,
          mods: { ...mods },
        }));
        e.restore = false;
        this.closeMenu();
        this.error = "";
        return null;
      }
      case "modifier":
        if (this.edit) {
          const enabled = this.modifierState(t.modifier) !== true;
          this.edit.pendingModifiers[t.modifier] = enabled;
          this.edit.recorded = this.edit.recorded.map(key =>
            keys.normalize({ codepoint: key.codepoint, mods: { ...key.mods, [t.modifier]: enabled } }),
          );
          this.edit.restore = false;
          this.error = "";
        }
        return null;
      case "record":
        if (this.edit) {
          this.edit.listening = true;
          this.edit.menu = null;
          this.edit.recorded = [];
          this.edit.pendingModifiers = {};
          this.edit.restore = false;
          this.error = "";
        }
        return null;
      case "finish":
        if (this.edit?.recorded.length) {
          this.edit.listening = false;
          this.edit.focus = { name: "save" };
        }
        return null;
      case "save": {
        const e = this.edit;
        if (!e || (e.index >= 0 && !this.draft()) || e.listening) return null;
        try {
          return {
            name: "save",
            config: e.restore
              ? model.restore(this.preset, this.config, e.id)
              : model.replace(this.preset, this.config, e.id, this.working(), true),
          };
        } catch (error) {
          this.error = (error as Error).message;
          return null;
        }
      }
      case "remove": {
        const e = this.edit;
        if (!e || e.index < 0 || e.index >= e.shortcuts.length) return null;
        this.keepDraft();
        e.deleted.push({ index: e.index, shortcut: e.shortcuts.splice(e.index, 1)[0] });
        e.index = Math.min(e.index, e.shortcuts.length - 1);
        const next = e.shortcuts[e.index];
        e.recorded = next ? copy(next).keys : [];
        e.prefixed = next?.prefixed ?? true;
        e.focus = e.index < 0 ? { name: "add" } : { name: "alternative", index: e.index };
        e.restore = false;
        this.error = "";
        return null;
      }
      case "undo": {
        const e = this.edit,
          removed = e?.deleted.pop();
        if (!e || !removed) return null;
        this.keepDraft();
        e.index = Math.min(removed.index, e.shortcuts.length);
        e.shortcuts.splice(e.index, 0, copy(removed.shortcut));
        e.recorded = copy(removed.shortcut).keys;
        e.prefixed = removed.shortcut.prefixed;
        e.focus = { name: "alternative", index: e.index };
        this.error = "";
        return null;
      }
      case "restore": {
        if (!this.edit) return null;
        try {
          model.restore(this.preset, this.config, this.edit.id);
          const e = this.edit;
          e.shortcuts = this.entry(e.id).defaults.map(copy);
          e.index = e.shortcuts.length ? 0 : -1;
          e.recorded = e.shortcuts[0] ? copy(e.shortcuts[0]).keys : [];
          e.prefixed = e.shortcuts[0]?.prefixed ?? true;
          e.deleted = [];
          e.restore = true;
          e.menu = null;
          e.focus = { name: "save" };
          this.error = "";
        } catch (error) {
          this.error = (error as Error).message;
        }
        return null;
      }
    }
  }
  key(byte: number): Result {
    return this.event({ codepoint: byte, mods: {} });
  }
  sequence(seq: string): Result {
    const k = keyboard.decode(seq);
    return k ? this.event(k) : null;
  }
  event(raw: keyboard.Key): Result {
    if (this.fits && this.panel.w >= 42) {
      this.cells = this.content(this.panel.w - 6).cells;
      if (this.edit) this.popup(new Writer());
    }
    const cp = raw.codepoint >= 57344 && raw.codepoint <= 57347 ? keys.normalize(raw).codepoint : raw.codepoint,
      text = plain(raw);
    if (cp === 27) {
      if (this.edit) {
        if (this.edit.menu) this.closeMenu();
        else this.edit = null;
        this.error = "";
        return null;
      }
      if (this.query || this.searching) {
        this.query = "";
        this.searching = false;
        this.scroll = 0;
        return null;
      }
      if (this.customizing) {
        this.customizing = false;
        return null;
      }
      return { name: "close" };
    }
    if (!this.fits) return null;
    if (this.edit) {
      const e = this.edit,
        entry = this.entry(e.id);
      if (e.listening) {
        if (entry.indexed && cp === 13) {
          if (e.recorded.length) this.activate({ name: "finish" });
          return null;
        }
        if (entry.indexed && cp === 127) {
          e.recorded.pop();
          return null;
        }
        const k = keys.normalize(raw);
        if (e.prefixed && keys.same(k, { codepoint: keymap.prefixByte(this.prefix), mods: {} })) return null;
        if (cp >= 57441 && cp <= 57454) return null;
        try {
          model.chord(keys.chordName(k));
        } catch {
          this.error = "That key is not supported. Try another key.";
          return null;
        }
        if (e.recorded.some(other => keys.same(k, other))) {
          this.error = "That key is already in the set.";
          return null;
        }
        if (e.recorded.length === 32) {
          this.error = "The set already has 32 keys.";
          return null;
        }
        if (k.mods.super) e.superAvailable = true;
        e.recorded.push(k);
        this.error = "";
        if (!entry.indexed) this.activate({ name: "finish" });
        return null;
      }
      if (!e.menu && (keys.same(raw, keys.parseChord("ctrl+z")!) || keys.same(raw, keys.parseChord("cmd+z")!)))
        return this.activate({ name: "undo" });
      if (!e.menu && (cp === 127 || cp === 8) && !raw.mods.ctrl && !raw.mods.alt && !raw.mods.super) {
        if (e.focus.name === "alternative" && e.focus.index !== e.index) this.selectAlternative(e.focus.index);
        return this.activate({ name: "remove" });
      }
      if (cp === 9) {
        if (e.menu) {
          this.closeMenu();
          this.popup(new Writer());
        }
        const enabled = this.controls.filter(c => !c.disabled),
          at = enabled.findIndex(c => sameTarget(c.target, e.focus));
        e.focus =
          enabled[(Math.max(0, at) + (raw.mods.shift ? -1 : 1) + enabled.length) % enabled.length]?.target ?? e.focus;
        return null;
      }
      if ([keyboard.arrow_up, keyboard.arrow_down, keyboard.arrow_left, keyboard.arrow_right].includes(cp)) {
        this.navigateEditor(cp);
        return null;
      }
      if (cp === 13 || text === " ") {
        const target = this.controls.find(c => sameTarget(c.target, e.focus) && !c.disabled)?.target;
        return target ? this.activate(target) : null;
      }
      return null;
    }
    if (keys.same(raw, keys.parseChord("ctrl+l")!)) return this.activate({ name: "alts" });
    if (keys.same(raw, keys.parseChord("ctrl+e")!)) return this.activate({ name: "customize" });
    if (this.searching) {
      if (cp === 13 || cp === keyboard.arrow_down) {
        this.searching = false;
        this.select(0);
        return null;
      }
      if (cp === 127 || cp === 8) {
        this.query = [...this.query].slice(0, -1).join("");
        this.scroll = 0;
        return null;
      }
      if (text !== null && this.query.length < 128) {
        this.query += text;
        this.scroll = 0;
        this.cells = this.content(Math.max(36, this.panel.w - 6)).cells;
        this.select(0);
      }
      return null;
    }
    if (text === "/") {
      this.searching = true;
      return null;
    }
    if ([keyboard.arrow_up, keyboard.arrow_down, keyboard.arrow_left, keyboard.arrow_right, 9].includes(cp)) {
      if (cp === 9) this.select(raw.mods.shift ? -1 : 1);
      else this.selectDirection(cp);
      return null;
    }
    if (cp === 57354 || cp === 57355) {
      this.move(cp === 57355, this.page_rows);
      return null;
    }
    const selected = this.cells.some(c => sameTarget(c.target ?? null, { name: "binding", ...this.selected }));
    if (cp === 13 && (this.query || this.customizing) && selected)
      return this.activate({ name: "binding", ...this.selected });
    if (this.customizing && text === "+" && selected) return this.activate({ name: "add" });
    return null;
  }
  private navigateEditor(cp: number) {
    const e = this.edit!,
      enabled = this.controls.filter(c => !c.disabled);
    const current = enabled.find(c => sameTarget(c.target, e.focus));
    if (!current) {
      e.focus = enabled[0]?.target ?? e.focus;
      return;
    }
    if (e.menu) {
      if (cp === keyboard.arrow_left) this.closeMenu();
      else if (cp === keyboard.arrow_right) this.activate(e.focus);
      else
        e.focus =
          enabled[
            (enabled.indexOf(current) + (cp === keyboard.arrow_up ? -1 : 1) + enabled.length) % enabled.length
          ].target;
      return;
    }
    const horizontal = cp === keyboard.arrow_left || cp === keyboard.arrow_right,
      sign = cp === keyboard.arrow_up || cp === keyboard.arrow_left ? -1 : 1;
    const row = (c: Control) => c.rect.y + Math.floor(c.rect.h / 2);
    const candidates = enabled.filter(c =>
      horizontal
        ? row(c) === row(current) && (c.rect.x - current.rect.x) * sign > 0
        : (row(c) - row(current)) * sign > 0,
    );
    candidates.sort((a, b) =>
      horizontal
        ? Math.abs(a.rect.x - current.rect.x) - Math.abs(b.rect.x - current.rect.x)
        : Math.abs(row(a) - row(current)) - Math.abs(row(b) - row(current)) ||
          Math.abs(a.rect.x - current.rect.x) - Math.abs(b.rect.x - current.rect.x),
    );
    if (candidates[0]) e.focus = candidates[0].target;
  }
  private selectDirection(cp: number) {
    const current = this.selectedCell();
    if (!current) {
      this.select(0);
      return;
    }
    const horizontal = cp === keyboard.arrow_left || cp === keyboard.arrow_right;
    const sign = cp === keyboard.arrow_left || cp === keyboard.arrow_up ? -1 : 1;
    const candidates = this.cells.filter(
      c =>
        c.target?.name === "binding" &&
        (horizontal || c.column === current.column) &&
        (horizontal || c.lane === undefined || current.lane === undefined || c.lane === current.lane) &&
        (horizontal ? c.x - current.x : c.y - current.y) * sign > 0,
    );
    candidates.sort((a, b) => {
      // Visit the next row before choosing among its bindings.
      if (!horizontal)
        return (
          Math.abs(a.y - current.y) - Math.abs(b.y - current.y) || Math.abs(a.x - current.x) - Math.abs(b.x - current.x)
        );
      const score = (c: Cell) => Math.abs(c.y - current.y) * 10 + Math.abs(c.x - current.x);
      return score(a) - score(b);
    });
    const next = candidates[0];
    if (next) this.selectCell(next);
  }
  private selectedCell(): Cell | undefined {
    const matches = this.cells.filter(c => sameTarget(c.target ?? null, { name: "binding", ...this.selected }));
    return matches[this.selected_occurrence] ?? matches[0];
  }
  private selectCell(cell: Cell) {
    if (cell.target?.name !== "binding") return;
    this.selected = { id: cell.target.id, index: cell.target.index };
    this.selected_occurrence = this.cells.filter(c => sameTarget(c.target ?? null, cell.target!)).indexOf(cell);
    this.reveal(cell);
  }
  private reveal(cell: Cell) {
    if (cell.y < this.scroll) this.scroll = cell.y;
    if (cell.y >= this.scroll + this.page_rows) this.scroll = cell.y - this.page_rows + 1;
  }
  private select(delta: number) {
    const targets = this.cells.filter(c => c.target?.name === "binding");
    if (!targets.length) return;
    const current = this.selectedCell();
    const at = targets.findIndex(c => c === current);
    const cell = targets[delta === 0 ? 0 : (Math.max(0, at) + delta + targets.length) % targets.length];
    this.selectCell(cell);
  }
  pointsAt(x: number, y: number): boolean {
    return this.hitAt(x, y) !== undefined;
  }
  private hitAt(x: number, y: number): Hit | undefined {
    const insideMenu = this.edit?.menu != null && this.dropdown?.contains(x, y);
    return [...this.hits]
      .reverse()
      .find(h => h.rect.contains(x, y) && (!insideMenu || this.controls.some(c => sameTarget(c.target, h.target))));
  }
  click(x: number, y: number): Result {
    if (!this.fits) return null;
    const hit = this.hitAt(x, y);
    if (hit) {
      if (this.edit) {
        const control = this.controls.find(c => sameTarget(c.target, hit.target));
        if (control?.disabled) return null;
        if (this.edit.menu && !this.dropdown?.contains(x, y)) this.closeMenu();
        this.edit.focus = hit.target;
      } else if (hit.target.name === "binding") {
        const cell = this.cells.find(
          c => c.x + this.panel.x + 3 === hit.rect.x && c.y + this.contentTop - this.scroll === hit.rect.y,
        );
        if (cell) this.selectCell(cell);
      }
      return this.activate(hit.target);
    }
    if (this.edit) {
      if (this.edit.menu && !this.dropdown?.contains(x, y)) this.closeMenu();
      return null;
    }
    return this.panel.contains(x, y) ? null : { name: "close" };
  }
  private content(width: number): { cells: Cell[]; total: number } {
    const capWidth = Math.max(
      6,
      ...this.entries
        .filter(e => e.id.startsWith("focus:") || e.id.startsWith("swap:"))
        .flatMap(e =>
          e.shortcuts.slice(0, this.show_alts ? undefined : 1).map(s => displayWidth(model.display(s)) + 2),
        ),
    );
    const dual = width >= 58 && !this.query;
    const colWidth = dual ? Math.floor((width - 5) / 2) : width;
    const cells: Cell[] = [],
      ys = [0, 0],
      shownIds = new Set<string>();
    const add = (
      col: number,
      x: number,
      y: number,
      text: string,
      token: Token,
      target?: Target,
      maxWidth = colWidth - x,
      lane?: number,
    ) => {
      cells.push({ column: col, lane, x: x + (col ? colWidth + 5 : 0), y, text, token, target, width: maxWidth });
      if (target?.name === "binding") shownIds.add(target.id);
    };
    const bindingWidth = Math.min(
      colWidth - 3,
      Math.max(
        5,
        ...this.entries.flatMap(e =>
          e.shortcuts.map(shortcut => 2 + displayWidth(model.display({ ...shortcut, prefixed: false }))),
        ),
      ),
    );
    const tabular = (shortcut: model.Shortcut | null) =>
      shortcut ? (shortcut.prefixed ? "◇ " : "  ") + model.display({ ...shortcut, prefixed: false }) : "  —";
    const row = (col: number, label: string, ids: string[]) => {
      const entries = ids.map(id => this.entries.find(e => e.id === id)).filter((e): e is model.Entry => !!e);
      if (!entries.length) return;
      const shown = entries.flatMap(e =>
        (e.shortcuts.length ? e.shortcuts : [null])
          .slice(0, this.show_alts ? undefined : 1)
          .map((s, index) => ({ e, s, index })),
      );
      const first = shown[0];
      if (!first) return;
      const inline = colWidth >= Math.max(44, bindingWidth * 2 + 18);
      const keyStart = Math.max(3, colWidth - bindingWidth * (inline ? 2 : 1) - (inline ? 3 : 0)),
        separator = inline ? keyStart + bindingWidth + 1 : keyStart - 2;
      let y = ys[col];
      const firstText = tabular(first.s);
      if (displayWidth(label) + 2 > keyStart) {
        for (const line of wrapped(label, colWidth - 2)) add(col, 1, y++, line, "text");
      } else add(col, 1, y, label, label.startsWith("●") ? "warm" : "text");
      const primary = wrapped(firstText, bindingWidth);
      primary.forEach((line, i) =>
        add(col, keyStart, y + i, line, "text", { name: "binding", id: first.e.id, index: first.index }, bindingWidth),
      );
      let altY = y + (inline ? 0 : primary.length);
      shown.slice(1).forEach(({ e, s, index }) => {
        add(col, separator, altY, "/", "faint");
        const lines = wrapped(tabular(s), bindingWidth);
        lines.forEach((line, i) =>
          add(col, separator + 2, altY + i, line, "text", { name: "binding", id: e.id, index }, bindingWidth),
        );
        altY += lines.length;
      });
      ys[col] = Math.max(y + primary.length, altY);
    };
    const heading = (col: number, title: string) => {
      add(col, 0, ys[col]++, title + " " + "─".repeat(Math.max(0, colWidth - displayWidth(title) - 1)), "faint");
    };
    if (this.query) {
      heading(0, "MATCHING SHORTCUTS");
      const q = this.query.toLocaleLowerCase();
      const matches = this.entries.filter(e =>
        (
          e.title +
          " " +
          e.id +
          " " +
          e.shortcuts.map(s => JSON.stringify(model.serialize(s, e.indexed)) + " " + model.display(s)).join(" ")
        )
          .toLocaleLowerCase()
          .includes(q),
      );
      for (const e of matches) row(0, e.title, [e.id]);
      if (!matches.length) add(0, 1, ys[0]++, "No matching actions.", "muted");
      return { cells, total: ys[0] };
    }
    const group = ([title, items]: (typeof groups)[number]) => {
      heading(0, title);
      for (const item of items) {
        if (typeof item === "string") add(0, 1, ys[0]++, item, "strong");
        else if (
          item[1].some(id => this.entry(id)?.shortcuts.length || this.entry(id)?.custom || ["tab", "new"].includes(id))
        )
          row(0, item[0], item[1]);
      }
      ys[0]++;
    };
    for (const item of dual ? groups : groups.slice(0, 1)) group(item);
    const col = dual ? 1 : 0;
    heading(col, "PANES");
    const start = ys[col];
    const sideBySide = colWidth >= 2 * (capWidth * 3 + 2) + 3;
    const compassWidth = sideBySide ? Math.floor((colWidth - 3) / 2) : colWidth;
    const slot = Math.max(3, Math.floor((compassWidth - 2) / 3));
    const capLines = (entry: model.Entry) =>
      (entry.shortcuts.length ? entry.shortcuts : [null])
        .slice(0, this.show_alts ? undefined : 1)
        .flatMap((s, index) => wrapped("[" + (s ? model.display(s) : "—") + "]", slot).map(text => ({ text, index })));
    const count = Math.max(
      1,
      ...this.entries.filter(e => e.id.startsWith("focus:") || e.id.startsWith("swap:")).map(e => capLines(e).length),
    );
    const compassHeight = 3 + 2 * count;
    ["focus", "swap"].forEach((name, i) => {
      const x = sideBySide ? i * (compassWidth + 3) : 0;
      const top = start + (sideBySide ? 0 : i * (compassHeight + 1));
      add(col, x, top, i ? "Swap" : "Focus", "strong");
      for (const [dir, dx, dy] of [
        ["up", 1, 1],
        ["left", 0, 2 + count],
        ["down", 1, 2 + count],
        ["right", 2, 2 + count],
      ] as const) {
        const e = this.entry(name + ":" + dir);
        if (!e) continue;
        capLines(e).forEach(({ text, index }, line) => {
          add(
            col,
            x + dx * (slot + 1),
            top + dy + line,
            text,
            "text",
            { name: "binding", id: e.id, index },
            slot,
            sideBySide ? i : undefined,
          );
        });
      }
    });
    ys[col] = start + (sideBySide ? compassHeight : 2 * compassHeight + 1);
    row(col, "Close", ["close"]);
    ys[col]++;
    add(col, 1, ys[col]++, "Split", "strong");
    const splitY = ys[col];
    let splitRows = 1;
    for (const [i, side] of ["right", "down"].entries()) {
      const x = i * Math.floor(colWidth / 2),
        entry = this.entry("split:" + side);
      const diagram = side === "right" ? ["┌──┬──┐", "│  │  │", "└──┴──┘"] : ["┌─────┐", "├─────┤", "└─────┘"];
      diagram.forEach((text, j) => add(col, x + 1, splitY + j, text, "faint"));
      add(col, x + 1, splitY + 3, side === "right" ? "Right" : "Down", "text");
      const splitCaps = (entry.shortcuts.length ? entry.shortcuts : [null])
        .slice(0, this.show_alts ? undefined : 1)
        .flatMap((s, index) =>
          wrapped("[" + (s ? model.display(s) : "—") + "]", Math.floor(colWidth / 2) - 2).map(text => ({
            text,
            index,
          })),
        );
      splitRows = Math.max(splitRows, splitCaps.length);
      splitCaps.forEach(({ text, index }, line) =>
        add(
          col,
          x + 1,
          splitY + 4 + line,
          text,
          "text",
          { name: "binding", id: entry.id, index },
          Math.floor(colWidth / 2) - 2,
          i,
        ),
      );
    }
    ys[col] = splitY + 5 + splitRows;
    add(col, 1, ys[col]++, "Arrange", "strong");
    row(col, "Resize", ["resize-mode"]);
    row(col, "Zoom / unzoom", ["zoom"]);
    row(col, "Move to new tab", ["break"]);
    ys[col]++;
    if (!dual) for (const item of groups.slice(1)) group(item);
    heading(col, "TERMINAL");
    row(col, "Scroll / copy", ["copy-mode"]);
    row(col, "Detach", ["detach"]);
    ys[col]++;
    heading(col, "CORGI");
    row(col, "Toggle sidebar", ["sidebar"]);
    row(col, "Review changes", ["review"]);
    row(col, "Setup", ["setup"]);
    row(col, "Shortcuts", ["help"]);
    const remaining = this.entries.filter(e => !shownIds.has(e.id) && (e.shortcuts.length || e.custom));
    if (remaining.length) {
      ys[col]++;
      heading(col, "MORE");
      for (const entry of remaining) row(col, entry.title, [entry.id]);
    }
    return { cells, total: Math.max(...ys) };
  }
  private draw(
    w: Writer,
    x: number,
    y: number,
    text: string,
    token: Token = "text",
    width = 999,
    target?: Target,
    bold = false,
  ) {
    const room = Math.min(width, this.panel.x + this.panel.w - x);
    if (room <= 0 || y >= this.panel.y + this.panel.h) return;
    const style = new Style({
      fg: this.dimmed ? "line" : token,
      bg: this.dimmed ? "bg" : "surface",
      bold: !this.dimmed && (bold || token === "strong"),
    }).sgr();
    w.write(`\x1b[${y + 1};${x + 1}H${style}`);
    const dim = new Style({ fg: this.dimmed ? "line" : "faint", bg: this.dimmed ? "bg" : "surface" }).sgr();
    w.write(
      ellipsis(text, room).replace(/\[(F?\d+\.\.F?\d+)\]/g, (_, body) => dim + "[" + style + body + dim + "]" + style),
    );
    if (target) this.hits.push({ rect: new Rect(x, y, Math.min(room, displayWidth(text)), 1), target });
  }
  private box(w: Writer, b: Rect, border: Token = "line") {
    for (let y = 0; y < b.h; y++)
      this.draw(
        w,
        b.x,
        b.y + y,
        (y === 0 ? "┌" : y === b.h - 1 ? "└" : "│") +
          (y === 0 || y === b.h - 1 ? "─" : " ").repeat(Math.max(0, b.w - 2)) +
          (y === 0 ? "┐" : y === b.h - 1 ? "┘" : "│"),
        border,
        b.w,
      );
  }
  private popup(w: Writer) {
    const e = this.edit!,
      entry = this.entry(e.id);
    const bordered = this.panel.h >= 23 && this.panel.w >= 56;
    const width = Math.min(60, this.panel.w - 2),
      height = bordered ? 21 : Math.min(15, this.panel.h - 2);
    const b = new Rect(
      this.panel.x + Math.floor((this.panel.w - width) / 2),
      this.panel.y + Math.floor((this.panel.h - height) / 2),
      width,
      height,
    );
    this.box(w, b);
    this.hits = [];
    this.controls = [];
    this.dropdown = null;
    const buttons: {
      rect: Rect;
      text: string;
      target: Target;
      disabled: boolean;
      active: boolean;
      kind: "button" | "field" | "plain";
      hint: string;
    }[] = [];
    const button = (
      x: number,
      y: number,
      text: string,
      target: Target,
      room = displayWidth(text) + 4,
      disabled = false,
      active = false,
      kind: "button" | "field" | "plain" = "button",
      hint = "",
    ) => {
      const rect = new Rect(b.x + x, b.y + y, Math.min(room, b.w - x - 2), bordered && kind !== "plain" ? 3 : 1);
      buttons.push({ rect, text, target, disabled, active, kind, hint });
      return rect;
    };
    const draw = (x: number, y: number, text: string, token: Token = "text", room = b.w - x - 2) =>
      this.draw(w, b.x + x, b.y + y, text, token, room);
    const chipY = 3,
      chipCenter = bordered ? 4 : 3,
      scopeY = bordered ? 7 : 5;
    const labelY = bordered ? 9 : 7,
      fieldY = bordered ? 10 : 8;
    const footerY = bordered ? 17 : b.h - 3;
    draw(2, 1, entry.title, "strong", b.w - 7);
    const pageSize = this.panel.w < 56 ? 1 : 2;
    const page = Math.floor(Math.max(0, e.index) / pageSize) * pageSize;
    let chipX = 2;
    if (page > 0) {
      button(chipX, chipCenter, "‹", { name: "alternative", index: page - 1 }, 1, false, false, "plain");
      chipX += 2;
    }
    const removeWidth = bordered ? 16 : 6,
      right = b.w - removeWidth - 4;
    const chipRoom = Math.max(5, Math.floor((right - chipX - 5) / Math.min(pageSize, e.shortcuts.length || 1)));
    for (let index = page; index < Math.min(e.shortcuts.length, page + pageSize); index++) {
      const label = model.display(index === e.index ? (this.draft() ?? e.shortcuts[index]) : e.shortcuts[index]);
      const room = Math.min(displayWidth(label) + (bordered ? 4 : 2), chipRoom);
      button(chipX, chipY, label, { name: "alternative", index }, room, false, index === e.index);
      chipX += room + 1;
    }
    if (!e.shortcuts.length) {
      draw(2, chipCenter, "No shortcuts", "muted");
      chipX = 15;
    }
    if (page + pageSize < e.shortcuts.length) {
      button(chipX, chipCenter, "›", { name: "alternative", index: page + pageSize }, 1, false, false, "plain");
      chipX += 2;
    }
    button(chipX, chipCenter, "+", { name: "add" }, 1, e.shortcuts.length >= 16, false, "plain");
    button(
      b.w - removeWidth - 2,
      chipCenter,
      "Remove",
      { name: "remove" },
      removeWidth,
      e.index < 0 || e.index >= e.shortcuts.length,
      false,
      "plain",
      bordered ? "Backspace" : "",
    );
    const half = Math.floor((b.w - 5) / 2);
    let keysRect: Rect | null = null,
      modsRect: Rect | null = null;
    if (e.index < 0) draw(2, labelY, "Add a shortcut with +", "muted");
    else {
      button(
        2,
        scopeY,
        (e.prefixed ? "[x]" : "[ ]") + " Use prefix",
        { name: "toggle-prefix" },
        28,
        e.listening,
        e.prefixed,
        "plain",
        "◇ " + keymap.prefixName(this.prefix),
      );
      if (e.listening) {
        draw(2, labelY, entry.indexed ? "Press keys in order…" : "Press a shortcut…", "accent");
        const capture = new Rect(b.x + 2, b.y + fieldY, b.w - 4, bordered ? 3 : 1);
        if (bordered) this.box(w, capture, "accent");
        this.draw(
          w,
          capture.x + 2,
          capture.y + (bordered ? 1 : 0),
          this.draft() ? model.display({ ...this.draft()!, prefixed: false }) : "…",
          "accent",
          capture.w - 4,
        );
        if (entry.indexed) draw(2, bordered ? 13 : 9, "Backspace undo", "faint");
      } else if (entry.indexed) {
        draw(2, labelY, "Keys", "faint");
        draw(half + 3, labelY, "Modifiers", "faint");
        const shown = this.mixedModifiers()
          ? e.recorded
          : e.recorded.map(key => ({ codepoint: key.codepoint, mods: {} }));
        const value = shown.length ? model.display({ prefixed: false, keys: shown }) : "—";
        keysRect = button(2, fieldY, value, { name: "key-set" }, half, false, false, "field", "⌄");
        modsRect = button(
          half + 3,
          fieldY,
          this.modifierLabel(),
          { name: "modifiers" },
          half,
          false,
          false,
          "field",
          "⌄",
        );
      } else {
        draw(2, labelY, "Shortcut", "faint");
        button(
          2,
          fieldY,
          this.draft() ? model.display({ ...this.draft()!, prefixed: false }) : "—",
          { name: "record" },
          b.w - 4,
          false,
          false,
          "field",
          "Record Enter",
        );
      }
    }
    const conflicts = this.conflicts(),
      blocked = conflicts.some(other => other.indexed && !entry.indexed);
    const current = this.working().map(s => model.serialize(s, entry.indexed));
    const defaults = entry.defaults.map(s => model.serialize(s, entry.indexed));
    const atDefault = JSON.stringify(current) === JSON.stringify(defaults);
    if (!atDefault && !e.listening) {
      draw(
        2,
        bordered ? 14 : 10,
        "Default " + entry.defaults.map(s => model.display(s)).join(" / "),
        "faint",
        b.w - 22,
      );
      button(b.w - 17, bordered ? 14 : 10, "Use defaults", { name: "restore" }, 15, false, false, "plain");
    }
    const message =
      this.error ||
      (conflicts.length
        ? "Used by " + conflicts.map(c => c.title).join(", ") + (blocked ? "; edit its key set" : "; Move reassigns it")
        : "");
    if (message) draw(2, bordered ? 15 : 9, message, "warm");
    draw(2, footerY - 1, "─".repeat(b.w - 4), "line");
    button(2, footerY, "Cancel", { name: "cancel" }, 14, false, false, "button", "Esc");
    if (e.deleted.length && !e.listening) {
      const room = Math.min(16, b.w - 32);
      button(
        18,
        footerY + (bordered ? 1 : 0),
        "Undo",
        { name: "undo" },
        room,
        false,
        false,
        "plain",
        room >= 11 ? "Ctrl+Z" : "",
      );
    }
    const ready = !blocked && (e.index < 0 || e.recorded.length > 0);
    const saving = e.listening && entry.indexed ? "Done" : conflicts.length ? "Move" : "Save";
    const saveWidth = e.listening && entry.indexed ? 14 : 10;
    button(
      b.w - saveWidth - 2,
      footerY,
      saving,
      { name: e.listening && entry.indexed ? "finish" : "save" },
      saveWidth,
      !ready || (e.listening && !entry.indexed),
      true,
      "button",
      e.listening && entry.indexed ? "Enter" : "",
    );
    for (const c of buttons) {
      const focused = !e.listening && !e.menu && sameTarget(e.focus, c.target) && !c.disabled;
      const border: Token = focused ? "accent" : c.active && c.target.name === "alternative" ? "muted" : "line";
      const boxed = c.rect.h === 3;
      if (boxed) this.box(w, c.rect, border);
      else this.draw(w, c.rect.x, c.rect.y, " ".repeat(c.rect.w), "text", c.rect.w);
      const padding = boxed ? 2 : c.kind === "plain" ? 0 : 1;
      const inside = c.rect.w - padding * 2,
        hintWidth = displayWidth(c.hint);
      const labelWidth = Math.max(0, inside - (c.hint ? hintWidth + 1 : 0));
      const centered = c.kind === "button" && !c.hint;
      const x = c.rect.x + padding + (centered ? Math.max(0, Math.floor((labelWidth - displayWidth(c.text)) / 2)) : 0);
      const y = c.rect.y + (boxed ? 1 : 0);
      this.draw(
        w,
        x,
        y,
        c.text,
        c.disabled ? "faint" : focused ? "accent" : c.active ? "strong" : "text",
        labelWidth,
        undefined,
        focused || c.active,
      );
      if (c.hint)
        this.draw(w, c.rect.x + c.rect.w - padding - hintWidth, y, c.hint, c.disabled ? "faint" : "muted", hintWidth);
      if (focused) {
        this.draw(w, c.rect.x - 1, y, "›", "accent", 1);
      }
      if (!c.disabled) this.hits.push({ rect: c.rect, target: c.target });
      this.controls.push({ rect: c.rect, target: c.target, disabled: c.disabled });
    }
    if (!e.menu) return;
    const options = this.options(e.menu),
      anchor = e.menu === "keys" ? keysRect : modsRect;
    if (!anchor) {
      this.closeMenu();
      return;
    }
    const menuWidth = Math.min(b.w - 4, Math.max(anchor.w, ...options.map(o => displayWidth(o.text) + 4)));
    const x = Math.min(anchor.x, b.x + b.w - menuWidth - 1),
      y = anchor.y + anchor.h;
    const visible = Math.min(options.length, Math.max(1, this.panel.y + this.panel.h - y - 2));
    const at = Math.max(
      0,
      options.findIndex(o => sameTarget(e.focus, o.target)),
    );
    const start = Math.max(0, Math.min(at - visible + 1, options.length - visible));
    const menu = new Rect(x, y, menuWidth, visible + 2);
    this.box(w, menu);
    this.dropdown = menu;
    this.controls = options.map((option, index) => ({
      target: option.target,
      rect: new Rect(x + 1, y + 1 + index - start, menuWidth - 2, 1),
    }));
    options.slice(start, start + visible).forEach((option, index) => {
      const selected = sameTarget(e.focus, option.target),
        line = option.text.padEnd(menuWidth - 2);
      this.draw(w, x + 1, y + index + 1, line, selected ? "accent" : "text", menuWidth - 2, option.target, selected);
    });
  }
  frame(
    cols: number,
    rows: number,
    preset: keymap.Preset,
    prefix: keymap.Prefix,
    now: number,
    pointer = "default",
  ): string {
    this.configure(preset, prefix, this.config);
    const width = Math.min(cols, 112),
      height = Math.min(rows, 48);
    const b = new Rect(Math.floor((cols - width) / 2), Math.floor((rows - height) / 2), width, height);
    const resized = this.panel.w > 0 && (this.panel.w !== b.w || this.panel.h !== b.h);
    this.panel = b;
    const w = new Writer();
    this.hits = [];
    this.fits = width >= 42 && height >= 18;
    w.write("\x1b[?2026h\x1b[?25l" + new Style({ fg: "text", bg: "bg" }).sgr() + "\x1b[2J");
    if (!this.fits) {
      this.controls = [];
      this.dropdown = null;
      this.draw(w, b.x, b.y, "Shortcuts need 42 × 18 · Esc back");
      return w.buffered() + "\x1b[0m\x1b[?2026l";
    }
    this.dimmed = this.edit !== null;
    this.box(w, b);
    this.draw(w, b.x + 2, b.y, " Corgi ", "strong");
    this.draw(w, b.x + 2, b.y + 1, b.w < 60 ? "Shortcuts" : "Keyboard shortcuts", "strong");
    this.draw(
      w,
      b.x + b.w - 22,
      b.y + 1,
      this.customizing ? "[Done customizing]" : "[Customize Ctrl+E]",
      "strong",
      20,
      { name: "customize" },
    );
    this.draw(w, b.x + 2, b.y + 3, "◇ Prefix = " + keymap.prefixName(prefix), "faint", 22);
    this.draw(
      w,
      b.w < 65 ? b.x + 2 : b.x + b.w - 29,
      b.y + (b.w < 65 ? 4 : 3),
      "/ " + (this.query || (this.searching ? "▏" : "Find action or key…")),
      this.searching ? "accent" : "muted",
      26,
      { name: "search" },
    );
    const layout = this.content(b.w - 6);
    this.cells = layout.cells;
    this.contentTop = b.y + 5;
    this.page_rows = b.h - 9;
    this.max_scroll = sat(layout.total, this.page_rows);
    this.scroll = Math.min(this.scroll, this.max_scroll);
    const selected = this.customizing ? this.selectedCell() : undefined;
    if (resized && selected && !this.edit) this.reveal(selected);
    for (const c of this.cells)
      if (c.y >= this.scroll && c.y < this.scroll + this.page_rows) {
        this.draw(
          w,
          b.x + 3 + c.x,
          this.contentTop + c.y - this.scroll,
          c.text,
          c === selected ? "accent" : c.token,
          c.width,
          c.target,
          c === selected,
        );
      }
    if (this.max_scroll > 0) {
      const length = Math.max(1, Math.floor((this.page_rows * this.page_rows) / layout.total));
      const start = Math.round((this.scroll / this.max_scroll) * (this.page_rows - length));
      for (let row = 0; row < this.page_rows; row++) {
        const thumb = row >= start && row < start + length;
        this.draw(w, b.x + b.w - 2, this.contentTop + row, thumb ? "┃" : "│", thumb ? "faint" : "line", 1);
      }
    }
    if (!this.edit) {
      const footer = this.customizing
        ? "Arrows Select · Enter Edit · + Add · / Find"
        : "Press a shortcut · Ctrl+E Customize · / Find";
      this.draw(w, b.x + 2, b.y + b.h - 3, footer, "faint", b.w - 4);
      this.draw(w, b.x + 2, b.y + b.h - 2, this.show_alts ? "[Hide alts Ctrl+L]" : "[Show alts Ctrl+L]", "muted", 25, {
        name: "alts",
      });
      this.draw(w, b.x + b.w - 12, b.y + b.h - 2, "[Esc Back]", "strong", 11, { name: "close" });
      this.corgi_room = Math.max(0, b.w - 48);
      if (this.corgi_room > 10)
        this.draw(
          w,
          b.x + 29,
          b.y + b.h - 2,
          this.corgi.write(this.corgi_room, now).replace(/\x1b\[[0-9;:]*m/g, ""),
          "faint",
          this.corgi_room,
          {
            name: "play",
          },
        );
      if (this.error) this.draw(w, b.x + 2, b.y + b.h - 3, this.error, "warm", b.w - 4);
    }
    this.dimmed = false;
    if (this.edit) this.popup(w);
    return w.buffered() + `\x1b[0m\x1b]22;${pointer}\x1b\\\x1b[?2026l`;
  }
}
