//! The New workspace dialog: a name, and the folder it starts in, picked
//! from the folders under a field. The field is the truth: moving through
//! the list writes the folder into it. The name follows the folder until
//! edited, and ↵ is held to create.
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import * as palette from "./palette";
import { Style, fgRgb, bgRgb, mix, colors } from "./palette";
import * as keys from "./keys";
import * as nameDialog from "./name_dialog";
import { printable, type Key, type KeySpec, type Result } from "./name_dialog";
import * as scrollThumb from "./scroll_thumb";
import { relativeTime } from "./sidebar";
import { KeyHold, Spring } from "./key_hold";
import { milliTimestamp } from "./clock";
import { Writer, writeEllipsis } from "./text";

/** How long ↵ is held to create; letting go undoes it faster. A release
 * shows sooner than the shared default: a gap past the measured repeat
 * delay or after a repeat. */
export const create_hold_ms = 3000;
const create_heal_ms = 220;
const create_gap_ms = 150;
const create_first_gap_ms = 80;
/** The border keeps up with a held key, stiff and without overshoot; let go,
 * it snaps back like a rubber band, past the start once. */
const ring_held = { omega: 120, zeta: 1 };
const ring_snap = { omega: 18, zeta: 0.6 };
/** The border fills fast, half of it a third of the way in, then slows to
 * close, still moving to the end: a cubic ease-out with a share of linear. */
const ease_linear = 0.5;
/** An end part way into its cell: dashes that close up as it fills. */
const dashes: Record<string, string[]> = { "─": ["┈", "┄", "╌"], "│": ["┊", "┆", "╎"] };
export function eased(progress: number): number {
  return ease_linear * progress + (1 - ease_linear) * (1 - (1 - progress) ** 3);
}
/** The ↵ key stays lit this long after the hold ends, the last part fading. */
const lit_ms = 200;
const lit_fade_ms = 80;
/** The most folders the list shows at once. */
const folder_rows = 10;
/** A press on the folder field, a folder in the list, or out and in. */
export type Hit =
  nameDialog.Hit | { tag: "folder"; field: number } | { tag: "entry"; index: number } | { tag: "open" } | { tag: "up" };

/** Names in a folder that are folders themselves, or null when it can't be read. */
export type Lister = (folder: string) => string[] | null;
/** What a path holds, a link counting as what it leads to; a link to nothing is a link. */
export type Kind = "folder" | "file" | "link" | "socket" | "pipe" | "device";
export interface Found {
  kind: Kind;
  size: number;
  /** When it was last modified, in milliseconds since the epoch. */
  modified: number;
}
/** What is at a path, or null when nothing is. */
export type Stat = (path: string) => Found | null;

