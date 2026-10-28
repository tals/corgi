//! Each invocation owns its UI, local selections, and input parser. The daemon
//! sends shared session organization and terminal surfaces, never Corgi frames.
//! Mirrors viewer.zig.
import { dirname, join } from "node:path";
import { createConnection, type Socket } from "node:net";
import { Controller } from "./controller";
import { call, unread, acknowledge, type Transport } from "./mirror";
import { parse as parseAction } from "./action";
import * as corgiBadge from "./corgi_badge";
import * as terminal_info from "./terminal_info";
import * as linkThumbnail from "./link_thumbnail";
import * as rowGlide from "./row_glide";
import { Differ } from "./frame_diff";
import * as framePacing from "./frame_pacing";
import { Openers } from "./url_opener";
import * as sound from "./sound";
import { sshViewer } from "./trackers/ports";
import * as palette from "./palette";
import * as hostBackground from "./host_background";
import type { Reply, RequestInput } from "./protocol";
import * as protocol from "./protocol";
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
/** How long a pane's output pauses before its frame counts as finished. */
const settle_ms = 2;
/** The shortest gap between frames drawn at a pane's own pace (120 fps). */
const pane_frame_ms = 8;
/** How often a pane that never pauses, such as a flood of output, is drawn. */
const flood_frame_ms = 33;
/** How often a viewer saves its agent list's scroll for the next viewer to start from. */
const scroll_save_ms = 1000;

