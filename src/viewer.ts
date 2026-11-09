import type { State as ClipboardState } from "./host_clipboard";
import * as composition from "./composition";
import * as telemetry from "./telemetry";
//! Each invocation owns its UI, local selections, and input parser. The daemon
//! sends shared session organization and terminal surfaces, never Corgi frames.
//! Mirrors viewer.zig.
import * as docking from "./docking";
import { max_panes } from "./layout";
import { dirname, join } from "node:path";
import { Controller } from "./controller";
import type { Machine } from "./machine";
import { call, unread, acknowledge } from "./mirror";
import { parse as parseAction } from "./action";
import * as terminal_info from "./terminal_info";
import { Differ } from "./frame_diff";
import * as framePacing from "./frame_pacing";
import * as sound from "./sound";
import { sshViewer } from "./trackers/ports";
import type { Reply, RequestInput } from "./protocol";
import * as protocol from "./protocol";
import { n, ptr } from "./native_ffi";
export { Controller as View };

export async function open(
  view: Controller,
  cwd: string,
  theme: RequestInput<"viewer.open">["theme"],
): Promise<bigint> {
  return openMode(view, cwd, theme, false);
}
export async function openMode(
  view: Controller,
  cwd: string,
  theme: RequestInput<"viewer.open">["theme"],
  start_onboarding: boolean,
): Promise<bigint> {
  const machine = view.machine,
    navigation = machine.navigation;
  view.start_folder = cwd;
  view.remote_links = !!view.connection.remote || sshViewer();
  view.offerOnboarding();
  if (view.connection.remote && view.onboarding) {
    view.onboarding.close();
    view.onboarding = null;
  }
  if (start_onboarding) view.openOnboarding("welcome");
  let opened: Reply<"viewer.open">;
  try {
    opened = await call(machine.connection, "viewer.open", {
      cwd,
      theme,
      onboarding: view.onboarding !== null,
      pid: process.pid,
    });
  } catch (error) {
    throw incompatible(error as Error);
  }
  if (machine.navigation === navigation && navigation.revision === 0) navigation.workspace_id = opened.workspace;
  if (view.machine === machine) view.input_state.attached = true;
  await view.refresh(machine);
  if (view.machine !== machine) return BigInt(opened.bell_seq ?? 0n);
  if (
    machine.navigation === navigation &&
    navigation.revision === 0 &&
    opened.focus &&
    view.runtime.workspaces.owner(opened.focus)
  )
    view.focusPane(opened.focus);
  view.restoreAgentScroll();
  view.launch_previews.connect(view.connection);
  view.launch_previews.changedEvent = () => {
    view.dirty = true;
    view.wake();
  };
  view.updateLaunchPreview();
  return BigInt(opened.bell_seq ?? 0n);
}
/** A daemon on another protocol is one error, which `main` explains. */
function incompatible(error: Error): Error {
  return ["UnsupportedViewerProtocol", "UnsupportedProtocol", "ProtocolRequired"].includes(error.message)
    ? Error("IncompatibleViewerProtocol")
    : error;
}
export function close(view: Controller): void {
  view.closePreferences?.();
  view.closePreferences = null;
  view.model_cache.close();
  view.closeMoonlander();
  view.launch_previews.disconnect();
  if (view.onboarding) view.onboarding.close();
  view.dismissName();
  view.clearEffects();
  view.runtime.destroy();
}
/** Workspace previews use cached screens without subscribing to them. */
export function releaseUninterested(view: Controller, interests: readonly { pane: number }[]): void {
  const preview = view.sidebarWorkspaceGhost()?.view.placements(view.area());
  for (const pane of view.runtime.panes)
    if (!interests.some(interest => interest.pane === pane.id) && !preview?.some(place => place.id === pane.id))
      pane.terminal.release();
}

export async function sync(
  view: Controller,
  bell: { seq: bigint },
  play_sound: boolean,
  visible = true,
): Promise<boolean> {
  view.sweepPickState();
  for (const p of view.runtime.panes) {
    if (p.terminal.holding_selection && view.selection?.pane !== p.id && view.gesture?.pane !== p.id)
      p.terminal.clearSelection();
    if (p.terminal.pending.length > 0) await p.terminal.flush();
  }
  let reply: Reply<"viewer.sync">;
  try {
    reply = await call(view.connection, "viewer.sync", syncRequest(view, visible));
  } catch (error) {
    throw incompatible(error as Error);
  }
  view.input_state.active = false;
  return receive(view, reply, bell, play_sound);
}
/** What `machine`'s viewer asks its daemon for. Only the machine shown has
 * panes in view; one in the background keeps its session current. */