export function subfolders(folder: string): string[] | null {
  let entries;
  try {
    entries = readdirSync(folder, { withFileTypes: true });
  } catch {
    return null;
  }
  const names: string[] = [];
  for (const e of entries) {
    if (e.isDirectory()) names.push(e.name);
    else if (e.isSymbolicLink())
      try {
        if (statSync(join(folder, e.name)).isDirectory()) names.push(e.name);
      } catch {}
  }
  return names.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

export function stat(path: string): Found | null {
  let s: Stats;
  try {
    s = statSync(path);
  } catch {
    try {
      s = lstatSync(path);
    } catch {
      return null;
    }
  }
  return { kind: kind(s), size: s.size, modified: s.mtimeMs };
}
function kind(s: Stats): Kind {
  if (s.isDirectory()) return "folder";
  if (s.isFile()) return "file";
  if (s.isSymbolicLink()) return "link";
  if (s.isSocket()) return "socket";
  if (s.isFIFO()) return "pipe";
  return "device";
}

export function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Why the workspace wasn't created: a file has the folder's name, or
 * making the folder failed. */
export type Problem = "not_folder" | "not_created";

/** Makes `path` and the folders above it; false when it can't. */
export function make(path: string): boolean {
  try {
    mkdirSync(path, { recursive: true });
    return isFolder(path);
  } catch {
    return false;
  }
}

/** `path` with the home folder as `~`. */
export function label(path: string, home: string): string {
  if (home.length > 1 && (path === home || path.startsWith(home + "/"))) return "~" + path.slice(home.length);
  return path;
}

export class Browser {
  field: nameDialog.Dialog;
  focused = false;
  problem: Problem | null = null;
  /** The folder the list shows, and the field's text up to it. */
  parent = "";
  typed_parent = "";
  /** The field's text before moving into the list. */
  typed = "";
  /** What follows the last slash, which the listed names start with. */
  prefix = "";
  entries: string[] = [];
  readable = true;
  /** The folders the field names that aren't there yet, from the deepest
   * that is, offered after the entries. */
  create: string | null = null;
  /** Something other than a folder where the field names one, or a folder above it. */
  blocked: { name: string; found: Found } | null = null;
  /** The highlighted entry, or the offer to create after them; null while
   * the field holds what was typed. */
  highlight: number | null = null;
  /** The first entry that shows. */
  first = 0;
  private listed: { folder: string; names: string[] | null } | null = null;

  constructor(
    readonly base: string,
    readonly home: string,
    readonly list: Lister,
    readonly stat: Stat,
  ) {
    this.field = nameDialog.Dialog.init({ folder: null }, "");
  }
  /** Starts at `cwd`, listing the folders in it. */
  static init(cwd: string, home = homedir(), list: Lister = subfolders, at: Stat = stat): Browser {
    const b = new Browser(cwd, home, list, at);
    b.show(cwd);
    return b;
  }
  /** The real path of the folder to create the workspace in, made with the
   * folders above it when it isn't there yet; null after noting why not. */
  confirm(): string | null {
    const folder = this.folder();
    if (isFolder(folder)) return realpathSync(folder);
    if (existsSync(folder)) this.problem = "not_folder";
    else if (make(folder)) return realpathSync(folder);
    else this.problem = "not_created";
    return null;
  }
  /** The rows the list has: the entries, and the offer to create. */
  count(): number {
    return this.entries.length + (this.create === null ? 0 : 1);
  }
  /** The folder the field names, absolute. */
  folder(): string {
    const text = this.field.name();
    return this.resolve(text.length > 0 ? text : ".");
  }
  private resolve(text: string): string {
    const expanded = text === "~" ? this.home : text.startsWith("~/") ? join(this.home, text.slice(2)) : text;
    return isAbsolute(expanded) ? resolve(expanded) : resolve(this.base, expanded);
  }
  /** Lists `folder`, writing it into the field. */
  private show(folder: string): void {
    this.write(folder === "/" ? "/" : label(folder, this.home) + "/");
  }
  /** Lists `folder` and picks the first folder in it. */
  private enter(folder: string): void {
    this.show(folder);
    if (this.entries.length > 0) this.pick(0);
  }
  private write(text: string): void {
    this.field = nameDialog.Dialog.init({ folder: null }, text);
    this.field.selected = false;
    this.refresh();
  }
  /** Lists the folder the field's text ends in, keeping the names that
   * start with what follows its last slash. Dot folders show once a dot is typed. */
  refresh(): void {
    const text = this.field.raw();
    const cut = text.lastIndexOf("/");
    this.typed = text;
    this.typed_parent = text.slice(0, cut + 1);
    this.parent = this.resolve(cut < 0 ? "." : this.typed_parent);
    const prefix = (this.prefix = text.slice(cut + 1));
    if (this.listed === null || this.listed.folder !== this.parent)
      this.listed = { folder: this.parent, names: this.list(this.parent) };
    const names = this.listed.names;
    this.readable = names !== null;
    const lower = prefix.toLowerCase();
    const matched = (names ?? []).filter(
      n => (prefix.startsWith(".") || !n.startsWith(".")) && n.toLowerCase().startsWith(lower),
    );
    this.entries = matched;
    this.look();
    this.highlight = null;
    this.first = 0;
  }
  /** Finds the deepest part of what the field names that is there: past it,
   * folders to offer to create; something else is in the way. */
  private look(): void {
    this.create = null;
    this.blocked = null;
    if (this.typed.length === 0) return;
    const folder = this.folder();
    let path = folder;
    let found = this.stat(path);
    while (found === null && path !== dirname(path)) found = this.stat((path = dirname(path)));
    if (found === null) return;
    if (found.kind !== "folder") this.blocked = { name: basename(path), found };
    else if (path !== folder) this.create = relative(path, folder);
  }
  /** Highlights an entry and writes its folder into the field; past the
   * first entry, back to what was typed. */
  move(delta: number): void {
    const count = this.count();
    if (count === 0) return;
    const next = this.highlight === null ? (delta > 0 ? 0 : count - 1) : Math.min(this.highlight + delta, count - 1);
    this.pick(next < 0 ? null : next);
  }
  /** The offer to create leaves the field as typed. */
  pick(index: number | null): void {
    this.highlight = index;
    const text = index === null || index >= this.entries.length ? this.typed : this.typed_parent + this.entries[index];
    const field = nameDialog.Dialog.init({ folder: null }, text);
    field.selected = false;
    this.field = field;
  }
  /** Lists the highlighted folder, or without a highlight the first that
   * starts with what was typed. The offer to create makes the folders and
   * lists the last of them. */
  open(): void {
    const index = this.highlight ?? (this.prefix.length > 0 && this.entries.length > 0 ? 0 : null);
    if (index === null) return;
    if (index < this.entries.length) return this.enter(join(this.parent, this.entries[index]));
    const folder = this.folder();
    if (make(folder)) this.enter(folder);
    else this.problem = "not_created";
  }
  /** Lists the folder above the one listed. */
  up(): void {
    if (this.parent !== "/") this.enter(dirname(this.parent));
  }
  /** The first entry that shows in `rows`, keeping the highlight in view. */
  window(rows: number): number {
    const last = Math.max(0, this.count() - rows);
    if (this.highlight !== null) this.first = Math.max(Math.min(this.first, this.highlight), this.highlight - rows + 1);
    this.first = Math.max(0, Math.min(this.first, last));
    return this.first;
  }
  /** A press in the dialog: on the folder field, at column `field` of
   * text shown from byte `offset`; on an entry, highlighting it, or opening
   * it when it already was. */
  click(hit: Hit, offset: number): void {
    if (hit.tag !== "none") this.problem = null;
    switch (hit.tag) {
      case "folder":
        this.focused = true;
        if (this.highlight !== null) this.refresh();
        this.field.position(this.field.byteAtColumn(offset, hit.field - offset));
        break;
      case "entry":
        this.focused = true;
        if (this.highlight === hit.index) this.open();
        else this.pick(hit.index);
        break;
      case "open":
        this.focused = true;
        this.open();
        break;
      case "up":
        this.focused = true;
        this.up();
        break;
      default:
        break;
    }
  }
  key(byte: number): void {
    this.problem = null;
    const before = this.field.raw();
    this.field.key(byte);
    if (this.field.raw() !== before) this.refresh();
  }
  paste(byte: number): void {
    this.problem = null;
    const before = this.field.raw();
    this.field.pasteByte(byte);
    if (this.field.raw() !== before) this.refresh();
  }
  sequence(seq: string): void {
    this.problem = null;
    switch (keys.parse(seq)) {
      case "up":
        return this.move(-1);
      case "down":
        return this.move(1);
      case "page_up":
        return this.move(-8);
      case "page_down":
        return this.move(8);
      // At the end of the field, or in the list, they browse; elsewhere they move the cursor.
      case "right":
        if (this.highlight !== null || this.field.cursor === this.field.len) return this.open();
        break;
      case "left":
        if (this.highlight !== null || (this.field.cursor === this.field.len && this.prefix.length === 0))
          return this.up();
        break;
      default:
        break;
    }
    const before = this.field.raw();
    this.field.sequence(seq);
    if (this.field.raw() !== before) this.refresh();
  }
}

/** The dialog: the name above, the browser below. Tab, and Up and Down past
 * either end, move the keys between them. */
export class Dialog extends nameDialog.Dialog {
  browser: Browser;
  /** The name is the browser's folder's, following it until edited. */
  follows_folder = true;
  /** Creating takes a hold of ↵, or of its button. */
  create = new KeyHold(create_hold_ms, create_heal_ms, create_gap_ms, create_first_gap_ms);
  /** The hold as the border draws it, and how lit the ↵ key is, 0 to 1. */
  ring = new Spring(ring_snap);
  lit = 0;
  /** The hold is drawn moving, so frames come at the display's rate. */
  moving = false;
  private lit_until = 0;

  /** Opens on the name, which follows the browser's folder. */
  constructor(browser: Browser) {
    super({ workspace_name: null });
    this.browser = browser;
    browser.focused = false;
    this.follow();
  }
  /** The real path of the folder to create the workspace in; see `Browser.confirm`. */
  confirm(): string | null {
    return this.browser.confirm();
  }
  /** Keys stay on the name while the screen is too small to draw the folder field. */
  fit(width: number, height: number): void {
    if (!this.view(width, height)) this.browser.focused = false;
  }
  view(width: number, height: number): View | null {
    return View.layout(width, height, this);
  }
  /** Names the workspace for the browser's folder, until the name is edited.
   * The name stays selected only until the keys first leave it. */
  follow(): void {
    if (this.browser.focused) this.selected = false;
    if (this.follows_folder) this.fill(basename(this.browser.folder()));
  }
  clear(): void {
    this.follows_folder = false;
    super.clear();
  }
  key(byte: number, now = milliTimestamp()): Result {
    const b = this.browser;
    if (byte === 9) {
      b.focused = !b.focused;
      this.follow();
      return "none";
    }
    if (byte === 13) {
      const done = this.create.press(now);
      this.pressed(now);
      if (!done) return "none";
      this.create.reset();
      return "save";
    }
    if (b.focused && byte !== 27) {
      b.key(byte);
      this.follow();
      return "none";
    }
    const before = this.raw();
    const result = super.key(byte);
    if (this.raw() !== before) this.follows_folder = false;
    return result;
  }
  pasteByte(byte: number): void {
    if (this.browser.focused) {
      this.browser.paste(byte);
      return this.follow();
    }
    const before = this.len;
    super.pasteByte(byte);
    if (this.len !== before) this.follows_folder = false;
  }
  sequence(seq: string): void {
    const b = this.browser;
    const key = keys.parse(seq);
    if (key === "shift_tab") {
      b.focused = !b.focused;
      this.follow();
    } else if ((key === "up" || key === "down") && this.round(key === "down")) this.follow();
    else if (b.focused) {
      b.sequence(seq);
      this.follow();
    } else {
      const before = this.len;
      super.sequence(seq);
      if (this.len !== before) this.follows_folder = false;
    }
  }
  /** Up and Down go round the name, the folder field and its folders, the
   * name past either end of the list. False when they move within the folder. */
  private round(down: boolean): boolean {
    const b = this.browser;
    if (!b.focused) {
      b.focused = true;
      if (!down && b.count() > 0) b.pick(b.count() - 1);
      return true;
    }
    if (down ? (b.highlight ?? -1) !== b.count() - 1 : b.highlight !== null) return false;
    b.pick(null);
    b.focused = false;
    return true;
  }
  /** The create key is held with the mouse, `tick` noticing it fill; the
   * name field takes the keys back, and the folder's rows browse. */
  press(v: nameDialog.View, x: number, y: number, now: number): Result {
    const found: Hit = v instanceof View ? v.at(x, y) : v.hit(x, y);
    switch (found.tag) {
      case "save":
        this.create.down(now);
        this.pressed(now);
        return "none";
      case "field":
        this.browser.focused = false;
        break;
      case "folder":
      case "entry":
      case "open":
      case "up":
        this.browser.click(found, v instanceof View ? v.folders.offset : 0);
        this.follow();
        return "none";
      default:
        break;
    }
    return super.press(v, x, y, now);
  }
  release(now: number): void {
    this.create.release(now);
  }
  /** The hold moved on, and the create key held down with the mouse until it filled. */
  tick(now: number): Result {
    this.animate(now);
    if (!this.create.done()) return "none";
    this.create.reset();
    return "save";
  }
  frame(): number | null {
    return this.moving ? 8 : null;
  }
  /** A press of ↵ or its button lights the key. */
  private pressed(now: number): void {
    this.lit_until = Math.max(this.lit_until, now + lit_ms);
    this.moving = true;
  }
  /** Moves the create hold on to `now`: the border's spring, and the ↵ key,
   * lit while it's held and a moment after. False once both are at rest. */
  animate(now: number): boolean {
    const c = this.create;
    c.advance(now);
    const held = c.held(now);
    if (held) this.lit_until = Math.max(this.lit_until, now + lit_ms);
    this.lit = Math.max(0, Math.min(1, (this.lit_until - now) / lit_fade_ms));
    const springing = held ? this.ring.step(eased(c.progress), now, ring_held) : this.ring.step(0, now);
    return (this.moving = c.active || springing || this.lit > 0);
  }
}

/** The card's rows below the name: the folder field and the folders in it,
 * from entry `first`. */
interface Folders {
  name_label_y: number;
  label_y: number;
  field_y: number;
  offset: number;
  list_y: number;
  rows: number;
  first: number;
  entries: number;
}
const browser_keys = [
  { key: "↵", label: "hold to create", hit: { tag: "save" } },
  { key: "←→", label: "out / in", hit: { tag: "key", index: 1 }, split: true },
  { key: "esc", label: "cancel", hit: { tag: "cancel" } },
] satisfies KeySpec[];
/** Wide enough for the labelled keys two columns apart, and a column either side. */
const browser_width = browser_keys.reduce((n, k) => n + nameDialog.labelled(k), 0) + 2 * (browser_keys.length - 1) + 4;
/** Out and in before the folder has the keys: caps barely raised off the
 * panel, and the arrows and label in the border's color. */
let quiet_cap: string, quiet_label: string;
/** The border as a hold lights it: the accent, brightened toward `strong`. */
export let ring_lit: string;
let ring_rgb: palette.Rgb;
palette.derived(() => {
  ring_rgb = mix(colors.accent, colors.strong, 25);
  ring_lit = new Style({ bg: "surface", bold: true }).sgr() + fgRgb(ring_rgb);
  quiet_cap = "\x1b[0m" + fgRgb(colors.line) + bgRgb(mix(colors.surface, colors.selected, 50));
  quiet_label = "\x1b[0m" + fgRgb(colors.line) + bgRgb(colors.surface);
});
/** The ↵ key while a hold lights it: the cap on `accent` and the label in it,
 * fading back to the usual cap and label as `lit` falls from 1. */
function litKey(lit: number): { cap: string; label: string } {
  const p = Math.round(lit * 100);
  return {
    cap:
      new Style({ bold: true }).sgr() +
      fgRgb(mix(colors.strong, colors.surface, p)) +
      bgRgb(mix(colors.line, colors.accent, p)),
    label: new Style({ bg: "surface", bold: true }).sgr() + fgRgb(mix(colors.strong, colors.accent, p)),
  };
}
/** Why the workspace wasn't created, over the name. */
function problemMessage(p: Problem): string {
  switch (p) {
    case "not_folder":
      return "That's a file, not a folder.";
    case "not_created":
      return "Could not create that folder.";
  }
}
/** What stands where a folder was named, as "a socket". */
function kindLabel(k: Kind): string {
  switch (k) {
    case "folder":
      return "a folder";
    case "file":
      return "a file";
    case "link":
      return "a broken link";
    case "socket":
      return "a socket";
    case "pipe":
      return "a named pipe";
    case "device":
      return "a device";
  }
}
/** A size in bytes, as "0 B", "980 B", "1.2 KB" or "34 MB". */
export function size(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024;
    unit++;
  }
  return `${unit === 0 || n >= 10 ? Math.round(n) : n.toFixed(1)} ${units[unit]}`;
}

