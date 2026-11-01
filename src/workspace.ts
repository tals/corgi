import { basename, dirname, join, isAbsolute } from "node:path";
import { mkdir, open, rename, readFile, realpath, stat } from "node:fs/promises";
import { Model, max_label, max_workspaces } from "./layout";
import * as migrations from "./persist/migrations";
import { Order, Pins, key as agentKey, type Section } from "./agent_order";
import { Stars, type Session as StarredSession } from "./agent_stars";
import { Ref, State } from "./trackers/git_push";
import { Commits } from "./trackers/git_status";
import { Window } from "./usage/tokens";
import type { Snapshot as Worktrees } from "./worktrees";
export class Workspace {
  static Id = { none: 0, first: 1, next: (id: number) => id + 1 };
  private title: string;
  model = new Model();
  agent_order = new Order();
  /** Starred agents' order; the saved and wire field keeps its original name. */
  pinned_agents = new Pins();
  starred_sessions = new Stars();
  /** The conversation last seen in each live starred slot. */
  star_bindings = new Map<string, StarredSession>();
  /** The order inside each activity section: the user's, with an agent
   * that enters a section put first. */
  activity_order = new Order();
  /** Agents brought back with a place in `activity_order`, by key, until first seen. */
  restored = new Set<string>();
  /** The last section by `pane:N` or `headless:N`; null for a plain shell. */
  sections = new Map<string, Section | null>();
  /** The agents, by key, held in working until their first turn. */
  starting = new Set<string>();
  /** The live slots that have held an agent, so one that drops its provider keeps its place. */
  agent_slots = new Set<string>();
  last_agent: string | null = null;
  /** The launcher rows hidden in this workspace only. */
  launcher_hidden: string[] = [];
  launcher_order: string[] = [];
  /** The pane a viewer last used here, for the next viewer to open on. */
  focus = 0;
  git_ahead: bigint | null = null;
  git_ref = new Ref();
  git_push = new State();
  git_commits = new Commits();
  worktrees: Worktrees | null = null;
  git_epoch = 0;
  away = new Window();
  constructor(
    public id: number,
    public cwd: string,
    name = folderName(cwd),
  ) {
    this.title = Workspace.valid(name);
  }
  /** Takes up a saved activity order, where each agent keeps its place until it moves on. */
  restoreActivity(order: Order) {
    this.activity_order = order;
    this.restored = new Set(order.items.map(agentKey));
  }
  name() {
    return this.title;
  }
  /** Points the workspace at another folder; false when it's already there. */
  move(cwd: string) {
    if (cwd === this.cwd) return false;
    this.cwd = cwd;
    this.resetGit();
    return true;
  }
  resetGit() {
    this.git_epoch++;
    this.worktrees = null;
    this.git_ahead = null;
    this.git_ref = new Ref();
    this.git_push = new State();
    this.git_commits = new Commits();
  }
  rename(value: string) {
    this.title = Workspace.valid(value);
  }
  private static valid(value: string) {
    const name = label(value);
    if (!name) throw Error("InvalidName");
    return name;
  }
}
/** The name a workspace takes from its folder when given none. */
export const folderName = (cwd: string) => label(basename(cwd) || "/") || "_";
/** A name trimmed and with controls replaced, cut to whole characters
 * within `max` bytes. */