export async function open(
  view: Controller,
  cwd: string,
  theme: RequestInput<"viewer.open">["theme"],
  socket: string,
): Promise<bigint> {
  return openMode(view, cwd, theme, socket, false);
}
export async function openMode(
  view: Controller,
  cwd: string,
  theme: RequestInput<"viewer.open">["theme"],
  socket: string,
  start_onboarding: boolean,
): Promise<bigint> {
  view.remote_links = sshViewer();
  // OSC 22 uses X11 names in iTerm2, CSS names in Ghostty/Kitty. Read the
  // attaching viewer's environment: one daemon can serve both terminals.
  view.iterm2_pointer = process.env.TERM_PROGRAM === "iTerm.app";
  view.branch_glyphs = branchGlyphs(process.env.TERM ?? "") || branchGlyphs(process.env.TERM_PROGRAM ?? "");
  view.loadPreferences();
  if (start_onboarding) view.openOnboarding("welcome");
  let opened: Reply<"viewer.open">;
  try {
    opened = await call(view.connection, "viewer.open", { cwd, theme, onboarding: view.onboarding !== null });
  } catch (error) {
    throw incompatible(error as Error);
  }
  view.navigation.workspace_id = opened.workspace;
  view.input_state.attached = true;
  await view.refresh();
  if (opened.focus && view.runtime.workspaces.owner(opened.focus)) view.focusPane(opened.focus);
  view.restoreAgentScroll();
  view.launch_previews.socket = socket;
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
  view.closeMoonlander();
  view.launch_previews.disconnect();
  if (view.onboarding) view.onboarding.close();
  view.dismissName();
  view.clearEffects();
  view.runtime.destroy();
}
export async function sync(view: Controller, bell: { seq: bigint }, play_sound: boolean): Promise<boolean> {
  for (const p of view.runtime.panes) {
    if (p.terminal.holding_selection && (view.selection === null || view.selection.pane !== p.id))
      p.terminal.clearSelection();
    await p.terminal.flush();
  }
  const interests: RequestInput<"viewer.sync">["interests"] = [];
  for (const place of view.layoutView().placements(view.area())) {
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
  // The sidebar's ghost needs its agent's screen, sized as entering will size it.
  const ghost = view.sidebarGhost();
  if (ghost)
    interests.push({
      pane: ghost.pane.id,
      cols: Math.max(1, ghost.rect.w),
      rows: Math.max(1, ghost.rect.h),
      offset: ghost.pane.terminal.offset,
      known: ghost.pane.terminal.known,
      cell: view.cell_pixels,
    });
  let reply: Reply<"viewer.sync">;
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
      worktree_detail: view.worktreeDetailWanted(),
      resources: view.prefs.resources.enabled,
      resources_hash: view.runtime.resources_hash,
    });
  } catch (error) {
    throw incompatible(error as Error);
  }
  view.input_state.active = false;
  if (reply.session) view.receiveSnapshot(reply.session);
  view.runtime.snapshot_hash = reply.session_hash == null ? null : BigInt(reply.session_hash);
  if (reply.resources) view.runtime.receiveResources(reply.resources);
  view.runtime.resources_hash = reply.resources_hash == null ? null : BigInt(reply.resources_hash);
  view.input_state.viewer_id = reply.viewer ?? 0;
  for (const control of reply.controls ?? []) {
    const seq = BigInt(control.seq);
    if (seq <= view.input_state.last_control) continue;
    try {
      if (control.kind === "focus") view.focusPane(control.id!);
      else if (control.kind === "workspace") view.switchWorkspace(control.id!);
      else {
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
    view.input_state.last_control = seq;
  }
  for (const frame of reply.surfaces ?? []) {
    const p = view.runtime.pane(frame.surface.pane);
    if (p) p.terminal.receive(frame);
  }
  if (reply.bell_seq !== undefined) {
    const seq = BigInt(reply.bell_seq);
    if (seq !== bell.seq) {
      bell.seq = seq;
      view.last_bell_kind = reply.bell_kind ?? "none";
      if (play_sound && !view.muted) sound.play(view.last_bell_kind);
    }
  }
  return view.input_state.attached;
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

/** Waits for the first of stdin, the daemon's wake connection, the host
 * taking output or answering a frame, or a timeout, as viewer.zig polls them. */
class Poll {
  private wake: (() => void) | null = null;
  stdin = false;
  woken = false;
  notify(kind: "stdin" | "waker" | "host"): void {
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
  probe: terminal_info.Probe,
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
    view.host_pacer = probe.pacer;
    view.terminal_colors = probe.colors();
    probe.clipboard.start(Date.now());
    const openers = new Openers();
    let previous = "";
    let host: Differ | null = null;
    // The host has not taken the last output yet (a slow SSH link): later
    // frames wait, and the next one written carries all their changes.
    let held = false;
    probe.badge = new corgiBadge.State(() => view.wake?.());
    probe.size = new terminal_info.Size();
    writeAll(corgiBadge.query);
    // Measure the host terminal once on attachment.
    const probed_at = Date.now(),
      initial_size = dimensions();
    writeAll(probe.size.update(initial_size.pty) + probe.measure(initial_size.rows, probed_at));
    let terminal_sent = false;
    // Opened once the first sync names this viewer.
    let waker: Socket | null = null;
    let watch_opened = false;
    // What the daemon said changed since the last sync: when it first and
    // last said so, and whether to draw it at once.
    let woken: { first: number; last: number; prompt: boolean } | null = null;
    let synced = 0;
    let next_sync = 0;
    let typed = false;
    let active_at = Date.now();
    let scroll_saved = 0;
    // A change is drawn once its output pauses, at the pane's own pace up to
    // pane_frame_ms; output that never pauses is drawn every flood_frame_ms.
    const wakeDue = (): number => {
      if (woken === null) return Infinity;
      if (woken.prompt) return 0;
      return Math.max(Math.min(woken.last + settle_ms, woken.first + flood_frame_ms), synced + pane_frame_ms);
    };
    const poll = new Poll();
    const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
    view.wake = () => poll.notify("host");
    let resized = false;
    const onResize = () => {
      resized = true;
      poll.notify("host");
    };
    process.on("SIGWINCH", onResize);
    stdin.listen(bytes => {
      for (const byte of probe.feed(bytes, Date.now())) input.push(byte);
      poll.notify(framePacing.onlyAnswers(bytes) ? "host" : "stdin");
    });
    try {
      while (view.input_state.attached) {
        for (const reply of probe.graphics.splice(0)) view.graphicsReply(reply);
        openers.reap();
        for (const byte of probe.expire(Date.now())) input.push(byte);
        await answerClipboard(view, probe.clipboard);
        const size = dimensions();
        const query = probe.size.update(size.pty, resized);
        resized = false;
        if (query) writeAll(query);
        const cell = probe.size.pixels(size.pty),
          graphics = probe.badge.supports_kitty_graphics && cell !== null;
        const images = probe.badge.upload(Date.now(), graphics ? cell : null);
        if (images.length > 0) writeAll(images);
        const badge_mode = probe.badge.mode();
        if (view.supports_kitty_graphics && !graphics) {
          writeAll(rowGlide.hide + linkThumbnail.hide);
        }
        if (view.corgi_badge !== badge_mode || view.supports_kitty_graphics !== graphics) {
          view.corgi_badge = badge_mode;
          view.supports_kitty_graphics = graphics;
          view.dirty = true;
        }
        if (probe.scheme_changed) {
          probe.scheme_changed = false;
          // Its own background, not the one Corgi moved it to.
          writeAll(hostBackground.release() + probe.query());
        }
        if (probe.changed) {
          await call(connection, "theme", { theme: probe.theme });
          probe.changed = false;
          view.terminal_colors = probe.colors();
          view.dirty = true;
        }
        const cell_changed = view.cell_pixels?.width !== cell?.width || view.cell_pixels?.height !== cell?.height;
        view.cell_pixels = cell;
        // Sent once the answers and the first image upload have settled.
        if (
          !terminal_sent &&
          probe.info.status === "done" &&
          (badge_mode === "image" || Date.now() - probed_at > 3000)
        ) {
          terminal_sent = true;
          void publishTerminal(view, connection, probe).catch(() => {});
        }
        // Over SSH, TERM may not name the terminal; XTVERSION does.
        if (branchGlyphs(probe.clipboard.terminal.text())) view.branch_glyphs = true;
        if (view.width !== size.cols || view.height !== size.rows || cell_changed) {
          view.width = size.cols;
          view.height = size.rows;
          view.input_state.active = true;
          view.dirty = true;
        }
        try {
          await takeInput(input, decoder, chunk => view.input(chunk));
        } catch (error) {
          view.notice((error as Error).message);
        }
        await view.expireInput();
        const now = Date.now();
        if (now - scroll_saved >= scroll_save_ms) {
          view.saveAgentScroll();
          scroll_saved = now;
        }
        // Frames keep their clock for animations, and a change waits for
        // its due time; the daemon is asked only when it said something
        // changed, or often enough that it still counts this viewer as watching.
        if (view.dirty || now >= (woken === null ? next_sync : wakeDue()) || (held && ready(probe))) {
          if (waker === null || view.dirty || woken !== null || now - synced >= quiet_sync_ms) {
            // A wake during the sync may be past what it brings: keep it.
            woken = null;
            synced = now;
            if (!(await sync(view, bell, true))) return view.executable.length > 0 ? view.executable : null;
            if (!watch_opened) {
              waker = watch(
                socket,
                view.input_state.viewer_id,
                () => {
                  const at = Date.now(),
                    due = wakeDue();
                  // Typing's echo, or a change on an idle screen, is drawn now.
                  const prompt = typed || at - active_at >= idle_after_ms || woken?.prompt === true;
                  woken = { first: woken?.first ?? at, last: at, prompt };
                  typed = false;
                  // The daemon wakes per read of a pane's output; the loop
                  // already waits for the change's due time unless this brings it nearer.
                  if (wakeDue() < due) poll.notify("waker");
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
          held = previous !== frame && !ready(probe);
          if (!held) {
            const backdrop = hostBackground.follow(palette.painted());
            if (backdrop) writeAll(backdrop);
            if (previous !== frame) host = present(host, frame, view.width, view.height, probe.pacer);
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
          } else {
            writeAll(effect.write_terminal);
            if (effect.write_terminal.includes("\x1b_G")) {
              host?.invalidateImages();
              previous = "";
              view.dirty = true;
            }
          }
        }
        view.clearEffects();
        // The host's answer wakes a viewer waiting on it; only a full terminal is polled.
        const clock =
          Date.now() - active_at < idle_after_ms
            ? Math.min(16, view.frameDelay())
            : Math.max(1, next_sync - Date.now());
        await poll.wait(Math.min(clock, Math.max(1, wakeDue() - Date.now())), held && !probe.pacer.waiting(Date.now()));
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
      process.off("SIGWINCH", onResize);
      view.saveAgentScroll();
      // The last frame's answer would otherwise reach the shell as typing.
      const until = Date.now() + framePacing.settle_ms;
      while (probe.pacer.unanswered() && !stdin.ended && Date.now() < until) {
        poll.stdin = poll.woken = false;
        await poll.wait(until - Date.now(), false);
      }
      stdin.close();
      waker?.destroy();
      host?.destroy();
      if (probe.badge.uploaded) writeAll(corgiBadge.remove);
      if (view.thumbnails.sent !== null) writeAll(linkThumbnail.remove);
      writeAll(view.images.clear());
      writeAll(view.tab_icons.clear());
      if (view.moonlander) {
        writeAll(view.moonlander.close());
        view.moonlander = null;
      }
    }
  } finally {
    close(view);
  }
}
/** Writes what the host needs to show `frame`, diffed against what it shows,
 * and asks the host to answer once it has drawn it. */
function present(host: Differ | null, frame: string, cols: number, rows: number, pacer: framePacing.Pacer): Differ {
  if (host && (host.cols !== cols || host.rows !== rows)) {
    host.destroy();
    host = null;
  }
  const differ = host ?? Differ.create(cols, rows);
  const out = differ.diff(frame);
  if (out.length > 0) writeAll(Buffer.concat([out, Buffer.from(pacer.stamp(Date.now()))]));
  return differ;
}
/** Whether the host takes a frame now: its terminal has room, and over a
 * slow link it has drawn the frames before. */
function ready(probe: terminal_info.Probe): boolean {
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
    conn.write(stringify(protocol.envelope("viewer.watch", { viewer })) + "\n");
    return conn;
  } catch {
    return null;
  }
}
/** Publish terminal measurements for the UI and other clients to read. */
async function publishTerminal(view: Controller, connection: Transport, probe: terminal_info.Probe): Promise<void> {
  const terminal = await probe.snapshot({ source: "viewer", ...dimensions(), used: view.cell_pixels });
  view.host_terminal = terminal;
  await call(connection, "viewer.terminal", { terminal });
}
function dimensions(): {
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
/** Whether a terminal by this name draws Kitty's branch drawing characters:
 * Ghostty and Kitty do. */
function branchGlyphs(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes("ghostty") || lower.includes("kitty");
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
