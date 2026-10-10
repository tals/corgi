//! Read-only discovery runs asynchronously away from PTY collection.
import { Quit, run as subprocessRun } from "../subprocess";
import { readdirSync, statSync, accessSync, constants } from "node:fs";
import { join } from "node:path";
import type { Node } from "./layout";
import * as tmux_layout from "./tmux_layout";
import * as tmux_resume from "./tmux_resume";
import * as cmux_import from "./cmux";
import * as herdr from "./herdr";
import * as errors from "../errors";
export type Source = "tmux" | "herdr" | "cmux";
export const available_sources: Source[] =
  process.platform === "darwin" ? ["tmux", "herdr", "cmux"] : ["tmux", "herdr"];
export type Pane = {
  id: string;
  name: string;
  cwd: string;
  pid: number | null;
  url: string;
  x: number;
  y: number;
  w: number;
  h: number;
  resume_available: boolean;
  history: string;
  screen: string;
  restart_command: string;
};
export type Tab = { id: string; name: string; panes: Pane[]; nodes: Node[] };
export type Recovery = "full" | "layout" | "partial" | "workspace";
export type Workspace = {
  id: string;
  name: string;
  cwd: string;
  socket: string;
  session: number;
  activity: number;
  handoff: boolean;
  recovery: Recovery;
  recovery_note: string;
  tabs: Tab[];
};
export class Catalog {
  workspaces: Workspace[] = [];
  message = "";
  confused = false;
}
export const pane = (fields: Partial<Pane> & { id: string; name: string }): Pane => ({
  cwd: "",
  pid: null,
  url: "",
  x: 0,
  y: 0,
  w: 80,
  h: 24,
  resume_available: false,
  history: "",
  screen: "",
  restart_command: "",
  ...fields,
});
export const workspace = (fields: Partial<Workspace> & { id: string; name: string; tabs: Tab[] }): Workspace => ({
  cwd: "",
  socket: "",
  session: 0,
  activity: 0,
  handoff: false,
  recovery: "full",
  recovery_note: "",
  ...fields,
});
export function recentFirst(left: Workspace, right: Workspace): number {
  return (
    right.activity - left.activity ||
    Buffer.compare(Buffer.from(left.socket), Buffer.from(right.socket)) ||
    Buffer.compare(Buffer.from(left.id), Buffer.from(right.id))
  );
}
export function copyWorkspaces(selected: Workspace[]): Workspace[] {
  const count = selected.reduce((n, w) => n + w.tabs.reduce((m, t) => m + t.panes.length, 0), 0),
    limit = Math.floor(Math.floor((512 * 1024) / Math.max(1, count)) / 2);
  return selected.map(ws => ({
    ...ws,
    tabs: ws.tabs.map(tab => ({
      ...tab,
      panes: tab.panes.map(p => ({
        ...p,
        history: tmux_resume.tail(p.history, limit),
        screen: tmux_resume.tail(p.screen, limit),
      })),
    })),
  }));
}
export class Worker {
  done = false;
  stop = false;
  catalog = new Catalog();
  herdr_scan: herdr.Scan | null = null;
  quit = Quit.init();
  constructor(public source: Source) {}
  static start(source: Source): Worker {
    if (source === "cmux" && process.platform !== "darwin") throw Error("CmuxRequiresMacOS");
    const worker = new Worker(source);
    void worker.run();
    return worker;
  }
  close() {
    this.stop = true;
    this.quit.signal();
  }
  private async run() {
    try {
      await this.discover();
    } catch (error) {
      this.catalog = new Catalog();
      this.catalog.message = error instanceof Error ? error.message : String(error);
    } finally {
      this.done = true;
    }
  }
  async command(argv: string[]): Promise<string> {
    return this.commandUntil(argv, Date.now() + 5000);
  }
  async commandUntil(argv: string[], until: number): Promise<string> {
    if (this.stop) throw Error("SourceCancelled");
    const timeout = Math.min(until - Date.now(), 5000);
    if (timeout <= 0) throw Error("SourceTimedOut");
    try {
      const out = await subprocessRun(argv, {
        timeout_ms: timeout,
        max_output: 4 * 1024 * 1024,
        quit: this.quit,
      });
      if (!out.ok()) throw Error("SourceUnavailable");
      return out.stdout.toString();
    } catch (error) {
      const name = (error as Error).message;
      throw Error(
        (
          {
            Cancelled: "SourceCancelled",
            TimedOut: "SourceTimedOut",
            OutputTooLarge: "SourceTooLarge",
          } as Record<string, string>
        )[name] ?? name,
      );
    }
  }
  async discover() {
    if (this.source === "tmux") return this.tmux();
    if (this.source === "cmux") return this.cmux();
    this.herdr_scan = await herdr.scanCancelable(() => this.stop);
    this.catalog.workspaces = this.herdr_scan.sessions.flatMap((session, si) =>
      session.workspaces.map(ws =>
        workspace({
          id: ws.id,
          name: ws.name,
          cwd: ws.cwd,
          socket: session.socket,
          session: si,
          handoff: session.live_handoff,
          tabs: ws.tabs.map(tab => ({
            id: tab.id,
            name: tab.name,
            nodes: [],
            panes: tab.panes.map(p => pane({ ...p, resume_available: p.resume_hint.session.len > 0 })),
          })),
        }),
      ),
    );
  }
  async tmux() {
    const sockets: string[] = [];
    if (process.env.TMUX) sockets.push(process.env.TMUX.split(",")[0]);
    const dir = join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${process.getuid?.() ?? 0}`);
    try {
      for (const entry of readdirSync(dir)) {
        const socket = join(dir, entry);
        if (statSync(socket).isSocket() && !sockets.includes(socket)) sockets.push(socket);
      }
    } catch {}
    if (!sockets.length) throw Error("NoTmuxSessions");
    const processes = await this.command(["ps", "-axo", "pid=,tpgid="]).catch(() => ""),
      workspaces: Workspace[] = [];
    for (const socket of sockets) {
      const sessions = await this.command([
        "tmux",
        "-S",
        socket,
        "list-sessions",
        "-F",
        "#{session_id}\t#{session_name}\t#{session_activity}",
      ]).catch(() => "");
      for (const line of sessions.split("\n").filter(Boolean)) {
        const [id, name, activity] = line.split("\t");
        if (name === undefined) continue;
        const windows = await this.command([
            "tmux",
            "-S",
            socket,
            "list-windows",
            "-t",
            id,
            "-F",
            "#{window_id}\t#{window_name}",
          ]),
          tabs: Tab[] = [];
        for (const row of windows.split("\n").filter(Boolean)) {
          const [wid, window_name] = row.split("\t");
          if (window_name === undefined) continue;
          const format =
            "#{pane_id}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_pid}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}\t#{?window_zoomed_flag,#{window_layout},}\t#{alternate_on}\t#{history_size}";
          const content = await this.command(["tmux", "-S", socket, "list-panes", "-t", wid, "-F", format]),
            panes: Pane[] = [];
          let unzoomed: tmux_layout.Geometry | null = null;
          for (const raw of content.split("\n").filter(Boolean)) {
            const [
              pid,
              pname,
              pane_cwd,
              process,
              x = "0",
              y = "0",
              w = "80",
              h = "24",
              saved = "",
              alternate = "0",
              history_size = "0",
            ] = raw.split("\t");
            if (pname === undefined || pane_cwd === undefined) continue;
            const coords = [x, y, w, h].map(v => {
              if (!/^\d+$/.test(v) || Number(v) > 65535) throw Error("InvalidCharacter");
              return Number(v);
            });
            if (!unzoomed && saved) unzoomed = tmux_layout.parse(saved);
            const root = /^-?\d+$/.test(process ?? "") ? Number(process) : null,
              foreground = root === null ? null : tmux_resume.foregroundPid(processes, root),
              restart = foreground ? tmux_resume.command(foreground) : "";
            const capture = (args: string[]) =>
              this.command(["tmux", "-S", socket, "capture-pane", "-p", ...args, "-t", pid]).catch(() => "");
            const screen = await capture(["-J", "-S", alternate === "1" ? "0" : "-1000"]);
            let history = "";
            if (alternate === "1") {
              const savedScreen = await capture(["-a", "-J"]),
                scrollback = Number(history_size) > 0 ? await capture(["-J", "-S", "-1000", "-E", "-1"]) : "";
              history = scrollback + savedScreen;
            }
            panes.push(
              pane({
                id: pid,
                name: pname,
                cwd: pane_cwd,
                pid: root,
                x: coords[0],
                y: coords[1],
                w: coords[2],
                h: coords[3],
                restart_command: restart,
                resume_available: !!restart,
                screen: tmux_resume.tail(screen, 65536),
                history: tmux_resume.tail(history, 65536),
              }),
            );
          }
          if (unzoomed) {
            if (unzoomed.count !== panes.length) throw Error("TmuxLayoutChanged");
            for (const p of panes) {
              const rect = unzoomed.find(p.id);
              if (!rect) throw Error("TmuxLayoutChanged");
              Object.assign(p, rect);
            }
          }
          if (panes.length) tabs.push({ id: wid, name: window_name, panes, nodes: [] });
        }
        if (tabs.length)
          workspaces.push(
            workspace({
              id,
              name,
              socket,
              activity: Number(activity) || 0,
              cwd: tabs[0].panes[0].cwd,
              tabs,
            }),
          );
      }
    }
    this.catalog.workspaces = workspaces.sort(recentFirst);
  }
  async cmuxJson(exe: string, args: string[], deadline: number): Promise<any> {
    for (const uuids of [true, false]) {
      try {
        const bytes = await this.commandUntil(
            [exe, ...args, "--json", ...(uuids ? ["--id-format", "uuids"] : [])],
            deadline,
          ),
          value = JSON.parse(bytes);
        if (value && typeof value === "object" && !Array.isArray(value)) return value.result ?? value;
      } catch (error) {
        if (errors.is(error, "SourceCancelled")) throw error;
      }
    }
    return null;
  }
  async cmuxEntries(exe: string, entries: any[], shallow: boolean, out: Workspace[], deadline: number) {
    for (const ws of entries) {
      if (this.stop) throw Error("SourceCancelled");
      let details: any = null;
      if (Array.isArray(ws?.panes) && ws.panes.length > 1 && ws.layout == null && typeof ws.id === "string" && ws.id)
        details = await this.cmuxJson(exe, ["list-panes", "--workspace", ws.id], deadline);
      const converted =
        shallow && !Array.isArray(ws?.panes) && !Array.isArray(ws?.surfaces)
          ? cmux_import.workspaceOnly(ws, "Couldn't read its panes or tabs")
          : cmux_import.convert(ws, details);
      if (!converted) {
        this.catalog.confused = true;
        continue;
      }
      if (converted.recovery !== "full") this.catalog.confused = true;
      const identified = ["id", "ref", "workspace_id"].some(k => typeof ws?.[k] === "string" && ws[k]);
      if (!identified || !out.some(w => w.id === converted.id)) out.push(converted);
    }
  }
  async cmux() {
    const exe = cmuxExecutable(),
      deadline = Date.now() + 15000,
      out: Workspace[] = [],
      snapshot = await this.cmuxJson(exe, ["tree", "--all"], deadline);
    let known = false;
    if (Array.isArray(snapshot?.windows)) {
      known = true;
      for (const window of snapshot.windows) {
        if (Array.isArray(window?.workspaces)) await this.cmuxEntries(exe, window.workspaces, false, out, deadline);
        else {
          this.catalog.confused = true;
          if (typeof window?.id === "string" && window.id) {
            const listed = await this.cmuxJson(exe, ["list-workspaces", "--window", window.id], deadline);
            if (Array.isArray(listed?.workspaces)) await this.cmuxEntries(exe, listed.workspaces, true, out, deadline);
            else known = false;
          } else known = false;
        }
      }
    } else if (Array.isArray(snapshot?.workspaces)) {
      known = true;
      await this.cmuxEntries(exe, snapshot.workspaces, false, out, deadline);
    }
    if (!out.length && this.catalog.confused) known = false;
    if (!known) {
      this.catalog.confused = true;
      const windows = await this.cmuxJson(exe, ["list-windows"], deadline);
      let all = false;
      if (Array.isArray(windows?.windows)) {
        all = true;
        for (const window of windows.windows) {
          if (typeof window?.id !== "string" || !window.id) {
            all = false;
            continue;
          }
          const listed = await this.cmuxJson(exe, ["list-workspaces", "--window", window.id], deadline);
          if (Array.isArray(listed?.workspaces)) await this.cmuxEntries(exe, listed.workspaces, true, out, deadline);
          else all = false;
        }
      }
      if (!all) {
        const listed = await this.cmuxJson(exe, ["list-workspaces"], deadline);
        if (Array.isArray(listed?.workspaces)) await this.cmuxEntries(exe, listed.workspaces, true, out, deadline);
      }
    }
    this.catalog.workspaces = out;
    this.catalog.message =
      this.catalog.confused && !out.length
        ? "Couldn't read the workspace list. R refreshes."
        : "Visible splits first; remaining surfaces become additional tabs.";
  }
}
function cmuxExecutable(): string {
  const found = Bun.which("cmux");
  if (found) return found;
  if (process.platform === "darwin")
    for (const path of [
      process.env.HOME ? join(process.env.HOME, "Applications/cmux.app/Contents/Resources/bin/cmux") : "",
      "/Applications/cmux.app/Contents/Resources/bin/cmux",
    ])
      try {
        accessSync(path, constants.X_OK);
        return path;
      } catch {}
  throw Error("CmuxNotFound");
}
