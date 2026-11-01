import * as i18n from "./i18n";
//! The launcher's worktree: the button in its title naming where agents
//! start, and a field that searches checkouts or names a new worktree,
//! which the daemon adds when an agent launches into it.
import { basename, dirname, relative } from "node:path";
import { homedir } from "node:os";
import * as palette from "./palette";
import { Style, keycap } from "./palette";
import { Rect } from "./layout";
import * as dropdown from "./dropdown";
import { Dialog } from "./name_dialog";
import { KeyHold } from "./key_hold";
import * as worktrees from "./worktrees";
import { label } from "./worktree_agents";
import * as worktreeFolder from "./worktree_folder";
import { ageLabel } from "./launcher_resume";
import { Writer, displayWidth, writeEllipsis, sat, directoryLabel } from "./text";

/** A worktree the daemon adds when an agent launches into it. */
export interface Planned {
  branch: string;
  /** What it branches from, as Git takes it, and as the footer names it. */
  base: string;
  base_name: string;
  path: string;
}
export type Mode = "closed" | "open";
/** The field with the caret; browsing checkouts keeps it in Branch. */
export type Focus = "branch" | "from";
export const create_hold_ms = 3000;
/** What a new worktree can branch from. */
export interface Base {
  ref: string;
  name: string;
}
/** A branch the From field offers, with when its last commit was made. */
export interface Branch extends Base {
  at: number;
}
/** The daemon's branch list, normalized. */
export function branchList(value: any): Branch[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((b: any) =>
    typeof b?.ref === "string" && typeof b?.name === "string"
      ? [{ ref: b.ref, name: b.name, at: Number(b.at) || 0 }]
      : [],
  );
}

export class Chooser {
  mode: Mode = "closed";
  focus: Focus = "branch";
  /** The row under the pointer, independent of the keyboard selection. */
  hovered: number | null = null;
  /** The search before browsing, kept while arrows write choices into Branch. */
  typed = "";
  /** Opening keeps a planned name in Branch without filtering the checkouts. */
  filtering = false;
  highlight: number | null = null;
  create = new KeyHold(create_hold_ms, 220, 150, 80);
  /** The checkouts' first shown row, when they're more than fit. */
  scroll = 0;
  field = Dialog.init({ rename: 0 }, "");
  /** What the new branch starts from; the comparison branch to begin with. */
  base: Base | null = null;
  /** The From field; typing there searches the branches. */
  from = Dialog.init({ rename: 0 }, "");
  /** Whether From holds typed text, which filters the list, rather than the base. */
  searching = false;
  /** The repository's branches, newest first; null until the daemon lists them. */
  branches: Branch[] | null = null;
  /** The highlighted branch in the From list, and its first shown row. */
  picked = 0;
  pick_scroll = 0;
  /** Why the name didn't take, until it changes. */
  error = "";
  planned: Planned | null = null;
  /** Git is adding the planned worktree. */
  adding = false;