export function label(value: string, max = max_label) {
  let name = "",
    bytes = 0;
  for (const c of value.replace(/^ +| +$/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, "_")) {
    bytes += Buffer.byteLength(c);
    if (bytes > max) break;
    name += c;
  }
  return name.trimEnd();
}
export class Store {
  items: Workspace[] = [];
  next_id = 1;
  next_pane_id = 1;
  static statePath(socket: string) {
    const e = process.env;
    if (e.CORGI_ENV_DIR) return join(e.CORGI_ENV_DIR, "state", "corgi", "workspaces.json");
    if (e.CORGI_SOCKET !== undefined) return `${socket}.workspaces.json`;
    if (e.XDG_STATE_HOME) return join(e.XDG_STATE_HOME, "corgi", "workspaces.json");
    if (!e.HOME) throw Error("NoHome");
    return join(e.HOME, ".local", "state", "corgi", "workspaces.json");
  }
  async save(path: string, selected: number) {
    await mkdir(dirname(path), { recursive: true });
    const temp = path + ".tmp";
    const f = await open(temp, "w", 0o600);
    try {
      await f.writeFile(
        JSON.stringify(
          {
            version: migrations.workspaces_version,
            active: selected,
            next_id: this.next_id,
            workspaces: this.items.map(w => ({
              id: w.id,
              name: w.name(),
              cwd: w.cwd,
            })),
          },
          null,
          2,
        ),
      );
      await f.sync();
    } finally {
      await f.close();
    }
    await rename(temp, path);
  }
  async load(path: string) {
    let bytes: string;
    try {
      bytes = await readFile(path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    if (Buffer.byteLength(bytes) > 1024 * 1024) throw Error("FileTooBig");
    const { value: d } = migrations.decode("workspaces", bytes);
    const invalid = () => {
      throw Error("InvalidWorkspaceState");
    };
    if (!Array.isArray(d.workspaces) || !d.workspaces.length || d.workspaces.length > max_workspaces) invalid();
    const items: Workspace[] = [];
    for (const x of d.workspaces) {
      if (
        !Number.isInteger(x.id) ||
        x.id <= 0 ||
        x.id >= d.next_id ||
        items.some(w => w.id === x.id) ||
        typeof x.name !== "string" ||
        !label(x.name) ||
        typeof x.cwd !== "string" ||
        !isAbsolute(x.cwd)
      )
        invalid();
      items.push(new Workspace(x.id, x.cwd, x.name));
    }
    if (!items.some(w => w.id === d.active)) invalid();
    this.items = items;
    this.next_id = d.next_id;
    return d.active as number;
  }
  index(id: number) {
    const i = this.items.findIndex(w => w.id === id);
    return i < 0 ? null : i;
  }
  get(id: number) {
    return this.items.find(w => w.id === id) ?? null;
  }
  owner(pane: number) {
    return this.items.find(w => w.model.tabForPane(pane) !== null) ?? null;
  }
  moveBefore(id: number, before: number) {
    const from = this.index(id);
    if (from === null || this.index(before) === null) throw Error("NoWorkspace");
    const [w] = this.items.splice(from, 1);
    this.items.splice(before === id ? this.items.length : this.index(before)!, 0, w);
  }
  static async directory(path: string) {
    const home = process.env.HOME ?? ".",
      expanded = path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path || ".";
    const p = await realpath(expanded);
    if (!(await stat(p)).isDirectory()) throw Error("NotDir");
    return p;
  }
  /** Adds a workspace, named for its folder when `name` is blank. */
  async add(name: string, cwd: string) {
    const dir = await Store.directory(cwd);
    if (this.items.length >= max_workspaces) throw Error("TooManyWorkspaces");
    const w = new Workspace(this.next_id, dir, label(name) ? name : folderName(dir));
    this.items.push(w);
    this.next_id++;
    return w.id;
  }
  /** Renames a workspace whose name another has: "Foo" beside "Foo" and
   * "Foo: 4" becomes "Foo: 5". */
  distinguish(id: number) {
    const w = this.get(id);
    if (!w) throw Error("NoWorkspace");
    const others = new Set(this.items.filter(o => o !== w).map(o => o.name()));
    if (!others.has(w.name())) return;
    const root = w.name().replace(/: \d+$/, "");
    let n = 1;
    for (const o of others) {
      const m = o.startsWith(root + ": ") ? /^\d{1,6}$/.exec(o.slice(root.length + 2)) : null;
      if (m) n = Math.max(n, Number(m[0]));
    }
    // A root cut short for the number can meet a name the scan missed.
    const numbered = (n: number) => label(root, max_label - `: ${n}`.length) + `: ${n}`;
    while (others.has(numbered(++n)));
    w.rename(numbered(n));
  }
  rename(id: number, name: string) {
    const w = this.get(id);
    if (!w) throw Error("NoWorkspace");
    w.rename(name);
  }
  /** Renames a workspace unless `name` is null, and moves it unless `cwd`
   * is null: a rename keeps a folder that has since disappeared. */
  async edit(id: number, name: string | null, cwd: string | null) {
    const w = this.get(id);
    if (!w) throw Error("NoWorkspace");
    const dir = cwd === null ? null : await Store.directory(cwd);
    if (name !== null) w.rename(name);
    if (dir !== null) w.move(dir);
  }
}
