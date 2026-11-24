//! The New workspace dialog: a name, and the folder it starts in, picked
//! from the folders under a field. The field is the truth: moving through
//! the list writes the folder into it. The name follows the folder until
//! edited, and ↵ creates it. With other machines, the title names the one
//! it goes on, and ^O, ↑ from the name or a click on that name lists the others.
import * as i18n from "./i18n";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import * as palette from "./palette";
import { Style, fgRgb, bgRgb, mix, colors, keycap } from "./palette";
import * as keys from "./keys";
import * as errors from "./errors";
import * as folders from "./folders";
import * as dropdown from "./dropdown";
import { Rect } from "./layout";
import { call } from "./mirror";
import type { Machine } from "./machine";
import * as nameDialog from "./name_dialog";
import * as workspace from "./workspace";
import { printable, writeField, type Key, type KeySpec, type Result } from "./name_dialog";
import * as scrollThumb from "./scroll_thumb";
import { relativeTime } from "./sidebar";
import { Writer, writeEllipsis, displayWidth, ellipsis } from "./text";

/** The most folders the list shows at once. */
const folder_rows = 10;
/** A press on the folder field, a folder in the list, or out and in; on the
 * title's machine, or a machine in its list. */
export type Hit =
  | nameDialog.Hit
  | { tag: "folder"; field: number }
  | { tag: "entry"; index: number }
  | { tag: "open" }
  | { tag: "up" }
  | { tag: "machine" }
  | { tag: "machine_row"; index: number };

/** Where a dialog's folders are read: this computer, or a remote machine
 * through its daemon. */
export interface Place {
  /** The home folder, "" until known. */
  home: string;
  /** A `folders.answer` from there. */
  ask(op: folders.Op, path: string): Promise<unknown>;
  /** Whether a read that failed may work when asked again, as after a lost link. */
  lost(error: unknown): boolean;
}
/** This computer's folders, read in this process. */
export function here(home = homedir()): Place {
  return { home, ask: (op, path) => folders.answer({ op, payload: { path } }), lost: () => false };
}
/** A remote machine's folders, read by its daemon; its home is kept on the
 * machine for the next dialog. A daemon that refuses, an older one included,
 * has nothing to show. */
export function remote(machine: Machine): Place {
  return {
    get home() {
      return machine.home;
    },
    set home(home: string) {
      machine.home = home;
    },
    ask: (op, path) => call(machine.connection, op, { path }),
    lost: error => !errors.reply(error),
  };
}
/** `machine`'s folders: this computer's, or a remote machine's. */
export function place(machine: Machine): Place {
  return machine.remote ? remote(machine) : here();
}

/** A place's folders as the browser reads them, kept until the dialog makes
 * a folder. Until a remote home is known, paths under it start with `~`,
 * which the daemon expands. */
export class Reader {
  /** Told when an answer comes after it was asked for. */
  answered: () => void = () => {};
  private lists = new Map<string, string[] | null>();
  private found = new Map<string, folders.Deepest | null>();
  /** Questions out, as "op path". */
  private asking = new Set<string>();
  /** Counts the folders made: an answer read before one is dropped. */
  private made = 0;
  constructor(private readonly place: Place = here()) {}
  get home(): string {
    return this.place.home;
  }
  /** The folders in `folder`, null when it can't be read; undefined until the place answers. */
  list(folder: string): string[] | null | undefined {
    // A folder read before the home was known is kept under `~`.
    for (const key of [folder, label(folder, this.home)]) if (this.lists.has(key)) return this.lists.get(key);
    this.ask(this.lists, "folder.list", folder, reply => {
      if (typeof reply.home === "string" && isAbsolute(reply.home)) this.place.home = reply.home;
      return names(reply.folders);
    });
    return undefined;
  }
  /** The deepest part of `path` that is there; undefined until the place answers. */
  deepest(path: string): folders.Deepest | null | undefined {
    if (this.found.has(path)) return this.found.get(path);
    this.ask(this.found, "folder.find", path, reply => deepestPart(reply.deepest));
    return undefined;
  }
  /** The real path of folder `path`, made with the folders above it when it isn't there yet. */
  async open(path: string): Promise<folders.Opened> {
    let made: folders.Opened;
    try {
      made = opened(record(await this.place.ask("folder.open", path)).opened);
    } catch (error) {
      // XXX: Remove for next protocol bump. An older daemon has no folder
      // requests; the workspace takes the folder as named, when it's there.
      if (errors.is(error, "UnknownOperation")) return { path };
      return { problem: "not_created" };
    }
    if ("path" in made) this.forget();
    return made;
  }
  /** Drops the answers kept and those on their way, a folder having been
   * made, and has the browser ask again. */
  private forget(): void {
    this.made++;
    this.lists.clear();
    this.found.clear();
    this.asking.clear();
    this.answered();
  }
  /** Asks the place `op` about `key`, once at a time. A read that failed for
   * good has nothing to show; after a lost link the next look asks again. */
  private ask<T>(
    answers: Map<string, T | null>,
    op: folders.Op,
    key: string,
    take: (reply: Record<string, unknown>) => T | null,
  ): void {
    const question = `${op} ${key}`,
      made = this.made;
    if (this.asking.has(question)) return;
    this.asking.add(question);
    const keep = (answer: T | null) => {
      if (made !== this.made) return;
      this.asking.delete(question);
      answers.set(key, answer);
      this.answered();
    };
    void this.place.ask(op, key).then(
      reply => keep(take(record(reply))),
      error => {
        if (!this.place.lost(error)) keep(null);
        else if (made === this.made) this.asking.delete(question);
      },
    );
  }
}
/** A reply's fields. */
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
/** A reply's folder names, or null. */
function names(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter(n => typeof n === "string") : null;
}
/** A reply's deepest part of a path, or null. */
function deepestPart(value: unknown): folders.Deepest | null {
  if (!value || typeof value !== "object") return null;
  const { path, found } = value as Record<string, unknown>;
  if (typeof path !== "string" || !found || typeof found !== "object") return null;
  const { kind, size, modified } = found as Record<string, unknown>;
  const k = folders.kinds.find(k => k === kind);
  if (!k) return null;
  return { path, found: { kind: k, size: Number(size) || 0, modified: Number(modified) || 0 } };
}
/** A reply's opened folder, or why there is none. */
function opened(value: unknown): folders.Opened {
  const v = record(value);
  if (typeof v.path === "string") return { path: v.path };
  return { problem: folders.problems.find(p => p === v.problem) ?? "not_created" };
}