  /** Opens on all checkouts, or the planned worktree's name and base. */
  open(snapshot: worktrees.Snapshot | null, cwd: string): void {
    const planned = this.planned;
    this.mode = "open";
    this.focus = "branch";
    this.hovered = this.highlight = null;
    this.scroll = 0;
    this.field = Dialog.init({ rename: 0 }, planned?.branch ?? "");
    this.typed = this.field.name();
    this.filtering = false;
    this.create.reset();
    this.base = planned ? { ref: planned.base, name: planned.base_name } : (bases(snapshot, cwd)[0] ?? null);
    this.error = "";
  }
  /** Matching checkouts, prefixes first; browsing doesn't change the search. */
  entries(snapshot: worktrees.Snapshot | null): worktrees.Checkout[] {
    const query = this.filtering ? this.typed.toLowerCase() : "";
    const all = checkouts(snapshot).filter(e => worktrees.label(e).toLowerCase().includes(query));
    return [
      ...all.filter(e => worktrees.label(e).toLowerCase().startsWith(query)),
      ...all.filter(e => !worktrees.label(e).toLowerCase().startsWith(query)),
    ];
  }
  /** An exact name takes an existing checkout, including a detached HEAD. */
  selected(snapshot: worktrees.Snapshot | null): worktrees.Checkout | null {
    const entries = this.entries(snapshot);
    if (this.highlight !== null && this.highlight < entries.length) return entries[this.highlight];
    return checkouts(snapshot).find(e => worktrees.label(e) === this.field.name()) ?? null;
  }
  offersCreate(snapshot: worktrees.Snapshot | null): boolean {
    return this.typed.length > 0 && !checkouts(snapshot).some(e => worktrees.label(e) === this.typed);
  }
  creating(snapshot: worktrees.Snapshot | null): boolean {
    return this.field.name().length > 0 && this.selected(snapshot) === null;
  }
  count(snapshot: worktrees.Snapshot | null): number {
    return this.entries(snapshot).length + Number(this.offersCreate(snapshot));
  }
  /** Editing starts a fresh search; caret motion leaves the browsed list alone. */
  edit(edit: (field: Dialog) => void): void {
    const before = this.field.raw();
    edit(this.field);
    this.create.reset();
    if (this.field.raw() === before) return;
    this.typed = this.field.name();
    this.filtering = true;
    this.highlight = this.hovered = null;
    this.scroll = 0;
    this.error = "";
  }
  /** Writes a row into Branch without narrowing the list under the cursor. */
  pick(snapshot: worktrees.Snapshot | null, index: number): void {
    if (index < 0 || index >= this.count(snapshot)) return;
    const entry = this.entries(snapshot)[index];
    this.field = Dialog.init({ rename: 0 }, entry ? worktrees.label(entry) : this.typed);
    this.field.selected = false;
    this.highlight = index;
    this.focus = "branch";
    this.create.reset();
    this.error = "";
  }
  /** Arrows browse the matches and the offer to create, filling Branch. */
  move(snapshot: worktrees.Snapshot | null, delta: number): void {
    const count = this.count(snapshot);
    const start = this.highlight ?? (delta > 0 ? -1 : count);
    this.pick(snapshot, Math.max(0, Math.min(count - 1, start + delta)));
  }
  /** The field with the caret. */
  input(): Dialog {
    return this.focus === "from" ? this.from : this.field;
  }
  /** Puts the caret in From, its text the base, selected so typing replaces it. */
  focusFrom(): void {
    this.create.reset();
    this.focus = "from";
    this.from = Dialog.init({ rename: 0 }, this.base?.name ?? "");
    this.searching = false;
    this.picked = Math.max(
      0,
      this.matches().findIndex(b => b.ref === this.base?.ref),
    );
    this.pick_scroll = 0;
  }
  /** Typing in From: what's typed filters the list from its first match. */
  search(edit: (field: Dialog) => void): void {
    edit(this.from);
    this.searching = true;
    this.picked = 0;
  }
  /** The branches From offers: all of them until something's typed, then
   * those whose name holds it, the ones starting with it first. */
  matches(): Branch[] {
    const all = this.branches ?? [];
    const query = this.searching ? this.from.name().toLowerCase() : "";
    if (query.length === 0) return all;
    const found = all.filter(b => b.name.toLowerCase().includes(query));
    return [
      ...found.filter(b => b.name.toLowerCase().startsWith(query)),
      ...found.filter(b => !b.name.toLowerCase().startsWith(query)),
    ];
  }
  movePick(delta: number): void {
    this.picked = Math.max(0, Math.min(this.matches().length - 1, this.picked + delta));
  }
  /** Takes the highlighted branch as the base and goes back to Branch;
   * false when nothing matches. */
  takeFrom(): boolean {
    const b = this.matches()[this.picked];
    if (!b) return false;
    this.base = { ref: b.ref, name: b.name };
    this.focus = "branch";
    return true;
  }
  /** Takes the form's name, placing its folder by `template`, or says why not. */
  accept(snapshot: worktrees.Snapshot | null, cwd: string, template: string): boolean {
    const branch = this.field.name();
    const problem = branchProblem(snapshot, branch);
    if (problem !== null) {
      this.error = problem;
      return false;
    }
    const base = this.base;
    if (!base) {
      this.error = i18n.t`This folder has no commit to branch from`;
      return false;
    }
    this.planned = { branch, base: base.ref, base_name: base.name, path: plannedPath(snapshot, cwd, branch, template) };
    this.error = "";
    this.mode = "closed";
    return true;
  }
}

