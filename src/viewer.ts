//! Each invocation owns its UI, local selections, and input parser. The daemon
//! sends shared session organization and terminal surfaces, never Corgi frames.
//! Mirrors viewer.zig.
import { dirname, join } from "node:path";
import { createConnection, type Socket } from "node:net";
import { Controller } from "./controller";
import { call, unread, acknowledge, type Transport } from "./mirror";
import { parse as parseAction } from "./action";
import * as corgiBadge from "./corgi_badge";
import * as forkMotion from "./fork_motion";
import { Differ } from "./frame_diff";
import { Openers } from "./url_opener";
import * as sound from "./sound";
import { sshViewer } from "./trackers/ports";
import type { Probe } from "./host_probe";
import type { Rgb } from "./palette";
import type { Colors as TerminalColors } from "./terminal_palette";
import type { RGB } from "./theme";
import type { State as ClipboardState } from "./host_clipboard";
import { n, ptr } from "./native_ffi";
import { stringify } from "./json";
export { Controller as View };

/** How often a viewer syncs while the daemon reports nothing new. Under a
 * second, so the daemon keeps counting the viewer as watching. */
const quiet_sync_ms = 500;
/** How long after input or a change on screen frames keep their full rate.
 * After that a still screen is drawn only as often as the viewer syncs. */
const idle_after_ms = 1000;
/** How often a viewer saves its agent list's scroll for the next viewer to start from. */
const scroll_save_ms = 1000;