/** `path` with the home folder as `~`. */
export function label(path: string, home: string): string {
  if (home.length > 1 && (path === home || path.startsWith(home + "/"))) return "~" + path.slice(home.length);
  return path;
}
/** A path under a home folder not known yet, as `~` and the path below it. */
const homeless = (path: string) => path === "~" || path.startsWith("~/");
/** A folder field's text without the spaces around it, as its `name()` gives it. */
const unspaced = (text: string) => text.replace(/^ +| +$/g, "");

export class Browser {
  field: nameDialog.Dialog;
  focused = false;
  problem: folders.Problem | null = null;
  /** The folder the list shows, and the field's text up to it. */
  parent = "";
  typed_parent = "";
  /** The field's text before moving into the list, and the folder it names. */
  typed = "";
  private typed_folder = "";
  /** What follows the last slash, which the listed names start with. */
  prefix = "";
  entries: string[] = [];
  readable = true;
  /** The folder the list shows hasn't been read yet. */
  reading = false;
  /** The folders the field names that aren't there yet, from the deepest
   * that is, offered after the entries. */
  create: string | null = null;
  /** Something other than a folder where the field names one, or a folder above it. */
  blocked: { name: string; found: folders.Found } | null = null;
  /** The highlighted entry, or the offer to create after them; null while
   * the field holds what was typed. */
  highlight: number | null = null;
  /** The first entry that shows. */
  first = 0;
  private listed: { folder: string; names: string[] | null } | null = null;
  /** A folder was entered before it was read: its first folder is picked once it is. */
  private picks_first = false;
  /** → pressed meanwhile: each goes on into the first folder once it is read. */
  private opens = 0;
  /** Told when the machine's answers or a folder it made change what shows. */
  changed: () => void = () => {};