export function syncRequest(
  view: Controller,
  visible = true,
  machine: Machine = view.machine,
): RequestInput<"viewer.sync"> {
  visible &&= machine === view.machine;
  const interests: RequestInput<"viewer.sync">["interests"] = [];
  for (const place of visible ? view.layoutView().placements(view.area()) : []) {
    const p = view.runtime.pane(place.id);
    if (!p) continue;
    interests.push({
      pane: place.id,
      cols: Math.max(1, place.rect.w),
      rows: Math.max(1, place.rect.h),
      offset: p.terminal.offset,
      known: p.terminal.known,
      cell: view.cell_pixels,
    });
  }
  // A ghost needs its agent's screen, sized as entering will size it.
  const ghost = visible ? view.previewGhost() : null;
  if (ghost && !interests.some(interest => interest.pane === ghost.pane.id))
    interests.push({
      pane: ghost.pane.id,
      cols: Math.max(1, ghost.rect.w),
      rows: Math.max(1, ghost.rect.h),
      offset: ghost.pane.terminal.offset,
      known: ghost.pane.terminal.known,
      cell: view.cell_pixels,
    });
  const dock = visible ? view.dockingPreview() : null;
  if (dock?.plan && dock.drop?.kind !== "tab") {
    for (const place of docking.view(dock.plan).placements(view.area())) {
      if (interests.length >= max_panes) break;
      if (
        !dock.plan.moved.includes(place.id) ||
        place.id === dock.plan.shell ||
        interests.some(i => i.pane === place.id)
      )
        continue;
      const p = view.runtime.pane(place.id);
      if (p)
        interests.push({
          pane: p.id,
          // Crop the live screen into the ghost; resize its process on commit.
          cols: p.terminal.inner.cols,
          rows: p.terminal.inner.rows,
          offset: p.terminal.offset,
          known: p.terminal.known,
          cell: view.cell_pixels,
        });
    }
  }
  if (visible) releaseUninterested(view, interests);
  else for (const pane of machine.runtime.panes) pane.terminal.release();
  return {
    interests,
    session_hash: machine.runtime.snapshot_hash,
    focus: visible ? (view.focused()?.id ?? null) : null,
    watched: visible && view.input_state.watched,
    workspace: machine.navigation.current(machine.runtime.workspaces).id,
    ack: machine.last_control,
    active: visible && view.input_state.active,
    resource_detail: visible ? view.resourceWorkspace() : null,
    worktree_detail: visible ? view.worktreeDetailWanted() : null,
    resources: view.host.prefs.resources.enabled,
    resources_hash: machine.runtime.resources_hash,
  };
}
/** Takes a reply from `machine`'s daemon. A machine in the background takes
 * its data; its controls wait, unacknowledged, until it's shown. */