/** The checkouts to choose from: the primary first, then the linked ones. */
export function checkouts(snapshot: worktrees.Snapshot | null): worktrees.Checkout[] {
  const all = snapshot?.entries.filter(e => !e.bare && !worktrees.dead(e)) ?? [];
  return [...all.filter(e => e.primary), ...all.filter(e => !e.primary)];
}
function within(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith("/") ? root : root + "/");
}
/** The checkout `cwd` is in, the innermost when they nest. */
export function containing(snapshot: worktrees.Snapshot | null, cwd: string): worktrees.Checkout | null {
  let found: worktrees.Checkout | null = null;
  for (const e of checkouts(snapshot))
    if (within(e.path, cwd) && (found === null || e.path.length > found.path.length)) found = e;
  return found;
}
/** Where agents start, as the title names it. */
export interface Place {
  label: string;
  /** A checkout the button can swap for another. */
  worktree: boolean;
  /** Off the comparison branch, which the title marks. */
  aside: boolean;
}
export function place(snapshot: worktrees.Snapshot | null, cwd: string, planned: Planned | null): Place {
  if (planned) return { label: planned.branch, worktree: true, aside: true };
  const at = containing(snapshot, cwd);
  if (!at) return { label: basename(cwd) || cwd, worktree: false, aside: false };
  return { label: label(at), worktree: true, aside: snapshot?.base != null && at.branch !== snapshot.base.ref };
}
/** A checkout's agents and uncommitted files, for the list's right edge. */
function note(snapshot: worktrees.Snapshot, e: worktrees.Checkout): string {
  const agents = snapshot.agents.filter(a => a.path === e.path).length;
  const parts: string[] = [];
  if (agents > 0) {
    const count = agents;
    parts.push(count === 1 ? i18n.t`${count} agent` : i18n.t`${count} agents`);
  }
  if (!e.available) parts.push(i18n.t`missing`);
  else if (e.changes) {
    const count = e.changes.total;
    parts.push(count > 0 ? i18n.t`${count} changed` : i18n.t`clean`);
  }
  return parts.join(" · ");
}
/** The matching checkouts and creation offer; From dims the list. */
export function choices(snapshot: worktrees.Snapshot | null, cwd: string, c: Chooser): dropdown.Choice[] {
  const current = c.planned ? null : containing(snapshot, cwd);
  const selected = c.selected(snapshot);
  const entries = c.entries(snapshot);
  const out: dropdown.Choice[] = entries.map((e, i) => ({
    text: worktrees.label(e),
    note: note(snapshot!, e),
    current: e === current,
    hovered: c.focus === "branch" && (e === selected || i === c.hovered),
    dim: c.focus === "from",
  }));
  const branch = c.typed;
  if (c.offersCreate(snapshot))
    out.push({
      text: i18n.t`+ Create “${branch}”`,
      note: "",
      current: false,
      hovered: c.focus === "branch" && (c.creating(snapshot) || c.hovered === entries.length),
      dim: c.focus === "from",
    });
  return out;
}
/** The comparison branch, then the current checkout's branch when that
 * differs: the default base, and what From offers when the daemon can't
 * list branches. */
