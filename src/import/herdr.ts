//! Herdr read-only discovery and copy transactions.
import { createConnection } from "node:net";
import { readdirSync, statSync, mkdirSync, writeFileSync, rmSync, readlinkSync } from "node:fs";
import { join, isAbsolute, basename } from "node:path";
import { Runtime, Pane, Create } from "../runtime";
import { Model, Tab, max_panes } from "../layout";
import { ResumeHint } from "../resume_hint";
import { Text } from "../providers";
import { label } from "../pane/label";
export type SourcePane = {
  id: string;
  name: string;
  cwd: string;
  pid: number | null;
  resume_hint: ResumeHint;
};
export type SourceTab = {
  id: string;
  name: string;
  panes: SourcePane[];
  root: any;
};
export type SourceWorkspace = {
  id: string;
  name: string;
  cwd: string;
  tabs: SourceTab[];
};
export type SourceSession = {
  socket: string;
  name: string;
  live_handoff: boolean;
  workspaces: SourceWorkspace[];
};
export class Scan {
  constructor(public sessions: SourceSession[]) {}
  deinit() {
    this.sessions = [];
  }
}
const text = (v: any, k: string): string => (typeof v?.[k] === "string" ? v[k] : "");
const list = (v: any): any[] => (Array.isArray(v) ? v : []);
function resumeRef(value: any): ResumeHint {
  const out = new ResumeHint();
  if (
    value?.kind !== "id" ||
    !["codex", "claude"].includes(value.agent) ||
    typeof value.value !== "string" ||
    !value.value ||
    /[\x00-\x1f\x7f]/.test(value.value)
  )
    return out;
  if (Buffer.byteLength(value.value) > 128) return out;
  out.provider = value.agent;
  out.session = new Text(value.value);
  return out;
}
export function socketCandidates(): { path: string; name: string }[] {
  const paths: { path: string; name: string }[] = [];
  if (process.env.HERDR_SOCKET_PATH) paths.push({ path: process.env.HERDR_SOCKET_PATH, name: "Herdr" });
  const root = process.env.XDG_CONFIG_HOME ?? (process.env.HOME ? join(process.env.HOME, ".config") : null);
  if (!root) throw Error("NoHome");
  for (const app of ["herdr", "herdr-dev"]) {
    const dir = join(root, app);
    paths.push({ path: join(dir, "herdr.sock"), name: app });
    try {
      for (const entry of readdirSync(join(dir, "sessions"), {
        withFileTypes: true,
      }))
        if (entry.isDirectory() && paths.length < 64)
          paths.push({
            path: join(dir, "sessions", entry.name, "herdr.sock"),
            name: entry.name,
          });
    } catch {}
  }
  return paths;
}
export function detected(): boolean {
  if (Bun.which("herdr")) return true;
  try {
    return socketCandidates().some(candidate => {
      try {
        return statSync(candidate.path).isSocket();
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}
export function rpc(socket: string, method: string, params: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const connection = createConnection(socket);
    let bytes = Buffer.alloc(0),
      done = false;
    const finish = (error: Error | null, value?: any) => {
      if (done) return;
      done = true;
      connection.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    connection.setTimeout(3000, () => finish(Error("HerdrTimedOut")));
    connection.on("error", () => finish(Error("HerdrReadFailed")));
    connection.on("end", () => finish(Error("HerdrDisconnected")));
    connection.on("connect", () => connection.write(JSON.stringify({ id: "corgi:onboarding", method, params }) + "\n"));
    connection.on("data", chunk => {
      bytes = Buffer.concat([bytes, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      if (bytes.length > 16 * 1024 * 1024) {
        finish(Error("HerdrMessageTooLarge"));
        return;
      }
      const end = bytes.indexOf(10);
      if (end < 0) return;
      try {
        const value = JSON.parse(bytes.subarray(0, end).toString());
        if (value.error != null) throw Error("HerdrRequestFailed");
        if (!value.result || typeof value.result !== "object" || Array.isArray(value.result))
          throw Error("InvalidHerdrResponse");
        finish(null, value.result);
      } catch (error) {
        finish(error as Error);
      }
    });
  });
}
export async function scan(): Promise<Scan> {
  return scanCancelable();
}
export async function scanCancelable(cancel: () => boolean = () => false): Promise<Scan> {
  const deadline = Date.now() + 15000,
    sessions: SourceSession[] = [],
    seen = new Set<string>();
  for (const candidate of socketCandidates()) {
    if (cancel() || Date.now() >= deadline) break;
    if (seen.has(candidate.path)) continue;
    seen.add(candidate.path);
    try {
      sessions.push(await scanSession(candidate.path, candidate.name, cancel, deadline));
    } catch {}
  }
  return new Scan(sessions);
}
async function scanSession(
  socket: string,
  name: string,
  cancel: () => boolean,
  deadline: number,
): Promise<SourceSession> {
  const pong = await rpc(socket, "ping", {}),
    snapshot = (await rpc(socket, "session.snapshot", {})).snapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw Error("InvalidHerdrResponse");
  const workspaces: SourceWorkspace[] = [];
  for (const ws of list(snapshot.workspaces)) {
    const wsId = text(ws, "workspace_id"),
      tabs: SourceTab[] = [];
    let cwd = "";
    for (const tab of list(snapshot.tabs)) {
      if (cancel() || Date.now() >= deadline) throw Error("HerdrDiscoveryCancelled");
      if (text(tab, "workspace_id") !== wsId) continue;
      const tabId = text(tab, "tab_id"),
        panes: SourcePane[] = [];
      for (const pane of list(snapshot.panes)) {
        if (cancel() || Date.now() >= deadline) throw Error("HerdrDiscoveryCancelled");
        if (text(pane, "tab_id") !== tabId) continue;
        const paneId = text(pane, "pane_id"),
          dir = text(pane, "foreground_cwd") || text(pane, "cwd");
        if (!cwd) cwd = dir;
        let name = text(pane, "label") || text(pane, "agent") || text(pane, "terminal_title_stripped");
        const process = (await rpc(socket, "pane.process_info", { pane_id: paneId }).catch(() => null))?.process_info;
        let pid = 0;
        for (const foreground of list(process?.foreground_processes)) {
          if (pid <= 0) pid = typeof foreground.pid === "number" ? foreground.pid : 0;
          if (!name) name = text(foreground, "name");
        }
        if (pid <= 0) pid = typeof process?.shell_pid === "number" ? process.shell_pid : 0;
        panes.push({
          id: paneId,
          name: name || "Terminal",
          cwd: dir,
          pid: pid > 0 && pid <= 2147483647 ? pid : null,
          resume_hint: resumeRef(pane.agent_session),
        });
      }
      const root = (await rpc(socket, "layout.export", { tab_id: tabId }))?.layout?.root;
      if (!root || typeof root !== "object" || Array.isArray(root)) throw Error("InvalidHerdrLayout");
      tabs.push({ id: tabId, name: text(tab, "label"), panes, root });
    }
    workspaces.push({ id: wsId, name: text(ws, "label"), cwd, tabs });
  }
  return {
    socket,
    name,
    live_handoff: pong?.capabilities?.live_handoff === true,
    workspaces,
  };
}
export function clearTree(model: Model, index: number): void {
  const node = model.nodes[index];
  if (!node) return;
  if ("split" in node) {
    clearTree(model, node.split.first);
    clearTree(model, node.split.second);
  }
  model.nodes[index] = null;
}
export function ratio(value: any): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(100, Math.min(900, Math.trunc(value * 1000)))
    : 500;
}
export function copiedTree(
  model: Model,
  node: any,
  sources: SourcePane[],
  ids: number[],
  used: boolean[],
  depth = 0,
): number {
  if (depth > max_panes) throw Error("InvalidHerdrLayout");
  if (node?.type === "pane") {
    const i = sources.findIndex(source => node.pane_id === source.id);
    if (i < 0) throw Error("InvalidHerdrLayout");
    if (used[i]) throw Error("DuplicateHerdrPane");
    used[i] = true;
    return model.alloc({ pane: ids[i] });
  }
  if (node?.type !== "split" || !["right", "down"].includes(node.direction)) throw Error("InvalidHerdrLayout");
  return model.alloc({
    split: {
      axis: node.direction === "right" ? "horizontal" : "vertical",
      ratio: ratio(node.ratio),
      first: copiedTree(model, node.first, sources, ids, used, depth + 1),
      second: copiedTree(model, node.second, sources, ids, used, depth + 1),
    },
  });
}
export async function copy(r: Runtime, source: SourceSession, selected: string[], defaults: Create): Promise<number> {
  const oldLength = r.workspaces.items.length,
    oldPanes = r.panes.length;
  let first = 0;
  try {
    for (const ws of source.workspaces) {
      if (!selected.includes(ws.id)) continue;
      const wid = await r.workspaces.add(ws.name, ws.cwd || defaults.cwd);
      if (!first) first = wid;
      for (const tab of ws.tabs) await copyTab(r, tab, { ...defaults, workspace: wid, title: tab.name });
    }
    if (!first) throw Error("NothingSelected");
    r.changed();
    return first;
  } catch (error) {
    while (r.panes.length > oldPanes) {
      const p = r.panes.pop()!;
      r.stopShell(p.terminal);
      p.terminal.destroy();
    }
    r.workspaces.items.length = oldLength;
    r.changed();
    throw error;
  }
}
async function copyTab(r: Runtime, tab: SourceTab, defaults: Create) {
  if (!tab.panes.length || tab.panes.length > max_panes) throw Error("InvalidHerdrLayout");
  const ids: number[] = [];
  for (const source of tab.panes) {
    const id = await r.create({
      ...defaults,
      cwd: source.cwd || defaults.cwd,
      command: null,
      interactive_command: false,
      split: ids.length ? { pane: ids[0], axis: "horizontal" } : null,
    });
    ids.push(id);
    const pane = r.pane(id)!;
    pane.label = label(source.name);
    const saved = source.resume_hint as any;
    pane.resume_hint = new ResumeHint();
    pane.resume_hint.provider = saved?.provider ?? null;
    pane.resume_hint.touched_at = saved?.touched_at ?? 0;
    const hintText = (value: any): string => (typeof value === "string" ? value : (value?.value ?? ""));
    pane.resume_hint.name = new Text(hintText(saved?.name));
    pane.resume_hint.session = new Text(hintText(saved?.session));
    const command = pane.resume_hint.command();
    if (command) pane.terminal.feed("\r\n# Resume your imported agent when ready:\r\n# " + command + "\r\n");
  }
  const ws = r.getWorkspace(defaults.workspace),
    index = ws.model.tabForPane(ids[0]);
  if (index === null) throw Error("InvalidHerdrLayout");
  const model = Model.fromData(ws.model.toJSON());
  clearTree(model, model.tabs[index].root);
  const used = ids.map(() => false);
  model.tabs[index].root = copiedTree(model, tab.root, tab.panes, ids, used);
  if (used.some(value => !value)) throw Error("UnmappedHerdrTerminal");
  model.revision = BigInt.asUintN(64, model.revision + 1n);
  ws.model = model;
}
export function restoreTree(model: Model, node: any, states: any[], seen: boolean[], depth = 0): number {
  if (depth > max_panes) throw Error("InvalidHerdrLayout");
  if (Number.isInteger(node?.Pane)) {
    if (node.Pane < 0 || node.Pane > 0xffffffff) throw Error("InvalidHerdrLayout");
    const index = states.findIndex(state => state.pane_id === node.Pane);
    if (index < 0) throw Error("InvalidHerdrLayout");
    if (seen[index]) throw Error("DuplicateHerdrPane");
    seen[index] = true;
    return model.alloc({ pane: index + 1 });
  }
  const split = node?.Split;
  if (!split || !["Horizontal", "Vertical"].includes(split.direction)) throw Error("InvalidHerdrLayout");
  return model.alloc({
    split: {
      axis: split.direction === "Horizontal" ? "horizontal" : "vertical",
      ratio: ratio(split.ratio),
      first: restoreTree(model, split.first, states, seen, depth + 1),
      second: restoreTree(model, split.second, states, seen, depth + 1),
    },
  });
}
export function seedTerminal(terminal: import("../pane/terminal").Terminal, state: any): void {
  terminal.restore(Buffer.from(text(state, "initial_history_ansi")));
  const input = state?.input_state;
  const modes: Record<string, string> = {
    alternate_screen: "\x1b[?1049h",
    application_cursor: "\x1b[?1h",
    bracketed_paste: "\x1b[?2004h",
    focus_reporting: "\x1b[?1004h",
    mouse_alternate_scroll: "\x1b[?1007h",
    modify_other_keys: "\x1b[>4;2m",
    color_scheme_reporting: "\x1b[?2031h",
  };
  for (const [key, value] of Object.entries(modes)) if (input?.[key] === true) terminal.restore(Buffer.from(value));
  const mouse: Record<string, string> = {
      press: "\x1b[?9h",
      press_release: "\x1b[?1000h",
      button_motion: "\x1b[?1002h",
      any_motion: "\x1b[?1003h",
    },
    encoding: Record<string, string> = {
      utf8: "\x1b[?1005h",
      sgr: "\x1b[?1006h",
      sgr_pixels: "\x1b[?1016h",
    };
  if (mouse[input?.mouse_protocol_mode]) terminal.restore(Buffer.from(mouse[input.mouse_protocol_mode]));
  if (encoding[input?.mouse_protocol_encoding]) terminal.restore(Buffer.from(encoding[input.mouse_protocol_encoding]));
  const keyboard = text(state, "keyboard_protocol_ansi");
  if (keyboard) terminal.restore(Buffer.from(keyboard));
  else if (
    Number.isInteger(state?.keyboard_protocol_flags) &&
    state.keyboard_protocol_flags > 0 &&
    state.keyboard_protocol_flags <= 65535
  )
    terminal.restore(Buffer.from(`\x1b[>${state.keyboard_protocol_flags}u`));
  const title = text(state, "terminal_title");
  if (title) terminal.restore(Buffer.from("\x1b]2;" + title.replace(/[\x00-\x1f\x7f]/g, "") + "\x1b\\"));
}

import { randomBytes } from "node:crypto";
import { Workspace, max_workspaces } from "../workspace";
import { Terminal } from "../pane/terminal";
import { n, ptr } from "../native_ffi";
import { ReadyLoop, READ, WRITE, wouldBlock } from "../fd_loop";
type Phase = "idle" | "connecting" | "receiving" | "preparing" | "committing" | "complete" | "failed";
class SocketIO {
  registration: ReturnType<ReadyLoop["watch"]>;
  constructor(
    public fd: number,
    loop: ReadyLoop,
  ) {
    this.registration = loop.watch(fd, () => this.wake?.());
  }
  wake: (() => void) | null = null;
  abortWait: (() => void) | null = null;
  closed = false;
  wait(events: number, until: number): Promise<void> {
    if (this.closed) return Promise.reject(Error("HerdrDisconnected"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.wake = null;
          this.abortWait = null;
          reject(Error("HerdrTimedOut"));
        },
        Math.max(0, until - Date.now()),
      );
      this.abortWait = () => {
        clearTimeout(timer);
        this.wake = null;
        this.abortWait = null;
        reject(Error("HerdrDisconnected"));
      };
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        this.abortWait = null;
        resolve();
      };
      this.registration.arm(events);
    });
  }
  async write(text: string) {
    const bytes = Buffer.from(text);
    let offset = 0;
    const until = Date.now() + 35000;
    while (offset < bytes.length) {
      const chunk = bytes.subarray(offset),
        count = n.probe_write(this.fd, ptr(chunk), chunk.length);
      if (count > 0) offset += count;
      else if (count === -4) continue;
      else if (wouldBlock(count)) await this.wait(WRITE, until);
      else throw Error("HerdrReadFailed");
    }
  }
  async line(limit: number, until = Date.now() + 35000): Promise<string> {
    const out: Buffer[] = [];
    let used = 0;
    while (used < limit) {
      const buffer = Buffer.alloc(Math.min(8192, limit - used)),
        peek = n.probe_peek(this.fd, ptr(buffer), buffer.length);
      if (peek === 0) throw Error("HerdrDisconnected");
      if (peek < 0) {
        if (peek === -4) continue;
        if (wouldBlock(peek)) {
          await this.wait(READ, until);
          continue;
        }
        throw Error("HerdrReadFailed");
      }
      const bytes = buffer.subarray(0, peek),
        end = bytes.indexOf(10),
        count = end < 0 ? peek : end + 1;
      let read = 0;
      while (read < count) {
        const chunk = buffer.subarray(read, count),
          got = n.probe_read(this.fd, ptr(chunk), chunk.length);
        if (got > 0) read += got;
        else if (got === -4) continue;
        else if (wouldBlock(got)) await this.wait(READ, until);
        else throw Error("HerdrDisconnected");
      }
      out.push(buffer.subarray(0, count - (end >= 0 ? 1 : 0)));
      used += count;
      if (end >= 0) return Buffer.concat(out).toString();
    }
    throw Error("HerdrMessageTooLarge");
  }
  async receive(count: number): Promise<number[]> {
    const fds = new Int32Array(count),
      until = Date.now() + 35000;
    for (;;) {
      const got = n.probe_recv(this.fd, ptr(fds), count);
      if (got === count) return [...fds];
      if (got >= 0) {
        for (const fd of fds.subarray(0, got)) n.probe_close(fd);
        throw Error("InvalidHerdrDescriptors");
      }
      if (got === -4) continue;
      if (wouldBlock(got)) {
        await this.wait(READ, until);
        continue;
      }
      throw Error("InvalidHerdrDescriptors");
    }
  }
  async send(fd: number) {
    const fds = new Int32Array([fd]),
      until = Date.now() + 60000;
    for (;;) {
      const result = n.probe_send(this.fd, ptr(fds), 1);
      if (result === 0) return;
      if (result === -4) continue;
      if (wouldBlock(result)) {
        await this.wait(WRITE, until);
        continue;
      }
      throw Error("HerdrReadFailed");
    }
  }
  close() {
    this.closed = true;
    this.abortWait?.();
    this.registration.close();
    n.probe_close(this.fd);
  }
}
function connect(path: string, loop: ReadyLoop): SocketIO {
  const fd = n.probe_connect(Buffer.from(path + "\0"));
  if (fd < 0) throw Error("HerdrReadFailed");
  return new SocketIO(fd, loop);
}
export class Manager {
  job: Job | null = null;
  start(source: string, executable: string, theme: any, viewer_pgid: number | null = null): void {
    if (this.job) {
      if (!["complete", "failed"].includes(this.job.phase) || (this.job.phase === "complete" && !this.job.adopted))
        throw Error("HandoffInProgress");
      this.deinit();
    }
    this.job = new Job(source, executable, theme, viewer_pgid);
    void this.job.run();
  }
  locked() {
    return !!this.job?.reserved && !this.job.adopted;
  }
  busy() {
    return this.active();
  }
  active() {
    return !["idle", "failed", "complete"].includes(this.status().phase);
  }
  status() {
    const job = this.job;
    if (!job)
      return {
        phase: "idle",
        completed: 0,
        total: 0,
        workspace: null,
        message: "",
      };
    const phase = job.phase === "complete" && !job.adopted ? "committing" : job.phase;
    const messages: Record<string, string> = {
      connecting: "Connecting to Herdr",
      receiving: "Receiving live terminals",
      preparing: "Preparing your workspaces",
      committing: job.uncertain ? "Waiting for Herdr ownership confirmation" : "Moving terminal ownership",
      complete: "Processes are running in Corgi",
    };
    return {
      phase,
      completed: phase === "complete" ? job.total : 0,
      total: job.total,
      workspace: job.adopted ? job.first_workspace : null,
      message: phase === "failed" ? job.failure : (messages[phase] ?? ""),
    };
  }
  tick(runtime: Runtime): boolean {
    const job = this.job;
    if (!job) return false;
    if (job.phase === "preparing" && !job.reserved && !job.cancel) {
      try {
        job.prepare(runtime);
        job.reserved = true;
        job.approve?.();
      } catch (error) {
        job.preparation_failure = (error as Error).message;
        job.cancel = true;
        job.approve?.();
        return false;
      }
    }
    if (job.phase === "complete" && !job.adopted) {
      for (const [i, pane] of job.staged.panes.entries()) {
        pane.terminal.imported = true;
        pane.terminal.adopt(job.fds[i], job.pids[i]);
        job.fds[i] = -1;
        runtime.panes.push(pane);
      }
      runtime.workspaces.items.push(...job.staged.workspaces.items);
      job.staged.panes = [];
      job.staged.workspaces.items = [];
      job.adopted = true;
      runtime.changed();
      return true;
    }
    if (job.phase === "failed") job.reserved = false;
    return false;
  }
  deinit() {
    const job = this.job;
    if (!job) return;
    job.cancel = true;
    job.approve?.();
    if (job.phase === "complete" && !job.adopted && job.target) this.tick(job.target);
    if (!job.running) job.cleanup();
    this.job = null;
  }
}
export class Job {
  phase: Phase = "connecting";
  total = 0;
  cancel = false;
  uncertain = false;
  failure = "";
  preparation_failure = "";
  staged = new Runtime();
  fds: number[] = [];
  pids: number[] = [];
  reserved = false;
  adopted = false;
  first_workspace: number | null = null;
  target: Runtime | null = null;
  running = false;
  approve: (() => void) | null = null;
  constructor(
    public source: string,
    public executable: string,
    public theme: any,
    public viewer_pgid: number | null,
  ) {}
  async run() {
    this.running = true;
    try {
      await this.transfer();
    } catch (error) {
      this.failure = this.cancel ? this.preparation_failure || (error as Error).message : (error as Error).message;
      for (const fd of this.fds) if (fd >= 0) n.probe_close(fd);
      this.fds = [];
      this.phase = "failed";
    } finally {
      this.running = false;
      if (this.cancel) {
        if (this.phase === "complete" && !this.adopted && this.target) {
          const manager = new Manager();
          manager.job = this;
          manager.tick(this.target);
        }
        this.cleanup();
      }
    }
  }
  cleanup() {
    if (this.phase === "complete" && !this.adopted) return;
    this.staged.deinit();
    for (const fd of this.fds) if (fd >= 0) n.probe_close(fd);
    this.fds = [];
  }
  prepare(runtime: Runtime) {
    if (runtime.panes.length + this.staged.panes.length > max_panes) throw Error("TooManyPanes");
    if (
      runtime.workspaces.items.length + this.staged.workspaces.items.length > max_workspaces ||
      runtime.workspaces.next_id > 0xffffffff - this.staged.workspaces.items.length
    )
      throw Error("TooManyWorkspaces");
    const offset = runtime.workspaces.next_pane_id;
    if (offset > 0xffffffff - this.staged.workspaces.next_pane_id) throw Error("TooManyPanes");
    for (const pane of this.staged.panes) {
      pane.id += offset;
      const hint = pane.resume_hint;
      if (hint.provider && hint.session.len) {
        const actor = runtime.conversations.get(hint.provider, hint.session.text());
        if (actor.state.last_seq === 0 && actor.state.state === "unknown") {
          actor.state.state = pane.attachment.provisional.state;
          actor.state.observation.source = "screen";
        }
        pane.attachment.select(actor);
      }
    }
    for (const ws of this.staged.workspaces.items) {
      ws.id = runtime.workspaces.next_id++;
      this.first_workspace ??= ws.id;
      for (const node of ws.model.nodes) if (node && "pane" in node) node.pane += offset;
      for (const tab of ws.model.tabs) tab.id += offset;
      ws.model.next_id += offset;
    }
    runtime.workspaces.next_pane_id = offset + this.staged.workspaces.next_pane_id;
    this.target = runtime;
  }
  restoreManifest(manifest: any) {
    const snapshots = list(manifest?.snapshot?.workspaces),
      states = list(manifest?.panes);
    if (!snapshots.length || snapshots.length > max_workspaces) throw Error("TooManyWorkspaces");
    if (!states.length || states.length > max_panes) throw Error("TooManyPanes");
    const seen = states.map(() => false);
    for (const [i, state] of states.entries()) {
      if (!Number.isInteger(state.child_pid) || state.child_pid <= 0 || state.child_pid > 2147483647)
        throw Error("InvalidHerdrProcess");
      this.pids.push(state.child_pid);
      if (
        !Number.isInteger(state.cols) ||
        !Number.isInteger(state.rows) ||
        state.cols < 1 ||
        state.cols > 4096 ||
        state.rows < 1 ||
        state.rows > 4096
      )
        throw Error("InvalidHerdrTerminalSize");
      if (!Number.isInteger(state.pane_id) || state.pane_id < 0 || state.pane_id > 0xffffffff)
        throw Error("InvalidHerdrLayout");
      if (states.slice(0, i).some(other => other.pane_id === state.pane_id)) throw Error("DuplicateHerdrPane");
      const terminal = Terminal.create(state.cols, state.rows);
      terminal.applyTheme(this.theme);
      seedTerminal(terminal, state);
      this.staged.panes.push(new Pane(i + 1, terminal, "/"));
    }
    this.staged.workspaces.next_pane_id = states.length + 1;
    for (const snapshot of snapshots) {
      const cwd = text(snapshot, "identity_cwd");
      if (!isAbsolute(cwd)) throw Error("InvalidHerdrDirectory");
      const ws = new Workspace(this.staged.workspaces.next_id++, cwd);
      ws.rename(text(snapshot, "custom_name"));
      const tabs = list(snapshot.tabs);
      if (!tabs.length) throw Error("InvalidHerdrLayout");
      for (const tab of tabs) {
        const root = restoreTree(ws.model, tab.layout, states, seen),
          out = new Tab(this.staged.workspaces.next_pane_id++, root);
        out.rename(text(tab, "custom_name"));
        ws.model.tabs.push(out);
        ws.model.count++;
        if (!tab.panes || typeof tab.panes !== "object" || Array.isArray(tab.panes)) throw Error("InvalidHerdrLayout");
        for (const [key, value] of Object.entries(tab.panes) as [string, any][]) {
          if (!/^\d+$/.test(key) || Number(key) > 0xffffffff) throw Error("InvalidCharacter");
          const index = states.findIndex(state => state.pane_id === Number(key));
          if (index < 0) throw Error("InvalidHerdrLayout");
          const pane = this.staged.panes[index],
            dir = text(value, "cwd");
          if (!isAbsolute(dir)) throw Error("InvalidHerdrDirectory");
          pane.cwd = dir;
          pane.label = label(text(value, "label"));
          pane.resume_hint = resumeRef(value.agent_session);
          const status = text(states[index]?.agent_state?.authority, "state");
          pane.attachment.provisional.provider = pane.resume_hint.provider;
          pane.attachment.provisional.state =
            ({ Working: "working", Blocked: "blocked", Idle: "idle" } as any)[status] ?? "unknown";
          pane.attachment.provisional.observation.source = "screen";
        }
      }
      ws.model.next_id = this.staged.workspaces.next_pane_id;
      this.staged.workspaces.items.push(ws);
    }
    if (seen.some(value => !value)) throw Error("UnmappedHerdrTerminal");
  }
  async transfer() {
    const pong = await rpc(this.source, "ping", {});
    if (pong?.capabilities?.live_handoff !== true) throw Error("HerdrHandoffUnsupported");
    const dir = `/tmp/corgi-${process.getuid?.() ?? 0}/herdr-${randomBytes(8).toString("hex")}`;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, "bridge.sock"),
      launcher = join(dir, "import"),
      token = randomBytes(16).toString("hex"),
      loop = new ReadyLoop();
    let listener = -1,
      request: SocketIO | null = null,
      bridge: SocketIO | null = null,
      source: SocketIO | null = null;
    try {
      listener = n.probe_listen(Buffer.from(path + "\0"));
      if (listener < 0) throw Error("HandoffSocketSetupFailed");
      n.probe_nonblock(listener);
      const shellQuote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
      writeFileSync(
        launcher,
        `#!/bin/sh\nexec ${shellQuote(this.executable)} __herdr_import ${shellQuote(path)} ${shellQuote(token)} "$@"\n`,
        { mode: 0o700, flag: "wx" },
      );
      request = connect(this.source, loop);
      await request.write(
        JSON.stringify({
          id: "corgi:handoff",
          method: "server.live_handoff",
          params: { import_exe: launcher },
        }) + "\n",
      );
      bridge = await this.accept(listener, request, loop);
      if ((await bridge.line(256)) !== token) throw Error("InvalidHandoffToken");
      const donor = Number(await bridge.line(32));
      if (!Number.isInteger(donor) || donor <= 1) throw Error("InvalidHerdrProcess");
      source = new SocketIO((await bridge.receive(1))[0], loop);
      this.phase = "receiving";
      const manifest = JSON.parse(await source.line(16 * 1024 * 1024));
      if (manifest.version !== 1 || manifest.expected_version != null || manifest.expected_protocol != null)
        throw Error("UnsupportedHerdrManifest");
      this.restoreManifest(manifest);
      this.total = this.staged.panes.length;
      await source.write("validated\n");
      this.fds = await source.receive(this.total);
      for (const [i, fd] of this.fds.entries()) {
        if (n.probe_isatty(fd) !== 1) throw Error("InvalidHerdrTerminalDescriptor");
        const foreground = n.probe_foreground(fd);
        if (this.viewer_pgid && foreground === this.viewer_pgid) throw Error("CannotHandoffCurrentConsole");
        try {
          const path = readlinkSync(`/proc/${foreground}/exe`);
          if (path === this.executable || basename(path) === "corgi") throw Error("CannotHandoffCurrentConsole");
        } catch (error) {
          if ((error as Error).message === "CannotHandoffCurrentConsole") throw error;
        }
        if (foreground > 0) {
          this.staged.panes[i].detection.pid = foreground;
          this.staged.panes[i].detection.ready = this.staged.panes[i].attachment.provisional.state !== "unknown";
        }
      }
      this.phase = "preparing";
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error("HandoffPreparationTimedOut")), 15000);
        this.approve = () => {
          clearTimeout(timer);
          this.approve = null;
          resolve();
        };
      });
      if (this.cancel) throw Error("HandoffCancelled");
      this.phase = "committing";
      await source.write("restored\nready\n");
      await this.waitCommitted(source, request, donor);
      this.phase = "complete";
      await source.write("owned\n").catch(() => {});
      await bridge.write("done\n").catch(() => {});
    } finally {
      source?.close();
      bridge?.close();
      request?.close();
      if (listener >= 0) n.probe_close(listener);
      loop.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
  async accept(listener: number, request: SocketIO, loop: ReadyLoop): Promise<SocketIO> {
    return new Promise((resolve, reject) => {
      const until = Date.now() + 35000;
      const watching = loop.watch(listener, check),
        requestWatch = loop.watch(request.fd, () => finish(Error("HerdrHandoffRejected")));
      let timer: ReturnType<typeof setTimeout>;
      const finish = (error: Error | null, fd?: number) => {
        clearTimeout(timer);
        watching.close();
        requestWatch.close();
        if (error) reject(error);
        else resolve(new SocketIO(fd!, loop));
      };
      function check() {
        const fd = n.probe_accept(listener);
        if (fd >= 0) finish(null, fd);
        else if (wouldBlock(fd) || fd === -4) watching.arm(READ);
        else finish(Error("HandoffImporterTimedOut"));
      }
      timer = setTimeout(() => finish(Error("HandoffImporterTimedOut")), Math.max(0, until - Date.now()));
      watching.arm(READ);
      requestWatch.arm(READ);
    });
  }
  async waitCommitted(source: SocketIO, request: SocketIO, donor: number) {
    let sourceClosed = false,
      requestClosed = false,
      rollback = false;
    const sourceReply = source.line(64, Date.now() + 86400000).then(
      line => {
        if (line === "committed") return true;
        sourceClosed = true;
        return false;
      },
      () => {
        sourceClosed = true;
        return false;
      },
    );
    const requestReply = request.line(16384, Date.now() + 86400000).then(
      line => {
        try {
          const value = JSON.parse(line);
          if (value.error != null) {
            rollback = true;
            throw Error("HerdrHandoffRolledBack");
          }
          if (value.result?.type === "ok") return true;
        } catch (error) {
          if (rollback) throw error;
        }
        requestClosed = true;
        return false;
      },
      () => {
        requestClosed = true;
        return false;
      },
    );
    let pending = [sourceReply, requestReply];
    while (pending.length) {
      const settled = await Promise.race(pending.map((p, i) => p.then(value => ({ value, i }))));
      if (settled.value) return;
      pending.splice(settled.i, 1);
      this.uncertain = true;
    }
    while (sourceClosed && requestClosed) {
      try {
        process.kill(donor, 0);
      } catch (error) {
        if ((error as any).code === "ESRCH") return;
      }
      try {
        await rpc(this.source, "session.snapshot", {});
        throw Error("HerdrHandoffRolledBack");
      } catch (error) {
        if ((error as Error).message === "HerdrHandoffRolledBack") throw error;
      }
      await Bun.sleep(1000);
    }
  }
}
export async function importBridge(args: string[]): Promise<void> {
  if (args.length !== 6 || args[2] !== "server" || args[3] !== "--handoff-import")
    throw Error("InvalidHerdrImporterArguments");
  const loop = new ReadyLoop();
  let bridge: SocketIO | null = null,
    source: SocketIO | null = null;
  try {
    bridge = connect(args[0], loop);
    source = connect(args[4], loop);
    await source.write(args[5] + "\n");
    await bridge.write(args[1] + "\n" + process.ppid + "\n");
    await bridge.send(source.fd);
    if ((await bridge.line(64, Date.now() + 60000)) !== "done") throw Error("HandoffNotCommitted");
  } finally {
    source?.close();
    bridge?.close();
    loop.close();
  }
}
