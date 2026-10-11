import { basename, dirname, join, isAbsolute } from "node:path";
import { mkdir, open, rename, readFile, realpath, stat } from "node:fs/promises";
import { Model, cleanLabel, max_workspaces } from "./layout";
import { Order } from "./agent_order";
import { Ref, State } from "./trackers/git_push";
import { Commits } from "./trackers/git_status";
import { Window } from "./usage/tokens";
import type { Snapshot as Worktrees } from "./worktrees";
export class Workspace {
  static Id = { none: 0, first: 1, next: (id: number) => id + 1 };
  name_buf = "";
  name_len = 0;
  model = new Model();
  agent_order = new Order();
  last_agent: string | null = null;
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
  ) {}
  customName() {
    return this.name_buf;
  }
  name() {
    return this.name_len ? this.customName() : basename(this.cwd) || "/";
  }
  follow(cwd: string) {
    if (!cwd || cwd === this.cwd) return false;
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
    this.name_buf = cleanLabel(value);
    this.name_len = this.name_buf.length;
  }
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
            version: 2,
            active: selected,
            next_id: this.next_id,
            workspaces: this.items.map(w => ({
              id: w.id,
              name: w.customName(),
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
    const d = JSON.parse(bytes);
    const invalid = () => {
      throw Error("InvalidWorkspaceState");
    };
    if (
      ![1, 2].includes(d.version) ||
      !Array.isArray(d.workspaces) ||
      !d.workspaces.length ||
      d.workspaces.length > max_workspaces
    )
      invalid();
    const items: Workspace[] = [];
    for (const x of d.workspaces) {
      if (
        !Number.isInteger(x.id) ||
        x.id <= 0 ||
        x.id >= d.next_id ||
        items.some(w => w.id === x.id) ||
        typeof x.cwd !== "string" ||
        !isAbsolute(x.cwd)
      )
        invalid();
      const w = new Workspace(x.id, x.cwd);
      w.rename(x.name);
      items.push(w);
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
  async add(name: string, cwd: string) {
    if (this.items.length >= max_workspaces) throw Error("TooManyWorkspaces");
    const w = new Workspace(this.next_id, await Store.directory(cwd));
    w.rename(name);
    this.items.push(w);
    this.next_id++;
    return w.id;
  }
  rename(id: number, name: string) {
    const w = this.get(id);
    if (!w) throw Error("NoWorkspace");
    w.rename(name);
  }
  async edit(id: number, name: string, cwd: string) {
    const w = this.get(id);
    if (!w) throw Error("NoWorkspace");
    w.cwd = await Store.directory(cwd);
    w.resetGit();
    w.rename(name);
  }
}