/** The card: the name, then the folder field over the folders in it, in a box. */
export class View extends nameDialog.View {
  folders!: Folders;
  dialog!: Dialog;

  /** Without room for three folders, the plain dialog is used instead. */
  static layout(width: number, height: number, d: Dialog): View | null {
    const rows = Math.min(folder_rows, height - 15);
    const w = Math.max(nameDialog.View.plainWidth(width), Math.min(width - 4, browser_width));
    if (rows < 3 || w < 20) return null;
    const h = rows + 13;
    const x = Math.floor((width - w) / 2);
    const y = Math.floor((height - h) / 2);
    const b = d.browser;
    const v = new View();
    Object.assign(v, {
      x,
      y,
      width: w,
      height: h,
      title_y: y + 1,
      field_y: y + 4,
      buttons_y: y + h - 2,
      offset: nameDialog.View.scroll(d, w - 6),
      text_x: x + 3,
      text_width: w - 6,
      padded: true,
      dialog: d,
      folders: {
        name_label_y: y + 3,
        // A row apart from the name.
        label_y: y + 6,
        field_y: y + 7,
        offset: nameDialog.View.scroll(b.field, w - 6),
        // Inside a box, its top on the row above.
        list_y: y + 9,
        rows,
        first: b.window(rows),
        entries: b.count(),
      },
    });
    return v;
  }
  protected keys(): KeySpec[] {
    return browser_keys;
  }
  /** What a press lands on, the folder field and list included. */
  at(x: number, y: number): Hit {
    const v = this;
    const f = v.folders;
    // The field's fill beside the text answers too.
    const across = x + 1 >= v.text_x && x < v.text_x + v.text_width + 1;
    const column = Math.min(Math.max(0, x - v.text_x), v.text_width);
    if (across && y === f.field_y) return { tag: "folder", field: f.offset + column };
    const index = f.first + y - f.list_y;
    if (across && y >= f.list_y && y < f.list_y + f.rows && index < f.entries) return { tag: "entry", index };
    const found = v.hit(x, y);
    if (found.tag !== "key") return found;
    // The arrows' ← goes up; → and the label open.
    const b = v.buttons()[found.index];
    return x < b.x + (b.cap ? 4 : 1) ? { tag: "up" } : { tag: "open" };
  }
  draw(d: nameDialog.Dialog, w: Writer, number: number): void {
    const v = this;
    const b = v.dialog.browser;
    v.drawBox(w);
    // Swinging back past the start, the arc bounces off it.
    if (v.dialog.ring.x !== 0) v.drawHold(Math.min(1, Math.abs(v.dialog.ring.x)), w);
    const { left, room } = v.heading(d, w, number);
    if (b.problem) {
      w.write(`\x1b[${v.title_y + 2};${left + 1}H` + new Style({ fg: "hot", bg: "surface" }).sgr());
      writeEllipsis(w, problemMessage(b.problem), room);
    }
    v.drawFolders(w, left);
    v.drawButtons(w);
    if (b.focused) v.placeCursor(b.field, w, v.folders.offset, v.folders.field_y);
    else v.placeCursor(d, w);
  }
  /** A hold lights ↵; out and in stay quiet until the folder has the keys. */
  protected look(k: Key, i: number): { cap: string; label: string; bare: string } {
    if (i === 0 && this.dialog.lit > 0) {
      const lit = litKey(this.dialog.lit);
      return { cap: lit.cap, label: lit.label, bare: lit.label };
    }
    if (k.hit.tag === "key" && !this.dialog.browser.focused)
      return { cap: quiet_cap, label: quiet_label, bare: quiet_label };
    return super.look(k, i);
  }
  /** A hold of ↵ lights the border from the middle of its bottom, both ways
   * round, closing at the top as the workspace is created. */
  private drawHold(progress: number, w: Writer): void {
    const v = this;
    const right = v.x + v.width - 1;
    const bottom = v.y + v.height - 1;
    // The border clockwise from the top left corner.
    const cells: [number, number, string][] = [];
    for (let x = v.x; x <= right; x++) cells.push([x, v.y, x === v.x ? "╭" : x === right ? "╮" : "─"]);
    for (let y = v.y + 1; y < bottom; y++) cells.push([right, y, "│"]);
    for (let x = right; x >= v.x; x--) cells.push([x, bottom, x === right ? "╯" : x === v.x ? "╰" : "─"]);
    for (let y = bottom - 1; y > v.y; y--) cells.push([v.x, y, "│"]);
    const n = cells.length;
    const start = v.width + v.height - 2 + right - (v.x + Math.floor(v.width / 2));
    // The arc's length in cells. A sliver lights none, so the spring's last
    // small swing doesn't blink.
    const length = progress * n;
    if (length < 3) return;
    // Its ends light partly, in dashes brightening as they fill, so it moves
    // between cells.
    const ends: string[] = [];
    w.write(ring_lit);
    for (let j = 0; j < n; j++) {
      const along = (((j - start) % n) + n) % n;
      const lit = progress >= 1 ? 1 : Math.min(1, (length + 1) / 2 - Math.min(along, n - along));
      if (lit <= 0) continue;
      const [x, y, ch] = cells[j];
      const at = `\x1b[${y + 1};${x + 1}H`;
      if (lit >= 1) w.write(at + ch);
      else
        ends.push(
          at +
            new Style({ bg: "surface", bold: true }).sgr() +
            fgRgb(mix(colors.line, ring_rgb, Math.round(35 + 65 * lit))) +
            (lit < 0.75 && dashes[ch] ? dashes[ch][Math.floor(lit * 4)] : ch),
        );
    }
    for (const end of ends) w.write(end);
  }
  /** The labels over the two fields, the folder field, and the folders in
   * it, then any offer to create: the highlighted one on `selected` behind
   * the focus bar. */
  private drawFolders(w: Writer, left: number): void {
    const v = this;
    const f = v.folders;
    const b = v.dialog.browser;
    const label = new Style({ fg: "faint", bg: "surface" }).sgr();
    w.write(`\x1b[${f.name_label_y + 1};${left + 1}H${label}Name`);
    w.write(`\x1b[${f.label_y + 1};${left + 1}H${label}Folder`);
    const field = b.field;
    w.write(`\x1b[${f.field_y + 1};${left + 1}H` + new Style({ fg: "text", bg: "selected" }).sgr());
    w.splat(" ", v.text_width + 2);
    const end = field.byteAtColumn(f.offset, v.text_width);
    w.write(`\x1b[${f.field_y + 1};${v.text_x + 1}H` + printable(field.bytes(f.offset, end)));
    // The list's box is as wide as the field.
    const right = left + v.text_width + 1;
    const edge = new Style({ fg: "line", bg: "surface" }).sgr();
    w.write(`\x1b[${f.list_y};${left + 1}H${edge}╭${"─".repeat(right - left - 1)}╮`);
    for (let row = 0; row < f.rows; row++)
      w.write(`\x1b[${f.list_y + row + 1};${left + 1}H${edge}│\x1b[${f.list_y + row + 1};${right + 1}H│`);
    w.write(`\x1b[${f.list_y + f.rows + 1};${left + 1}H${edge}╰${"─".repeat(right - left - 1)}╯`);
    // Text starts a column in from the focus bar, and stops short of the scroll thumb.
    const text_x = left + 4;
    const text_width = v.text_width - 3;
    for (let row = 0; row < f.rows; row++) {
      const index = f.first + row;
      if (index >= b.count()) break;
      const highlighted = index === b.highlight;
      w.write(`\x1b[${f.list_y + row + 1};${left + 2}H`);
      if (highlighted) {
        w.write(new Style({ fg: "accent", bg: "selected" }).sgr() + "▌");
        w.write(new Style({ fg: "strong", bg: "selected", bold: true }).sgr());
        w.splat(" ", v.text_width - 1);
      } else w.write(new Style({ fg: "text", bg: "surface" }).sgr());
      w.write(`\x1b[${f.list_y + row + 1};${text_x}H`);
      if (index < b.entries.length) {
        writeEllipsis(w, printable(b.entries[index]), text_width);
        continue;
      }
      const bg = highlighted ? "selected" : "surface";
      w.write(new Style({ fg: "accent", bg, bold: true }).sgr() + "+ ");
      w.write(new Style({ fg: highlighted ? "strong" : "muted", bg }).sgr() + "Create ");
      w.write(new Style({ fg: highlighted ? "strong" : "text", bg, bold: highlighted }).sgr());
      writeEllipsis(w, printable(b.create ?? ""), text_width - 9);
    }
    // Under the list, what stands where the field names a folder.
    const blocked = b.blocked;
    const below = f.list_y + b.count() - f.first + 1;
    if (blocked && below < f.list_y + f.rows) {
      const { kind, size: bytes, modified } = blocked.found;
      w.write(`\x1b[${below};${text_x}H` + new Style({ fg: "warm", bg: "surface" }).sgr());
      writeEllipsis(w, printable(`${blocked.name} is ${kindLabel(kind)}, not a folder`), text_width);
      const age = relativeTime(Math.floor(modified / 1000), Math.floor(Date.now() / 1000));
      w.write(`\x1b[${below + 1};${text_x}H` + new Style({ fg: "faint", bg: "surface" }).sgr());
      writeEllipsis(w, `${size(bytes)} · modified ${age}`, text_width);
    } else if (b.count() === 0) {
      w.write(`\x1b[${f.list_y + 1};${text_x}H` + new Style({ fg: "faint", bg: "surface" }).sgr());
      writeEllipsis(
        w,
        !b.readable ? "Can't read this folder" : b.typed.endsWith("/") ? "No folders" : "No folders match",
        text_width,
      );
    }
    const bar = scrollThumb.thumb(f.rows, b.count(), f.first);
    // Inside the box's right edge.
    if (bar)
      for (let k = bar.start; k < bar.start + bar.len; k++) {
        const bg = f.first + k === b.highlight ? "selected" : "surface";
        w.write(`\x1b[${f.list_y + k + 1};${right}H` + new Style({ fg: "line", bg }).sgr() + "┃");
      }
  }
}
