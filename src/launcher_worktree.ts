//! The launcher's worktree: the button in its title naming where agents
//! start, and the box it drops: the checkouts, then a form naming a new
//! worktree, which the daemon adds when an agent launches into it.
import { basename, dirname, relative } from "node:path";
import { homedir } from "node:os";
import * as palette from "./palette";
import { Style, keycap } from "./palette";
import { Rect } from "./layout";
import * as dropdown from "./dropdown";
import { Dialog } from "./name_dialog";
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
/** Where the open box has the keyboard: a checkout, or one of the form's fields. */
export type Focus = "list" | "branch" | "from";
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
  focus: Focus = "list";
  /** The checkout under the keyboard or pointer. */
  hovered = 0;
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

  /** Opens the box on the current checkout, or, with a new worktree named,
   * in its form on that name and base. */
  open(snapshot: worktrees.Snapshot | null, cwd: string): void {
    const planned = this.planned;
    const at = containing(snapshot, cwd);
    this.mode = "open";
    this.focus = planned ? "branch" : "list";
    this.hovered = Math.max(0, at && !planned ? checkouts(snapshot).indexOf(at) : 0);
    this.scroll = 0;
    this.field = Dialog.init({ rename: 0 }, planned?.branch ?? "");
    this.base = planned ? { ref: planned.base, name: planned.base_name } : (bases(snapshot, cwd)[0] ?? null);
    this.error = "";
  }
  /** Moves along the checkouts; past the last one, into Branch. */
  move(snapshot: worktrees.Snapshot | null, delta: number): void {
    const next = this.hovered + delta;
    if (next >= checkouts(snapshot).length) this.focus = "branch";
    else this.hovered = Math.max(0, next);
  }
  /** The field with the caret. */
  input(): Dialog {
    return this.focus === "from" ? this.from : this.field;
  }
  /** Puts the caret in From, its text the base, selected so typing replaces it. */
  focusFrom(): void {
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
      this.error = "This folder has no commit to branch from";
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
/** How the title names where agents start, and whether that is a checkout
 * the button can swap for another. */
export function place(snapshot: worktrees.Snapshot | null, cwd: string, planned: Planned | null) {
  if (planned) return { label: planned.branch, worktree: true };
  const at = containing(snapshot, cwd);
  return at ? { label: label(at), worktree: true } : { label: basename(cwd) || cwd, worktree: false };
}
/** A checkout's agents and uncommitted files, for the list's right edge. */
function note(snapshot: worktrees.Snapshot, e: worktrees.Checkout): string {
  const agents = snapshot.agents.filter(a => a.path === e.path).length;
  const parts: string[] = [];
  if (agents > 0) parts.push(`${agents} agent${agents === 1 ? "" : "s"}`);
  if (!e.available) parts.push("missing");
  else if (e.changes) parts.push(e.changes.total > 0 ? `${e.changes.total} changed` : "clean");
  return parts.join(" · ");
}
/** The checkouts as dropdown rows: the hovered one lit while the list has
 * the keyboard, all of them dim while the form has it. */
export function choices(snapshot: worktrees.Snapshot | null, cwd: string, c: Chooser): dropdown.Choice[] {
  const current = c.planned ? null : containing(snapshot, cwd);
  return checkouts(snapshot).map((e, i) => ({
    text: label(e),
    note: note(snapshot!, e),
    current: e === current,
    hovered: c.focus === "list" && i === c.hovered,
    dim: c.focus !== "list",
  }));
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
  if (name.length === 0) return "Type a branch name";
  if (
    /[\x00-\x20\x7f~^:?*[\\]/.test(name) ||
    /\.\.|@\{|\/\//.test(name) ||
    /^[-/]|[/.]$|\.lock$/.test(name) ||
    name === "@" ||
    name.split("/").some(part => part.startsWith("."))
  )
    return "Branch names can't have spaces, .., or ~^:?*[\\";
  if (snapshot?.entries.some(e => e.branch === `refs/heads/${name}`)) return `${name} is checked out already`;
  return null;
}
/** Why the daemon didn't add `planned`, for the form. */
export function reason(err: string | null, planned: Planned): string {
  switch (err) {
    case "BranchExists":
      return `A branch named ${planned.branch} exists already`;
    case "FolderExists":
      return `${basename(planned.path)} exists already`;
    case "InvalidBranch":
      return "Git doesn't take that branch name";
    case "WorktreeAddFailed":
      return "Git couldn't add the worktree";
    case "UnknownOperation":
      return "Reload Corgi's daemon first";
    default:
      return err ?? "Unknown error";
  }
}

const lead = " New agent ";
const joiner = " in  ";
/** The title's button around the place's name, in 0-based cells, with the
 * room its name has; null when the title can't fit it before `right`. */
export function button(b: Rect, p: { label: string; worktree: boolean }, right: number) {
  const x = b.x + 2 + lead.length + joiner.length;
  // " ", the keycap, " ⌥ ", then " ▾ " after the name.
  const chrome = p.worktree ? 10 : 0;
  const room = right - x - chrome - 1;
  if (room < 3) return null;
  return { x, w: chrome + Math.min(displayWidth(p.label), room), room };
}
/** " New agent  in " and the button, in the launcher's top border. */
export function drawTitle(
  w: Writer,
  b: Rect,
  p: { label: string; worktree: boolean },
  right: number,
  open: boolean,
  panel: string,
): void {
  w.write(`\x1b[${b.y + 1};${b.x + 3}H\x1b[1m` + palette.fg("strong") + lead + panel);
  const span = button(b, p, right);
  if (!span) return;
  w.write(joiner);
  if (!p.worktree) {
    w.write(palette.fg("text"));
    writeEllipsis(w, p.label, span.room);
    w.write(panel + " ");
    return;
  }
  const raised = new Style({ fg: "strong", bg: "selected" }).sgr();
  w.write(`${raised} ${keycap} w ${raised} ` + palette.fg("muted") + "⌥ \x1b[1m" + palette.fg("strong"));
  writeEllipsis(w, p.label, span.room);
  w.write("\x1b[22m" + palette.fg("muted") + (open ? " ▴ " : " ▾ ") + panel + " ");
}
/** The most checkouts the box shows at once. */
export const list_rows = 8;
/** What a pointer is on in the open box. */
export type Spot = { checkout: number } | "branch" | "from" | { pick: number };
/** Where the open box's parts sit, in 0-based cells: the checkouts, a
 * blank row, the New worktree rule, then Branch, a blank row, From and
 * Folder, and a row for what's wrong when something is. */
export interface Box {
  rect: Rect;
  /** Rows of checkouts shown, from `list`. */
  shown: number;
  list: number;
  rule: number;
  branch: number;
  from: number;
  folder: number;
  error: number | null;
  label_x: number;
  field_x: number;
  field_w: number;
}
/** The box hanging from the title's button with its ✓ under the ⌥, inside the launcher. */
export function box(b: Rect, button_x: number, count: number, error: boolean): Box {
  const width = Math.min(56, sat(b.w, 2));
  const x = Math.max(b.x + 1, Math.min(button_x + 3, b.x + b.w - 1 - width));
  const shown = Math.min(count, list_rows);
  const rule = b.y + shown + 3;
  return {
    rect: new Rect(x, b.y + 1, width, shown + 8 + (error ? 1 : 0)),
    shown,
    list: b.y + 2,
    rule,
    branch: rule + 1,
    from: rule + 3,
    folder: rule + 4,
    error: error ? rule + 5 : null,
    label_x: x + 4,
    field_x: x + 12,
    field_w: sat(width, 14),
  };
}
/** The rows the launcher needs below its title for the box with `shown`
 * checkouts, and From's list of `picks` rows while it's open. */
export function boxHeight(shown: number, error: boolean, picks: number | null): number {
  return Math.max(shown + 11 + (error ? 1 : 0), picks === null ? 0 : shown + 9 + picks);
}
/** The checkouts shown, scrolled to keep the hovered one in view. */
export function visible(c: Chooser, all: dropdown.Choice[], shown: number): dropdown.Choice[] {
  c.scroll = Math.max(Math.min(c.scroll, c.hovered), c.hovered - shown + 1, 0);
  return all.slice(c.scroll, c.scroll + shown);
}
/** The most branches From's list shows at once. */
export const pick_rows = 8;
/** From's list: rows right under the field, as wide as it, so the field
 * seems to open downward. */
export function pickRect(bx: Box, rows: number): Rect {
  return new Rect(bx.field_x, bx.from + 1, bx.field_w, rows);
}
/** From's list as dropdown rows, scrolled to keep the highlighted one in view. */
export function pickChoices(c: Chooser, now: number): dropdown.Choice[] {
  if (c.branches === null) return [{ text: "Reading branches…", note: "", current: false, hovered: false }];
  const all = c.matches();
  if (all.length === 0) return [{ text: "No branch matches", note: "", current: false, hovered: false }];
  c.pick_scroll = Math.max(Math.min(c.pick_scroll, c.picked), c.picked - pick_rows + 1, 0);
  return all.slice(c.pick_scroll, c.pick_scroll + pick_rows).map((b, i) => ({
    text: b.name,
    note: b.at > 0 ? ageLabel(now - b.at) : "",
    current: b.ref === c.base?.ref,
    hovered: c.pick_scroll + i === c.picked,
  }));
}