  constructor(
    readonly base: string,
    readonly files: Reader,
  ) {
    this.field = nameDialog.Dialog.init({ folder: null }, "");
    files.answered = () => {
      this.retry();
      this.changed();
    };
  }
  /** Starts at `cwd`, listing the folders in it. */
  static init(cwd: string, files = new Reader()): Browser {
    const b = new Browser(cwd, files);
    b.show(cwd);
    return b;
  }
  /** Looks again: the machine keeps what it answered, and what it has
   * dropped, as after a lost link, is asked again. */
  retry(): void {
    this.listed = null;
    this.reread();
  }
  get home(): string {
    return this.files.home;
  }
  /** The real path of the folder to create the workspace in, made with the
   * folders above it when it isn't there yet; null after noting why not. */
  async confirm(): Promise<string | null> {
    const opened = await this.files.open(this.folder());
    if ("path" in opened) return opened.path;
    this.problem = opened.problem;
    return null;
  }
  /** The rows the list has: the entries, and the offer to create. */
  count(): number {
    return this.entries.length + (this.create === null ? 0 : 1);
  }
  /** The folder the field names, absolute; under a home folder not known yet, from `~`. */
  folder(): string {
    return this.resolve(unspaced(this.field.raw()) || ".");
  }
  private resolve(text: string): string {
    if (homeless(text)) {
      if (this.home) return resolve(this.home, "." + text.slice(1));
      // `..` past the home stays for the daemon, which knows where that is.
      const below = normalize(text.slice(2) || ".").replace(/\/+$/, "");
      return below === "." ? "~" : "~/" + below;
    }
    if (isAbsolute(text)) return resolve(text);
    // A remote machine's dialog without a workspace starts at its home.
    const base = homeless(this.base) ? this.resolve(this.base) : this.base;
    return homeless(base) ? this.resolve(base + "/" + text) : resolve(base, text);
  }
  /** Lists `folder`, writing it into the field. */
  private show(folder: string): void {
    this.write(folder === "/" ? "/" : label(folder, this.home) + "/");
  }
  /** Lists `folder` and picks the first folder in it. */
  private enter(folder: string): void {
    this.show(folder);
    if (this.entries.length > 0) this.pick(0);
    this.picks_first = this.reading;
  }
  private write(text: string): void {
    this.field = nameDialog.Dialog.init({ folder: null }, text);
    this.field.selected = false;
    this.refresh();
  }
  /** Lists the folder the field's text ends in, keeping the names that
   * start with what follows its last slash. Dot folders show once a dot is typed. */
  refresh(): void {
    this.typed = this.field.raw();
    this.picks_first = false;
    this.opens = 0;
    this.locate();
    this.fill();
    this.highlight = null;
    this.first = 0;
  }
  /** The folders what was typed names, as far as the home folder is known. */
  private locate(): void {
    const text = this.typed,
      cut = text.lastIndexOf("/");
    this.typed_folder = this.resolve(unspaced(text) || ".");
    this.typed_parent = text.slice(0, cut + 1);
    this.parent = this.resolve(cut < 0 ? "." : this.typed_parent);
    this.prefix = text.slice(cut + 1);
  }
  /** Takes in answers that came since the field last changed, the home
   * folder among them. A highlighted offer to create stays highlighted,
   * after the folders read since. */
  private reread(): void {
    const offer = this.highlight !== null && this.highlight >= this.entries.length;
    this.locate();
    this.fill();
    if (offer) this.highlight = this.create === null ? null : this.entries.length;
    if (this.picks_first && !this.reading) this.pickFirst();
  }
  /** Picks the first folder in the one entered before it was read, and goes
   * on into it for each → pressed meanwhile. */
  private pickFirst(): void {
    let opens = this.opens;
    this.picks_first = false;
    this.opens = 0;
    if (this.highlight === null && this.entries.length > 0) this.pick(0);
    while (opens > 0 && this.highlight !== null && this.highlight < this.entries.length) {
      opens--;
      this.enter(join(this.parent, this.entries[this.highlight]));
      if (this.picks_first) {
        this.opens = opens;
        return;
      }
    }
  }
  /** The folders listed and the offer to create, from what the machine has answered. */
  private fill(): void {
    const prefix = this.prefix;
    const names = this.listed?.folder === this.parent ? this.listed.names : this.files.list(this.parent);
    if (names !== undefined) this.listed = { folder: this.parent, names };
    this.reading = names === undefined;
    this.readable = names !== null;
    const lower = prefix.toLowerCase();
    this.entries = (names ?? []).filter(
      n => (prefix.startsWith(".") || !n.startsWith(".")) && n.toLowerCase().startsWith(lower),
    );
    this.look();
    // Read ahead where → and ← go, so they show their folders at once.
    if (this.entries.length > 0) this.files.list(join(this.parent, this.entries[0]));
    if (isAbsolute(this.parent) && this.parent !== "/") this.files.list(dirname(this.parent));
  }
  /** Finds the deepest part of what was typed that is there: past it,
   * folders to offer to create; something else is in the way. */
  private look(): void {
    this.create = null;
    this.blocked = null;
    // What to create waits for the home folder.
    if (this.typed.length === 0 || homeless(this.typed_folder)) return;
    const folder = this.typed_folder,
      known = this.files.deepest(folder),
      there = known === undefined ? this.guess(folder) : known;
    if (!there) return;
    if (there.found.kind !== "folder") this.blocked = { name: basename(there.path), found: there.found };
    else if (there.path !== folder) this.create = relative(there.path, folder);
  }
  /** What stands at `folder` by the folders listed above it, until the
   * place answers: a folder of its name, or the listed folder is the deepest.
   * Typing a name keeps the offer to create steady meanwhile. */
  private guess(folder: string): folders.Deepest | null {
    const listed = this.listed;
    if (!listed?.names) return null;
    const there = (path: string) => ({ path, found: { kind: "folder" as const, size: 0, modified: 0 } });
    if (listed.folder === folder) return there(folder);
    if (listed.folder !== dirname(folder)) return null;
    return there(listed.names.includes(basename(folder)) ? folder : listed.folder);
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
    if (index !== null && index < this.entries.length) this.files.list(join(this.parent, this.entries[index]));
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
    if (index === null) {
      if (this.picks_first) this.opens++;
      return;
    }
    if (index < this.entries.length) return this.enter(join(this.parent, this.entries[index]));
    const folder = this.folder();
    void this.files.open(folder).then(opened => {
      if (this.folder() !== folder) return;
      if ("path" in opened) {
        // What was read before it was made is stale.
        this.listed = null;
        this.enter(folder);
      } else this.problem = opened.problem;
      this.changed();
    });
  }
  /** Lists the folder above the one listed. */
  up(): void {
    if (this.parent !== "/" && this.parent !== "~") this.enter(dirname(this.parent));
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

/** A workspace the dialog moves to another folder, and its name now. */
export interface Moving {
  workspace: number;
  name: string;
}

/** The machine the browser's folders are on, and the machines a new
 * workspace may go on instead. */
export interface On {
  machine: Machine;
  machines: Machine[];
  /** The folder another machine's field starts at, the first time it's chosen. */
  start: (machine: Machine) => string;
}

/** The dialog: the name above, the browser below. Tab, and Up and Down past
 * either end, move the keys between them. */
export class Dialog extends nameDialog.Dialog {
  browser!: Browser;
  /** The name is the browser's folder's, following it until edited. */
  follows_folder = true;
  /** The workspace this moves, or null when it creates one. */
  readonly moving: number | null;
  /** Moving, with no room for the list: only the folder field shows, and it keeps the keys. */
  compact = false;
  /** Told when the browser changes without a key: the machine answered, or made a folder. */
  changed: () => void = () => {};
  /** The machine the workspace goes on; null for this computer, not named. */
  machine: Machine | null;
  readonly machines: Machine[];
  /** The list of machines is open, and has the keys. */
  choosing = false;
  /** The machine highlighted in that list. */
  highlight = 0;
  /** The pointer is on the machine's name. */
  hovering = false;
  /** Where a chosen machine's folders are read. */
  places: (machine: Machine) => Place = place;
  /** Each machine's folder field, kept while the dialog is open. */
  private browsers = new Map<Machine, Browser>();
  private start: (machine: Machine) => string;
  /** The whole card shows, the machine's name in its title. */
  private roomy = false;
  /** The machine was online when last looked at. */
  private online: boolean;

  /** Opens on the name, which follows the browser's folder. Moving a
   * workspace opens on the folder, and its name follows only while it is
   * still its folder's. */
  constructor(browser: Browser, moving: Moving | null = null, on: On | null = null) {
    super({ workspace_name: moving?.workspace ?? null });
    this.use(browser);
    this.moving = moving?.workspace ?? null;
    this.machine = on?.machine ?? null;
    this.machines = on?.machines ?? [];
    this.start = on?.start ?? (() => "~");
    if (this.machine) this.browsers.set(this.machine, browser);
    this.online = this.ready();
    browser.focused = moving !== null;
    if (moving && moving.name !== workspace.folderName(browser.folder())) {
      this.follows_folder = false;
      this.fill(moving.name);
    }
    this.follow();
  }
  private use(browser: Browser): void {
    this.browser = browser;
    browser.changed = () => {
      this.follow();
      this.changed();
    };
  }
  /** The real path of the folder to create the workspace in; see `Browser.confirm`. */
  confirm(): Promise<string | null> {
    return this.browser.confirm();
  }
  /** A new workspace with machines to choose from. */
  offers(): boolean {
    return this.moving === null && this.machines.length > 1;
  }
  /** The machine is online: its folders show, and ↵ goes ahead. */
  ready(): boolean {
    return this.machine?.presence().online ?? true;
  }
  /** Lists the folders a machine couldn't before it came online. */
  catchUp(): void {
    const online = this.ready();
    if (online && !this.online) this.browser.retry();
    this.online = online;
  }
  /** Opens the list of machines on the one the workspace goes on, unless
   * it is already being created there. */
  openMachines(): void {
    if (this.saving) return;
    this.choosing = true;
    this.highlight = Math.max(0, this.machines.indexOf(this.machine!));
  }
  /** Moves through the open list; down past the last machine closes it, as
   * down past the last folder returns to the name. */
  private move(down: boolean): void {
    if (down && this.highlight === this.machines.length - 1) this.choosing = false;
    else this.highlight = Math.max(0, this.highlight + (down ? 1 : -1));
  }
  /** Puts the workspace on machine `index`, in the folder field it had
   * when last chosen, or at its start the first time. */
  choose(index: number): void {
    this.choosing = false;
    const machine = this.machines[index];
    if (!machine || machine === this.machine) return;
    const focused = this.browser.focused;
    this.browser.changed = () => {};
    this.machine = machine;
    this.online = this.ready();
    let browser = this.browsers.get(machine);
    if (!browser) {
      browser = Browser.init(this.start(machine), new Reader(this.places(machine)));
      this.browsers.set(machine, browser);
      // It may have come online while another was chosen.
    } else if (this.online) browser.retry();
    this.use(browser);
    browser.focused = focused;
    this.follow();
  }
  /** Keys stay on the name while the screen is too small to draw the folder
   * field, and on the folder while it is the only field drawn. */
  fit(width: number, height: number): void {
    const v = this.view(width, height);
    this.compact = v?.compact ?? false;
    this.roomy = v !== null && !v.compact;
    if (!this.roomy) this.choosing = false;
    if (!v) this.browser.focused = false;
    else if (this.compact) this.browser.focused = true;
  }
  view(width: number, height: number): View | null {
    return View.layout(width, height, this);
  }
  /** Names the workspace for the browser's folder, until the name is edited.
   * The name stays selected only until the keys first leave it. */
  follow(): void {
    if (this.browser.focused) this.selected = false;
    if (this.follows_folder) this.fill(workspace.folderName(this.browser.folder()));
  }
  clear(): void {
    this.follows_folder = false;
    super.clear();
  }
  key(byte: number): Result {
    const b = this.browser;
    if (this.choosing) {
      if (byte === 13) this.choose(this.highlight);
      else if (byte === 27 || byte === 15) this.choosing = false;
      return "none";
    }
    // ^O, which no field takes.
    if (byte === 15) {
      if (this.offers() && this.roomy) this.openMachines();
      return "none";
    }
    if (byte === 9) {
      if (!this.compact) b.focused = !b.focused;
      this.follow();
      return "none";
    }
    if (byte === 13) return this.ready() ? "save" : "none";
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
    if (this.choosing) return;
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
    if (this.choosing) {
      if (key === "up" || key === "down") this.move(key === "down");
      return;
    }
    if (key === "shift_tab") {
      if (!this.compact) b.focused = !b.focused;
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
   * name past either end of the list; with other machines, up from the name
   * opens theirs instead. False when they move within the folder. */
  private round(down: boolean): boolean {
    const b = this.browser;
    if (this.compact) return false;
    if (!b.focused && !down && this.offers() && this.roomy) {
      this.openMachines();
      return true;
    }
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
  /** The name field takes the keys back, and the folder's rows browse. The
   * machine's name always opens its list; while open, a machine chooses it,
   * and a press off the list and its keys closes it. */
  press(v: nameDialog.View, x: number, y: number, now: number): Result {
    const found: Hit = v instanceof View ? v.at(x, y) : v.hit(x, y);
    if (this.choosing) {
      switch (found.tag) {
        case "machine_row":
          this.choose(found.index);
          break;
        case "save":
          this.choose(this.highlight);
          break;
        // The ↑↓ key's halves.
        case "up":
        case "open":
          this.move(found.tag === "open");
          break;
        case "machine":
        case "key":
          break;
        default:
          this.choosing = false;
      }
      return "none";
    }
    switch (found.tag) {
      case "machine":
        this.openMachines();
        return "none";
      // Past the arrows, which are out and in, the only key is ^O's.
      case "key":
        this.openMachines();
        return "none";
      case "save":
        if (!this.ready()) return "none";
        break;
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
  /** The pointer on the machine's name lights it, and in the open list
   * highlights the machine under it. */
  hover(v: nameDialog.View, x: number, y: number): boolean {
    const found: Hit = v instanceof View ? v.at(x, y) : { tag: "none" };
    const hovering = found.tag === "machine",
      highlight = this.choosing && found.tag === "machine_row" ? found.index : this.highlight,
      changed = hovering !== this.hovering || highlight !== this.highlight;
    this.hovering = hovering;
    this.highlight = highlight;
    return changed;
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
/** The arrows' place among the keys. */
const arrows = 1;
const browserKeys = (d: Dialog): KeySpec[] => {
  const machine: KeySpec[] = d.offers() ? [{ key: "^O", label: i18n.t`machine`, hit: { tag: "key", index: 2 } }] : [];
  return [
    { key: "↵", label: d.moving !== null ? i18n.t`save` : i18n.t`create`, hit: { tag: "save" } },
    { key: "←→", label: i18n.t`out / in`, hit: { tag: "key", index: arrows }, split: true },
    ...machine,
    { key: "esc", label: i18n.t`cancel`, hit: { tag: "cancel" } },
  ];
};
/** The keys while the list of machines is open. */
const machineKeys = (): KeySpec[] => [
  { key: "↵", label: i18n.t`choose`, hit: { tag: "save" } },
  { key: "↑↓", label: i18n.t`machine`, hit: { tag: "key", index: arrows }, split: true },
  { key: "esc", label: i18n.t`close`, hit: { tag: "cancel" } },
];
/** Wide enough for the labelled keys two columns apart, and a column either side. */
const browserWidth = (d: Dialog) =>
  browserKeys(d).reduce((n, k) => n + nameDialog.labelled(k), 0) + 2 * (browserKeys(d).length - 1) + 4;
/** How a machine's link stands, as its header in the sidebar says. */
function linkRuns(machine: Machine): dropdown.Run[] {
  if (!machine.remote) return [[i18n.t`this machine`, "faint"]];
  const presence = machine.presence(),
    status = presence.connection_status;
  if (status) {
    const metrics = status.metrics ?? (status.seconds === null ? "" : `${status.seconds}s`);
    return [[[status.label, metrics].filter(Boolean).join(" "), status.color]];
  }
  if (!presence.online) return [[i18n.t`connecting`, "warm"]];
  const quality = presence.link_quality;
  if (quality === null) return [];
  const color = quality >= 3 ? "accent" : "warm";
  return [..."▂▄▆█"].map((bar, i): dropdown.Run => [bar, i < quality ? color : "line"]);
}
/** "on" around the machine's name in the title, as translated: what comes
 * before the name, and after it. The name's chip has room of its own around it. */
function titleOn(): [string, string] {
  const machine = "\0";
  const [before, ...after] = i18n.t`on ${machine}`.split("\0");
  return [before.trimEnd(), after.join("").trimStart()];
}
/** The machine's name in the title, padded a column either side and with
 * ▾; the title before it, clipped to `title` columns; and ^O's cap at
 * `key`, when it fits. */
interface Chip {
  x: number;
  y: number;
  width: number;
  title: number;
  key: number | null;
}
/** ^O's cap, right after the machine's name and its padding. */
const chip_key = " ^O ";
/** Out and in before the folder has the keys: caps barely raised off the
 * panel, and the arrows and label in the border's color. */
let quiet_cap: string, quiet_label: string;
palette.derived(() => {
  quiet_cap = "\x1b[0m" + fgRgb(colors.line) + bgRgb(mix(colors.surface, colors.selected, 50));
  quiet_label = "\x1b[0m" + fgRgb(colors.line) + bgRgb(colors.surface);
});
/** Why the workspace wasn't created, over the name. */
function problemMessage(p: folders.Problem): string {
  switch (p) {
    case "not_folder":
      return i18n.t`That's a file, not a folder.`;
    case "not_created":
      return i18n.t`Could not create that folder.`;
  }
}
/** What stands where a folder was named, as "a socket". */
function kindLabel(k: folders.Kind): string {
  switch (k) {
    case "folder":
      return i18n.t`a folder`;
    case "file":
      return i18n.t`a file`;
    case "link":
      return i18n.t`a broken link`;
    case "socket":
      return i18n.t`a socket`;
    case "pipe":
      return i18n.t`a named pipe`;
    case "device":
      return i18n.t`a device`;
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
  /** The folder field alone, in the plain dialog's place. */
  compact = false;
  /** The machine's name in the title, when there are others to choose. */
  chip: Chip | null = null;

  /** Without room for three folders, the plain dialog is used instead; moving
   * a workspace keeps its folder field, alone, in the plain dialog's place. */
  static layout(width: number, height: number, d: Dialog): View | null {
    const rows = Math.min(folder_rows, height - 15);
    const w = Math.max(nameDialog.View.plainWidth(width), Math.min(width - 4, browserWidth(d)));
    if (rows < 3 || w < 20) return d.moving !== null ? View.compactLayout(width, height, d) : null;
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
    if (d.offers()) v.chip = v.machineChip(d);
    return v;
  }
  /** After the title and "on", the machine's name, then ^O's cap. Short of
   * room, the cap goes first, then the title gives way to the name's first
   * columns. */
  private machineChip(d: Dialog): Chip {
    const left = this.text_x - 1,
      room = this.x + this.width - 2 - left,
      [before, after] = titleOn(),
      full = displayWidth(this.fullTitle()),
      name = displayWidth(printable(d.machine!.name)),
      // "on" and the name's padding and ▾.
      on = (before ? 1 + displayWidth(before) : 0) + 4 + displayWidth(after),
      key = displayWidth(chip_key);
    const title = Math.min(full, Math.max(0, room - on - Math.min(name, 8))),
      x = left + title + (before ? 1 + displayWidth(before) : 0),
      width = Math.max(1, Math.min(name, room - title - on)) + 4,
      fits = full + on + name + key <= room;
    return { x, y: this.title_y, width, title, key: fits ? x + width + displayWidth(after) : null };
  }
  /** The open list of machines, under the machine's name and inside the
   * card: its box, the first machine it shows, and the rows. */
  machineList(): { box: Rect; first: number; choices: dropdown.Choice[] } | null {
    const d = this.dialog,
      chip = this.chip;
    if (!d.choosing || !chip) return null;
    const choices = d.machines.map((machine, i): dropdown.Choice => {
      const runs = linkRuns(machine);
      return {
        text: printable(machine.name),
        note: runs.map(([part]) => part).join(""),
        runs,
        current: machine === d.machine,
        hovered: i === d.highlight,
        dim: !machine.presence().online,
      };
    });
    // Above the keys.
    const rows = Math.max(1, Math.min(choices.length, this.buttons_y - chip.y - 3)),
      first = Math.max(0, d.highlight - rows + 1),
      width = Math.min(this.width - 2, Math.max(32, dropdown.width(choices))),
      x = Math.max(this.x + 1, Math.min(chip.x, this.x + this.width - 1 - width));
    return { box: new Rect(x, chip.y + 1, width, rows + 2), first, choices: choices.slice(first, first + rows) };
  }
  /** The folder field laid out as the plain dialog lays out its field, with no list. */
  private static compactLayout(width: number, height: number, d: Dialog): View {
    const w = Math.min(width, Math.max(nameDialog.View.plainWidth(width), Math.min(width - 4, browserWidth(d))));
    const h = Math.min(height, 7);
    const y = Math.floor((height - h) / 2);
    const field_y = y + (h >= 7 ? 3 : h >= 5 ? 2 : 1);
    const padded = w >= 20;
    const inset = padded ? 3 : 1;
    const offset = nameDialog.View.scroll(d.browser.field, w - 2 * inset);
    const v = new View();
    Object.assign(v, {
      x: Math.floor((width - w) / 2),
      y,
      width: w,
      height: h,
      title_y: y + (h >= 5 ? 1 : 0),
      field_y,
      buttons_y: field_y + (h >= 7 ? 2 : 1),
      offset,
      text_x: Math.floor((width - w) / 2) + inset,
      text_width: w - 2 * inset,
      padded,
      dialog: d,
      compact: true,
      folders: { name_label_y: -1, label_y: -1, field_y, offset, list_y: -1, rows: 0, first: 0, entries: 0 },
    });
    return v;
  }
  protected keys(): KeySpec[] {
    return this.dialog.choosing ? machineKeys() : browserKeys(this.dialog);
  }
  protected title(): string {
    return this.chip ? ellipsis(this.fullTitle(), this.chip.title) : this.fullTitle();
  }
  private fullTitle(): string {
    return this.dialog.moving !== null ? i18n.t`Change folder` : super.title(this.dialog);
  }
  /** What a press lands on, the folder field and list included, and the
   * machine's name and the machines under it. */
  at(x: number, y: number): Hit {
    const v = this;
    const f = v.folders;
    const list = v.machineList(),
      row = list && dropdown.hit(list.box, list.choices.length, x, y);
    if (list && row !== null) return { tag: "machine_row", index: list.first + row };
    const chip = v.chip;
    if (chip && y === chip.y && x >= chip.x && x < chip.x + chip.width) return { tag: "machine" };
    if (chip?.key && y === chip.y && x >= chip.key && x < chip.key + displayWidth(chip_key)) return { tag: "machine" };
    // The field's fill beside the text answers too.
    const across = x + 1 >= v.text_x && x < v.text_x + v.text_width + 1;
    const column = Math.min(Math.max(0, x - v.text_x), v.text_width);
    if (across && y === f.field_y) return { tag: "folder", field: f.offset + column };
    const index = f.first + y - f.list_y;
    if (across && y >= f.list_y && y < f.list_y + f.rows && index < f.entries) return { tag: "entry", index };
    const found = v.hit(x, y);
    if (found.tag !== "key" || found.index !== arrows) return found;
    // The arrows' ← goes up; → and the label open.
    const b = v.buttons()[found.index];
    return x < b.x + (b.cap ? 4 : 1) ? { tag: "up" } : { tag: "open" };
  }
  draw(d: nameDialog.Dialog, w: Writer, number: number): void {
    const v = this;
    const b = v.dialog.browser;
    v.drawBox(w);
    if (v.compact) {
      const { left, room } = v.heading(b.field, w, number);
      if (b.problem && v.height >= 7) {
        w.write(`\x1b[${v.title_y + 2};${left + 1}H` + new Style({ fg: "hot", bg: "surface" }).sgr());
        writeEllipsis(w, problemMessage(b.problem), room);
      }
      v.drawButtons(w);
      v.placeCursor(b.field, w);
      return;
    }
    const { left, room } = v.heading(d, w, number);
    if (v.chip) v.drawMachine(w, v.chip);
    if (b.problem) {
      w.write(`\x1b[${v.title_y + 2};${left + 1}H` + new Style({ fg: "hot", bg: "surface" }).sgr());
      writeEllipsis(w, problemMessage(b.problem), room);
    }
    v.drawFolders(w, left);
    v.drawButtons(w);
    const list = v.machineList();
    // The open list has the keys, and no cursor shows.
    if (list) dropdown.draw(w, list.box, list.choices);
    else if (b.focused) v.placeCursor(b.field, w, v.folders.offset, v.folders.field_y);
    else v.placeCursor(d, w);
  }
  /** "on" and the machine's name after the title: lit under the pointer or
   * while its list is open, and warm while the machine isn't online. */
  private drawMachine(w: Writer, chip: Chip): void {
    const d = this.dialog,
      [before, after] = titleOn();
    const muted = new Style({ fg: "muted", bg: "surface" }).sgr();
    if (before) w.write(`\x1b[${chip.y + 1};${chip.x - displayWidth(before) + 1}H${muted}${before}`);
    const bg = d.choosing || d.hovering ? "selected" : "surface",
      tone = d.choosing ? "strong" : d.ready() ? "accent" : "warm";
    w.write(`\x1b[${chip.y + 1};${chip.x + 1}H` + new Style({ fg: "text", bg }).sgr() + " ");
    w.write(new Style({ fg: tone, bg, bold: true }).sgr());
    writeEllipsis(w, printable(d.machine!.name), chip.width - 4);
    w.write(new Style({ fg: d.choosing ? "strong" : "muted", bg }).sgr() + " ▾ ");
    if (after) w.write(muted + after);
    if (chip.key !== null) w.write(`\x1b[${chip.y + 1};${chip.key + 1}H${keycap}${chip_key}`);
  }
  /** Out and in stay quiet until the folder has the keys, and ↵ while the
   * machine isn't online. */
  protected look(k: Key, i: number): { cap: string; label: string; bare: string } {
    const d = this.dialog;
    const quiet =
      !d.choosing &&
      ((k.hit.tag === "key" && k.hit.index === arrows && !d.browser.focused) || (k.hit.tag === "save" && !d.ready()));
    if (quiet) return { cap: quiet_cap, label: quiet_label, bare: quiet_label };
    return super.look(k, i);
  }
  /** The machine's name and the machines in its list point too. */
  points(x: number, y: number): boolean {
    const tag = this.at(x, y).tag;
    return tag === "machine" || tag === "machine_row" || super.points(x, y);
  }
  /** The labels over the two fields, the folder field, and the folders in
   * it, then any offer to create: the highlighted one on `selected` behind
   * the focus bar. */
  private drawFolders(w: Writer, left: number): void {
    const v = this;
    const f = v.folders;
    const b = v.dialog.browser;
    const label = new Style({ fg: "faint", bg: "surface" }).sgr();
    w.write(`\x1b[${f.name_label_y + 1};${left + 1}H${label}` + i18n.t`Name`);
    w.write(`\x1b[${f.label_y + 1};${left + 1}H${label}` + i18n.t`Folder`);
    const field = b.field;
    const plain = new Style({ fg: "text", bg: "selected" }).sgr();
    w.write(`\x1b[${f.field_y + 1};${left + 1}H` + plain);
    w.splat(" ", v.text_width + 2);
    w.write(`\x1b[${f.field_y + 1};${v.text_x + 1}H`);
    writeField(w, field, f.offset, v.text_width, plain);
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
    if (!v.dialog.ready()) return v.drawWaiting(w, text_x, text_width);
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
      const create = i18n.t`Create `;
      w.write(new Style({ fg: highlighted ? "strong" : "muted", bg }).sgr() + create);
      w.write(new Style({ fg: highlighted ? "strong" : "text", bg, bold: highlighted }).sgr());
      writeEllipsis(w, printable(b.create ?? ""), Math.max(0, text_width - 2 - displayWidth(create)));
    }
    // Under the list, what stands where the field names a folder.
    const blocked = b.blocked;
    const below = f.list_y + b.count() - f.first + 1;
    if (blocked && below < f.list_y + f.rows) {
      const { kind, size: bytes, modified } = blocked.found;
      w.write(`\x1b[${below};${text_x}H` + new Style({ fg: "warm", bg: "surface" }).sgr());
      const name = blocked.name,
        type = kindLabel(kind);
      writeEllipsis(w, printable(i18n.t`${name} is ${type}, not a folder`), text_width);
      const age = relativeTime(Math.floor(modified / 1000), Math.floor(Date.now() / 1000));
      w.write(`\x1b[${below + 1};${text_x}H` + new Style({ fg: "faint", bg: "surface" }).sgr());
      const bytesLabel = size(bytes);
      writeEllipsis(w, i18n.t`${bytesLabel} · modified ${age}`, text_width);
    } else if (b.count() === 0 && !b.reading) {
      w.write(`\x1b[${f.list_y + 1};${text_x}H` + new Style({ fg: "faint", bg: "surface" }).sgr());
      writeEllipsis(
        w,
        !b.readable
          ? i18n.t`Can't read this folder`
          : b.typed.endsWith("/")
            ? i18n.t`No folders`
            : i18n.t`No folders match`,
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
  /** In place of the folders, the machine that isn't online yet. */
  private drawWaiting(w: Writer, x: number, room: number): void {
    const d = this.dialog,
      f = this.folders,
      presence = d.machine!.presence(),
      name = printable(d.machine!.name);
    w.write(
      `\x1b[${f.list_y + 1};${x}H` +
        new Style({ fg: presence.connection_status?.color ?? "warm", bg: "surface" }).sgr(),
    );
    writeEllipsis(w, presence.stopped ? i18n.t`${name} isn't connected` : i18n.t`Connecting to ${name}…`, room);
    if (d.moving !== null) return;
    w.write(`\x1b[${f.list_y + 2};${x}H` + new Style({ fg: "faint", bg: "surface" }).sgr());
    writeEllipsis(w, i18n.t`Its folders show, and ↵ creates, once it connects.`, room);
  }
}