export async function open(view: Controller, cwd: string, theme: unknown, socket: string): Promise<number | bigint> {
  return openMode(view, cwd, theme, socket, false);
}
export async function openMode(
  view: Controller,
  cwd: string,
  theme: unknown,
  socket: string,
  start_onboarding: boolean,
): Promise<number | bigint> {
  view.remote_links = sshViewer();
  // OSC 22 uses X11 names in iTerm2, CSS names in Ghostty/Kitty. Read the
  // attaching viewer's environment: one daemon can serve both terminals.
  view.iterm2_pointer = process.env.TERM_PROGRAM === "iTerm.app";
  view.branch_glyphs = branchGlyphs(process.env.TERM ?? "") || branchGlyphs(process.env.TERM_PROGRAM ?? "");
  view.loadPreferences();
  if (start_onboarding) view.openOnboarding("welcome");
  let opened: any;
  try {
    opened = await call(view.connection, "viewer.open", { cwd, theme, onboarding: view.onboarding !== null });
  } catch (error) {
    throw incompatible(error as Error);
  }
  view.navigation.workspace_id = opened.workspace;
  view.input_state.attached = true;
  await view.refresh();
  view.restoreAgentScroll();
  view.launch_previews.socket = socket;
  view.updateLaunchPreview();
  return opened.bell_seq ?? 0;
}
/** A daemon on another protocol is one error, which `main` explains. */
function incompatible(error: Error): Error {
  return ["UnsupportedViewerProtocol", "UnsupportedProtocol", "ProtocolRequired"].includes(error.message)
    ? Error("IncompatibleViewerProtocol")
    : error;
}
export function close(view: Controller): void {
  view.launch_previews.disconnect();
  if (view.onboarding) view.onboarding.close();
  view.dismissName();
  view.clearEffects();
  view.runtime.destroy();
}
export async function sync(view: Controller, bell: { seq: number | bigint }, play_sound: boolean): Promise<boolean> {
  for (const p of view.runtime.panes) {
    if (p.terminal.holding_selection && (view.selection === null || view.selection.pane !== p.id))
      p.terminal.clearSelection();
    await p.terminal.flush();
  }
  const interests: any[] = [];
  for (const place of view.layoutView().placements(view.area())) {
    const p = view.runtime.pane(place.id);
    if (!p) continue;
    interests.push({
      pane: place.id,
      cols: Math.max(1, place.rect.w),
      rows: Math.max(1, place.rect.h),
      offset: p.terminal.offset,
      known: p.terminal.known,
    });
  }
  let reply: any;
  try {
    reply = await call(view.connection, "viewer.sync", {
      interests,
      session_hash: view.runtime.snapshot_hash,
      focus: view.focused()?.id ?? null,
      watched: view.input_state.watched,
      workspace: view.current().id,
      ack: view.input_state.last_control,
      active: view.input_state.active,
      resource_detail: view.resourceDetail(),
      worktree_detail: view.worktreeDetail(),
      resources: view.prefs.resources.enabled,
      resources_hash: view.runtime.resources_hash,
    });
  } catch (error) {
    throw incompatible(error as Error);
  }
  view.input_state.active = false;
  if (reply.session) view.receiveSnapshot(reply.session);
  view.runtime.snapshot_hash = reply.session_hash ?? null;
  if (reply.resources) view.runtime.receiveResources(reply.resources);
  view.runtime.resources_hash = reply.resources_hash ?? null;
  view.input_state.viewer_id = reply.viewer ?? 0;
  for (const control of reply.controls ?? []) {
    if (BigInt(control.seq) <= BigInt(view.input_state.last_control)) continue;
    try {
      if (control.kind === "focus") view.focusPane(control.id);
      else if (control.kind === "workspace") view.switchWorkspace(control.id);
      else {
        const act = parseAction(control.name, control.value ?? "");
        if (act.name === "relaunch") {
          view.executable = String(act.value);
          return false;
        }
        await view.perform(act);
      }
    } catch (error) {
      view.notice((error as Error).message);
    }
    view.input_state.last_control = control.seq;
  }
  for (const frame of reply.surfaces ?? []) {
    const p = view.runtime.pane(frame.surface.pane);
    if (p) p.terminal.receive(frame);
  }
  if (reply.bell_seq !== undefined && BigInt(reply.bell_seq) !== BigInt(bell.seq)) {
    bell.seq = reply.bell_seq;
    view.last_bell_kind = reply.bell_kind ?? "none";
    if (play_sound && !view.muted) sound.play(view.last_bell_kind);
  }
  const choosing = view.onboarding !== null || (view.agent_launcher !== null && view.agent_launcher.pinned);
  return (!reply.detach || choosing) && view.input_state.attached;
}
// Called only after the frame has been written. Receipts refer to the
// snapshot displayed, never whatever completion happens to be latest remotely.
export async function presented(view: Controller): Promise<void> {
  if (!view.input_state.watched || view.coversPanes()) return;
  for (const place of view.layoutView().placements(view.area())) {
    const p = view.runtime.pane(place.id);
    if (!p) continue;
    const focused = view.focused()?.id === p.id;
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
}

/** Waits for the first of stdin, the daemon's wake connection, the host
 * taking output, or a timeout, as viewer.zig polls them. */
class Poll {
  private wake: (() => void) | null = null;
  stdin = false;
  woken = false;
  notify(kind: "stdin" | "waker"): void {
    if (kind === "stdin") this.stdin = true;
    else this.woken = true;
    this.wake?.();
  }
  async wait(ms: number, held: boolean): Promise<void> {
    if (this.stdin || this.woken) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(done, ms);
      const check = held ? setInterval(() => writable() && done(), 2) : null;
      this.wake = done;
      function done() {
        clearTimeout(timer);
        if (check) clearInterval(check);
        resolve();
      }
    });
    this.wake = null;
  }
}