export function bases(snapshot: worktrees.Snapshot | null, cwd: string): Base[] {
  const out: Base[] = [];
  if (snapshot?.base) out.push({ ref: snapshot.base.ref, name: snapshot.base.name });
  const at = containing(snapshot, cwd);
  if (at && at.branch !== snapshot?.base?.ref) out.push({ ref: at.branch ?? at.head, name: label(at) });
  return out;
}
/** The project's main checkout, which `$PROJECT_ROOT` names. */
export function projectRoot(snapshot: worktrees.Snapshot | null, cwd: string): string {
  return snapshot?.entries.find(e => e.primary)?.path ?? containing(snapshot, cwd)?.path ?? cwd;
}
/** Where `template` puts the worktree for `branch`. */
export function plannedPath(snapshot: worktrees.Snapshot | null, cwd: string, branch: string, template: string) {
  return worktreeFolder.expand(template, projectRoot(snapshot, cwd), branch);
}
/** The folder as the form shows it: from the project root inside it or
 * beside it, else from home. */
export function folderLabel(path: string, root: string): string {
  if (path === root || path.startsWith(root + "/")) return `./${relative(root, path)}`;
  if (dirname(path) === dirname(root)) return `../${basename(path)}`;
  return directoryLabel(path, homedir());
}
/** Why `name` can't name a new branch, or null; Git has the last word. */
export function branchProblem(snapshot: worktrees.Snapshot | null, name: string): string | null {
  if (name.length === 0) return i18n.t`Type a branch name`;
  if (
    /[\x00-\x20\x7f~^:?*[\\]/.test(name) ||
    /\.\.|@\{|\/\//.test(name) ||
    /^[-/]|[/.]$|\.lock$/.test(name) ||
    name === "@" ||
    name.split("/").some(part => part.startsWith("."))
  )
    return i18n.t`Branch names can't have spaces, .., or ~^:?*[\\`;
  if (snapshot?.entries.some(e => e.branch === `refs/heads/${name}`)) return i18n.t`${name} is checked out already`;
  return null;
}
/** Why the daemon didn't add `planned`, for the form. */
export function reason(err: string | null, planned: Planned): string {
  const branch = planned.branch,
    name = basename(planned.path);
  switch (err) {
    case "BranchExists":
      return i18n.t`A branch named ${branch} exists already`;
    case "FolderExists":
      return i18n.t`${name} exists already`;
    case "InvalidBranch":
      return i18n.t`Git doesn't take that branch name`;
    case "WorktreeAddFailed":
      return i18n.t`Git couldn't add the worktree`;
    case "UnknownOperation":
      return i18n.t`Reload Corgi's daemon first`;
    default:
      return err ?? i18n.t`Unknown error`;
  }
}

const titleLead = () => i18n.t` New agent  in  `;
/** The title's button around the place's name, in 0-based cells, with the
 * room its name has; null when the title can't fit it before `right`. */
export function button(b: Rect, p: Place, right: number) {
  const x = b.x + 2 + displayWidth(titleLead());
  // " ", the keycap, " ⌥ ", then " ▾ " after the name.
  const chrome = p.worktree ? 10 : 0;
  const room = right - x - chrome - 1;
  if (room < 3) return null;
  return { x, w: chrome + Math.min(displayWidth(p.label), room), room };
}
/** " New agent  in " and the button, in the launcher's top border; warm
 * off the comparison branch. */
export function drawTitle(w: Writer, b: Rect, p: Place, right: number, open: boolean, panel: string): void {
  const span = button(b, p, right);
  w.write(`\x1b[${b.y + 1};${b.x + 3}H\x1b[1m` + palette.fg("strong"));
  writeEllipsis(w, span ? titleLead() : ` ${i18n.t`New agent`} `, sat(right, b.x + 2));
  w.write(panel);
  if (!span) return;
  if (!p.worktree) {
    w.write(palette.fg("text"));
    writeEllipsis(w, p.label, span.room);
    w.write(panel + " ");
    return;
  }
  const raised = new Style({ fg: "strong", bg: "selected" }).sgr();
  w.write(`${raised} ${keycap} w ${raised} ` + palette.fg(p.aside ? "warm" : "muted") + "⌥ \x1b[1m");
  w.write(palette.fg(p.aside ? "warm" : "strong"));
  writeEllipsis(w, p.label, span.room);
  w.write("\x1b[22m" + palette.fg("muted") + (open ? " ▴ " : " ▾ ") + panel + " ");
}
/** The most checkouts the box shows at once. */
export const list_rows = 8;
/** What a pointer is on in the open box. */
export type Spot = { checkout: number } | "branch" | "from" | "confirm" | { pick: number };
/** The search, matches, destination details and action, in 0-based cells. */
export interface Box {
  rect: Rect;
  /** Rows of checkouts shown, from `list`. */
  shown: number;
  list: number;
  branch: number;
  from: number;
  picks: number;
  folder: number;
  footer: number;
  error: number | null;
  label_x: number;
  field_x: number;
  field_w: number;
}
/** The box hanging from the title's button, inside the launcher. */
export function box(b: Rect, button_x: number, count: number, error: boolean, pick_count = 0): Box {
  const width = Math.min(56, sat(b.w, 2));
  const x = Math.max(b.x + 1, Math.min(button_x + 3, b.x + b.w - 1 - width));
  const picks = Math.max(0, Math.min(pick_count, b.h - 14 - Number(error)));
  const shown = Math.max(0, Math.min(count, list_rows, b.h - 13 - Number(error) - picks));
  const list = b.y + 5;
  const from = list + shown + 1;
  const folder = from + picks + 1;
  return {
    rect: new Rect(x, b.y + 1, width, shown + 10 + Number(error) + picks),
    shown,
    list,
    branch: b.y + 3,
    from,
    picks,
    folder,
    footer: folder + 2 + Number(error),
    error: error ? folder + 1 : null,
    label_x: x + 4,
    field_x: x + 12,
    field_w: sat(width, 14),
  };
}
/** The rows the launcher needs below its title for the box with `shown`
 * checkouts, and From's list of `picks` rows while it's open. */
export function boxHeight(shown: number, error: boolean, picks: number | null): number {
  return shown + 13 + Number(error) + (picks ?? 0);
}
/** The choices shown, scrolled to keep the keyboard selection in view. */
export function visible(c: Chooser, all: dropdown.Choice[], shown: number): dropdown.Choice[] {
  const selected = c.highlight ?? -1;
  if (selected >= 0) c.scroll = Math.max(Math.min(c.scroll, selected), selected - shown + 1, 0);
  c.scroll = Math.min(c.scroll, Math.max(0, all.length - shown));
  return all.slice(c.scroll, c.scroll + shown);
}
/** The most branches From's list shows at once. */
export const pick_rows = 8;
/** From's list: rows right under the field, as wide as it, so the field
 * seems to open downward. */
export function pickRect(bx: Box): Rect {
  return new Rect(bx.field_x, bx.from + 1, bx.field_w, bx.picks);
}
/** From's list as dropdown rows, scrolled to keep the highlighted one in view. */
export function pickChoices(c: Chooser, now: number, rows = pick_rows): dropdown.Choice[] {
  if (c.branches === null) return [{ text: i18n.t`Reading branches…`, note: "", current: false, hovered: false }];
  const all = c.matches();
  if (all.length === 0) return [{ text: i18n.t`No branch matches`, note: "", current: false, hovered: false }];
  c.pick_scroll = Math.max(Math.min(c.pick_scroll, c.picked), c.picked - rows + 1, 0);
  return all.slice(c.pick_scroll, c.pick_scroll + rows).map((b, i) => ({
    text: b.name,
    note: b.at > 0 ? ageLabel(now - b.at) : "",
    current: b.ref === c.base?.ref,
    hovered: c.pick_scroll + i === c.picked,
  }));
}