export async function receive(
  view: Controller,
  reply: Reply<"viewer.sync">,
  bell: { seq: bigint },
  play_sound: boolean,
  machine: Machine = view.machine,
): Promise<boolean> {
  const shown = machine === view.machine;
  if (reply.session) view.receiveSnapshot(reply.session, machine);
  machine.runtime.snapshot_hash = reply.session_hash == null ? null : BigInt(reply.session_hash);
  if (reply.resources) machine.runtime.receiveResources(reply.resources);
  machine.runtime.resources_hash = reply.resources_hash == null ? null : BigInt(reply.resources_hash);
  machine.viewer_id = reply.viewer ?? 0;
  for (const control of shown ? (reply.controls ?? []) : []) {
    const seq = BigInt(control.seq);
    if (seq <= machine.last_control) continue;
    try {
      if (control.kind === "focus" || control.kind === "workspace") {
        if (control.kind === "focus") view.focusPane(control.id!);
        else view.switchWorkspace(control.id!);
        if (view.prompt.open) view.prompt.hide();
      } else {
        const act = parseAction(control.name!, control.value ?? "");
        if (act.name === "relaunch") {
          view.executable = String(act.value);
          return false;
        }
        await view.perform(act);
      }
    } catch (error) {
      view.notice((error as Error).message);
    }
    machine.last_control = seq;
  }
  for (const frame of reply.surfaces ?? []) {
    const p = machine.runtime.pane(frame.surface.pane);
    if (p) p.terminal.receive(frame);
  }
  if (reply.bell_seq !== undefined) {
    const seq = BigInt(reply.bell_seq);
    if (seq !== bell.seq) {
      bell.seq = seq;
      if (shown) view.last_bell_kind = reply.bell_kind ?? "none";
      if (play_sound && !view.muted) sound.play(reply.bell_kind ?? "none");
    }
  }
  if (shown && view.prompt_chime) {
    if (play_sound && !view.muted) sound.playCorgi(view.prompt_chime === "needs_input");
    view.prompt_chime = null;
  }
  return !shown || view.input_state.attached;
}
// Called only after the frame has been written. Receipts refer to the
// snapshot displayed, never whatever completion happens to be latest remotely.
export async function presented(view: Controller): Promise<void> {
  if (!view.input_state.watched || view.coversPanes()) return;
  const shown = new Set<number>();
  for (const place of view.layoutView().placements(view.area())) {
    const p = view.runtime.pane(place.id);
    if (!p) continue;
    shown.add(p.id);
    const focused = view.focused()?.id === p.id;
    const had_focus = view.marked_unread.get(p.id);
    if (had_focus !== undefined) {
      if (had_focus || !focused) {
        view.marked_unread.set(p.id, focused);
        continue;
      }
      view.marked_unread.delete(p.id);
    }
    if (!unread(p.agent.observation) && (p.agent.attention === "none" || !focused)) continue;
    await call(view.connection, "pane.acknowledge", {
      pane: p.id,
      binding: p.binding,
      conversation: p.agent.conversation,
      session: p.agent.session,
      through: p.agent.observation.completed,
      attention_at: focused ? p.agent.changed_at : -1,
    });
    acknowledge(p.agent.observation, p.agent.observation.completed);
    if (focused || p.agent.attention !== "needs_input") p.agent.attention = "none";
  }
  for (const id of view.marked_unread.keys()) if (!shown.has(id)) view.marked_unread.delete(id);
}

/** Writes what the host needs to show `frame`, diffed against what it shows,
 * and asks the host to answer once it has drawn it. */
export function present(
  host: Differ | null,
  frame: composition.Output,
  cols: number,
  rows: number,
  pacer: framePacing.Pacer,
): Differ {
  if (host && (host.cols !== cols || host.rows !== rows)) {
    host.destroy();
    host = null;
  }
  const differ = host ?? Differ.create(cols, rows);
  const started = telemetry.begin();
  const out = differ.diff(frame);
  telemetry.end("viewer.present", started);
  if (out.length > 0) writeAll(Buffer.concat([out, Buffer.from(pacer.stamp(Date.now()))]));
  return differ;
}
/** Whether the host takes a frame now: its terminal has room, and over a
 * slow link it has drawn the frames before. */
export function ready(probe: terminal_info.Probe): boolean {
  return !probe.pacer.waiting(Date.now()) && writable();
}
/** Whether the terminal takes output now. Linux reports no output queue for
 * a pty, so a host falling behind shows only as stdout filling up. */
export function writable(): boolean {
  return n.probe_writable(1, 0) === 1;
}
/** Writes all of `data` to stdout, waiting while the host is behind. */
export function writeAll(data: string | Uint8Array): void {
  const bytes = typeof data === "string" ? Buffer.from(data) : data;
  let offset = 0;
  while (offset < bytes.length) {
    const chunk = bytes.subarray(offset);
    const written = n.probe_write(1, ptr(chunk), Math.min(chunk.length, 1 << 30));
    if (written > 0) offset += written;
    else if (written === -11 || written === -35 || written === -4) n.probe_writable(1, 100);
    else throw Error("WriteFailed");
  }
}
/** Hands the host clipboard's paste and what a read brought to the view,
 * and writes the requests both make. */