export async function run(
  connection: Transport,
  socket: string,
  probe: Probe,
  input: number[],
  start_onboarding: boolean,
  stdin: Stdin,
  folder: string | null = null,
): Promise<string | null> {
  const view = new Controller(connection);
  try {
    const bell = { seq: await openMode(view, folder ?? process.cwd(), probe.theme, socket, start_onboarding) };
    if (folder !== null)
      try {
        await view.perform({ name: "open", value: folder });
      } catch (error) {
        view.notice((error as Error).message);
      }
    // Pasted images are saved beside the socket, on the daemon's machine.
    probe.clipboard.folder = join(dirname(socket) || ".", "paste");
    view.host_clipboard = probe.clipboard;
    view.terminal_colors = hostColors(probe);
    probe.clipboard.start(Date.now());
    const openers = new Openers();
    let previous = "";
    let host: Differ | null = null;
    // The host has not taken the last output yet (a slow SSH link): later
    // frames wait, and the next one written carries all their changes.
    let held = false;
    probe.badge = new corgiBadge.State();
    writeAll(corgiBadge.query);
    // Opened once the first sync names this viewer.
    let waker: Socket | null = null;
    let watch_opened = false;
    let woken = true;
    let synced = 0;
    let next_sync = 0;
    let typed = false;
    let active_at = Date.now();
    let scroll_saved = 0;
    const poll = new Poll();
    stdin.listen(bytes => {
      for (const byte of probe.feed(bytes, Date.now())) input.push(byte);
      poll.notify("stdin");
    });
    try {
      while (view.input_state.attached) {
        openers.reap();
        for (const byte of probe.expire(Date.now())) input.push(byte);
        await answerClipboard(view, probe.clipboard);
        const images = probe.badge.upload(Date.now());
        if (images.length > 0) writeAll(images);
        const badge_mode = probe.badge.mode();
        if (view.corgi_badge !== badge_mode || view.supports_kitty_graphics !== probe.badge.supports_kitty_graphics) {
          view.corgi_badge = badge_mode;
          view.supports_kitty_graphics = probe.badge.supports_kitty_graphics;
          view.dirty = true;
        }
        if (probe.scheme_changed) {
          probe.scheme_changed = false;
          writeAll(probe.query());
        }
        if (probe.changed) {
          await call(connection, "theme", { theme: probe.theme });
          probe.changed = false;
          view.terminal_colors = hostColors(probe);
          view.dirty = true;
        }
        const size = dimensions();
        view.cell_pixels = size.cell;
        // Over SSH, TERM may not name the terminal; XTVERSION does.
        if (branchGlyphs(probe.clipboard.terminal.text())) view.branch_glyphs = true;
        if (view.width !== size.cols || view.height !== size.rows) {
          view.width = size.cols;
          view.height = size.rows;
          view.input_state.active = true;
          view.dirty = true;
        }
        let input_end = input.length;
        while (input_end > 0 && !validUtf8(input.slice(0, input_end))) input_end -= 1;
        if (input_end > 0) {
          const chunk = input.splice(0, input_end);
          try {
            await view.input(Uint8Array.from(chunk));
          } catch (error) {
            view.notice((error as Error).message);
          }
        }
        if (input.length > 4) input.length = 0;
        await view.expireInput();
        const now = Date.now();
        if (now - scroll_saved >= scroll_save_ms) {
          view.saveAgentScroll();
          scroll_saved = now;
        }
        if (view.dirty || now >= next_sync || (held && writable())) {
          // Frames keep their clock for animations; the daemon is asked
          // only when it said something changed, or often enough that it
          // still counts this viewer as watching.
          if (waker === null || view.dirty || woken || now - synced >= quiet_sync_ms) {
            if (!(await sync(view, bell, true))) return view.executable.length > 0 ? view.executable : null;
            woken = false;
            synced = now;
            if (!watch_opened) {
              waker = watch(
                socket,
                view.input_state.viewer_id,
                () => {
                  woken = true;
                  // An idle viewer draws the change now rather than at its next quiet frame.
                  if (typed || Date.now() - active_at >= idle_after_ms) next_sync = 0;
                  typed = false;
                  poll.notify("waker");
                },
                () => {
                  // A daemon gone or replaced by a reload stops waking; sync on
                  // every frame again until this viewer reconnects.
                  waker = null;
                },
              );
              watch_opened = true;
            }
          }
          const frame = view.frame();
          if (view.dirty || previous !== frame || view.overlayOpen()) active_at = now;
          next_sync = Date.now() + (now - active_at < idle_after_ms ? view.frameDelay() : quiet_sync_ms);
          view.dirty = false;
          held = previous !== frame && !writable();
          if (!held) {
            if (previous !== frame) host = present(host, frame, view.width, view.height);
            previous = frame;
            await presented(view);
          }
        }
        for (const effect of view.effects) {
          if ("open_url" in effect) {
            if (!view.remote_links)
              try {
                openers.open(effect.open_url);
              } catch (error) {
                view.notice((error as Error).message);
              }
          } else writeAll(effect.write_terminal);
        }
        view.clearEffects();
        await poll.wait(Date.now() - active_at < idle_after_ms ? 16 : Math.max(1, next_sync - Date.now()), held);
        // Input reaches the daemon with a frame's sync, so send it now, and
        // show the first change after it (its echo) without waiting a frame.
        if (poll.stdin) {
          typed = true;
          next_sync = 0;
          active_at = Date.now();
        }
        poll.stdin = false;
        poll.woken = false;
        if (stdin.ended) return null;
      }
      return null;
    } finally {
      view.saveAgentScroll();
      stdin.close();
      waker?.destroy();
      host?.destroy();
      if (probe.badge.uploaded) writeAll(corgiBadge.remove);
      if (view.name_dialog?.hero.motion) writeAll(forkMotion.remove);
    }
  } finally {
    close(view);
  }
}
/** Writes what the host needs to show `frame`, diffed against what it shows. */
function present(host: Differ | null, frame: string, cols: number, rows: number): Differ {
  if (host && (host.cols !== cols || host.rows !== rows)) {
    host.destroy();
    host = null;
  }
  const differ = host ?? Differ.create(cols, rows);
  const out = differ.diff(frame);
  if (out.length > 0) writeAll(out);
  return differ;
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
async function answerClipboard(view: Controller, clipboard: ClipboardState): Promise<void> {
  clipboard.tick(Date.now());
  const listing = clipboard.takeEvent();
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
  const out = clipboard.takeOutput();
  if (out.length > 0) writeAll(out);
}
/** The daemon's wake connection, or null when it cannot watch (an older
 * daemon), in which case the viewer syncs on every frame. */
function watch(socket: string, viewer: number, woken: () => void, closed: () => void): Socket | null {
  try {
    const conn = createConnection(socket);
    conn.on("data", woken);
    conn.on("error", () => {});
    conn.on("close", closed);
    conn.write(stringify({ op: "viewer.watch", protocol: 1, viewer }) + "\n");
    return conn;
  } catch {
    return null;
  }
}
/** The host's colors, when it answered the probe with its foreground and background. */
function hostColors(probe: Probe): TerminalColors | null {
  const { foreground, background, palette } = probe.theme,
    rgb = (c: RGB | null): Rgb | null => (c ? [c.r, c.g, c.b] : null);
  if (!foreground || !background) return null;
  return { foreground: rgb(foreground)!, background: rgb(background)!, ansi: palette.map(rgb) };
}
function dimensions(): { cols: number; rows: number; cell: forkMotion.Cell | null } {
  const size = new Uint16Array(4);
  if (n.probe_winsize_pixels(0, ptr(size)) !== 0) size.fill(0);
  const [ws_col, ws_row, ws_xpixel, ws_ypixel] = size;
  // Terminals that report pixels pad under a cell, so this is the cell.
  const cell =
    ws_col === 0 || ws_row === 0 || ws_xpixel < ws_col || ws_ypixel < ws_row
      ? null
      : { width: Math.floor(ws_xpixel / ws_col), height: Math.floor(ws_ypixel / ws_row) };
  return {
    cols: ws_col === 0 ? 100 : Math.min(Math.max(ws_col, 10), 500),
    rows: ws_row === 0 ? 30 : Math.min(Math.max(ws_row, 4), 200),
    cell,
  };
}
/** Whether a terminal by this name draws Kitty's branch drawing characters:
 * Ghostty and Kitty do. */
function branchGlyphs(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes("ghostty") || lower.includes("kitty");
}
function validUtf8(bytes: number[]): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
    return true;
  } catch {
    return false;
  }
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