/** Publish terminal measurements for the UI and other clients to read. */
export async function publishTerminal(
  view: Controller,
  connection: import("./mirror").Transport,
  probe: terminal_info.Probe,
): Promise<void> {
  const terminal = await probe.snapshot({ source: "viewer", ...dimensions(), used: view.cell_pixels });
  view.host_terminal = terminal;
  await call(connection, "viewer.terminal", { terminal });
}
export function dimensions(): {
  cols: number;
  rows: number;
  /** The window size as the PTY said it, before any of it was used; null when it couldn't say. */
  pty: terminal_info.Pty | null;
} {
  const pty = terminal_info.pty(),
    cols = pty?.cols ?? 0,
    rows = pty?.rows ?? 0;
  return {
    cols: cols === 0 ? 100 : Math.min(Math.max(cols, 10), 500),
    rows: rows === 0 ? 30 : Math.min(Math.max(rows, 4), 200),
    pty,
  };
}
/** Hands `input` to `handle` as whole characters. `decoder` keeps a
 * character split across reads until the rest arrives and turns an invalid
 * byte into U+FFFD; keys that arrive while `handle` runs wait for the next call. */
export async function takeInput(
  input: number[],
  decoder: TextDecoder,
  handle: (chunk: Uint8Array) => Promise<void>,
): Promise<void> {
  const text = decoder.decode(Uint8Array.from(input.splice(0)), { stream: true });
  if (text) await handle(new TextEncoder().encode(text));
}

/** The viewer's terminal input, as raw bytes. */
export class Stdin {
  ended = false;
  private handler: ((bytes: Uint8Array) => void) | null = null;
  private queued: Uint8Array[] = [];
  private onData = (chunk: Buffer) => {
    if (this.handler) this.handler(chunk);
    else this.queued.push(chunk);
  };
  private onEnd = () => {
    this.ended = true;
    this.handler?.(new Uint8Array());
  };
  constructor() {
    process.stdin.on("data", this.onData);
    process.stdin.on("end", this.onEnd);
    process.stdin.on("error", this.onEnd);
    process.stdin.resume();
  }
  /** Ends input as if the terminal had closed. */
  end(): void {
    this.onEnd();
  }
  listen(handler: (bytes: Uint8Array) => void): void {
    this.handler = handler;
    for (const chunk of this.queued.splice(0)) handler(chunk);
  }
  /** Bytes that arrive within `ms`, until `done` says enough. */
  async collect(ms: number, done: () => boolean, take: (bytes: Uint8Array) => void): Promise<void> {
    const deadline = Date.now() + ms;
    for (const chunk of this.queued.splice(0)) take(chunk);
    while (!done() && Date.now() < deadline && !this.ended) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
        this.handler = bytes => {
          take(bytes);
          clearTimeout(timer);
          resolve();
        };
      });
      this.handler = null;
    }
  }
  close(): void {
    process.stdin.off("data", this.onData);
    process.stdin.off("end", this.onEnd);
    process.stdin.off("error", this.onEnd);
    process.stdin.pause();
  }
}

export function answerClipboard(view: ClipboardView, clipboard: ClipboardState): Promise<void> | void {
  clipboard.tick(Date.now());
  const listing = clipboard.takeEvent();
  if (listing !== null || clipboard.result !== null) return deliverClipboard(view, clipboard, listing);
  flushClipboard(clipboard);
}
type ClipboardView = Pick<Controller, "pasteEvent" | "pasteResult" | "notice">;
async function deliverClipboard(view: ClipboardView, clipboard: ClipboardState, listing: string | null): Promise<void> {
  if (listing !== null)
    try {
      await view.pasteEvent(listing);
    } catch (error) {
      view.notice((error as Error).message);
    }
  const result = clipboard.takeResult();
  if (result)
    try {
      await view.pasteResult(result);
    } catch (error) {
      view.notice((error as Error).message);
    }
  flushClipboard(clipboard);
}
function flushClipboard(clipboard: ClipboardState): void {
  const out = clipboard.takeOutput();
  if (out.length > 0) writeAll(out);
}

export function waitTime(view: Controller, active: boolean, nextFrame: number, paneDue: number): number {
  const now = Date.now(),
    due = Math.min(Math.max(1, nextFrame - now), Math.max(1, paneDue - now));
  return active ? Math.min(16, view.frameDelay(), due) : due;
}
