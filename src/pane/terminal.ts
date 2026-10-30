import * as telemetry from "../telemetry";
import { existsSync } from "node:fs";
import { EventEmitter } from "node:events";
import { dirname } from "node:path";
import { n, ptr, call, symbols, ReadyLoop, READ, nativeRoot } from "../native_bridge";
import * as launch_command from "../launch/command";
import { Provider, adapter } from "../providers";
import * as surface from "./surface";
import type { Link } from "./hyperlinks";
import { toBuffer, type Pointer } from "bun:ffi";
import type { Wire } from "../protocol";
export type Title = { text: string; pid: number; revision: bigint };
let readiness: ReadyLoop | null = null;
const loop = () => (readiness ??= new ReadyLoop());
const bytes_length = new BigUint64Array(1);
const title_info = new BigUint64Array(3);
export function closeReadiness(): void {
  readiness?.close();
  readiness = null;
}
export class Terminal extends EventEmitter {
  readonly handle: Pointer | bigint;
  fd = -1;
  pid = -1;
  exited = false;
  exit_status = 0;
  /** The PTY closed; a spawned child's `exited` still waits for its status. */
  hung_up = false;
  runs_command = false;
  imported = false;
  get initial_input(): string | null {
    return this.native({ op: "info" }).initial_input;
  }
  owner: "runtime" | "candidate" = "runtime";
  cols: number;
  rows: number;
  child?: Bun.Subprocess;
  private watch?: ReturnType<ReadyLoop["watch"]>;
  private destroyed = false;
  private output: Buffer | null = null;
  private paused = false;
  private dirty = false;
  private live_text: { revision: bigint; text: string } | null = null;
  // A launch command or synchronized output waiting on time, not output.
  private waiting = false;
  /** An adopted pane's redraw nudge is under way. */
  redrawing = false;
  static create(cols: number, rows: number): Terminal {
    return new Terminal(cols, rows);
  }
  constructor(cols = 80, rows = 24) {
    super();
    this.cols = cols;
    this.rows = rows;
    const handle = n.terminal_new();
    if (!handle) throw Error("TerminalAllocationFailed");
    this.handle = handle;
    if (n.terminal_resize(handle, cols, rows)) throw Error("InvalidSize");
  }
  native(request: object): any {
    if (this.destroyed) throw Error("TerminalClosed");
    return call(this.handle, request);
  }
  get surface_identity(): bigint {
    if (this.destroyed) throw Error("TerminalClosed");
    return n.terminal_surface_identity(this.handle);
  }
  get surface_revision(): bigint {
    if (this.destroyed) throw Error("TerminalClosed");
    return n.terminal_surface_revision(this.handle);
  }
  titleInfo(): Title {
    const address = this.titleAddress(),
      length = Number(title_info[0]),
      pid = Number(BigInt.asIntN(64, title_info[1])),
      revision = title_info[2];
    return { text: address ? toBuffer(address, 0, length).toString() : "", pid, revision };
  }
  get title_pid(): number {
    this.titleAddress();
    return Number(BigInt.asIntN(64, title_info[1]));
  }
  get title_revision(): bigint {
    this.titleAddress();
    return title_info[2];
  }
  get title(): string {
    const address = this.titleAddress();
    return address ? toBuffer(address, 0, Number(title_info[0])).toString() : "";
  }
  /** Copy title bytes before any further terminal mutation can invalidate them. */
  private titleAddress() {
    if (this.destroyed) throw Error("TerminalClosed");
    const started = telemetry.begin(),
      address = n.terminal_title(this.handle, ptr(title_info));
    telemetry.end("native.title", started, Number(title_info[0]));
    return address;
  }
  get bracketed_paste(): boolean {
    return this.native({ op: "info" }).modes.bracketed_paste;
  }
  get vt() {
    return {
      cols: this.cols,
      rows: this.rows,
      getTitle: () => this.title,
      modes: {
        get: (key: string) => {
          const info = this.native({ op: "info" });
          if (key === "synchronized_output") return info.synchronized_output;
          const aliases: Record<string, string> = {
            backarrow_key_mode: "backarrow",
            ignore_keypad_with_numlock: "numlock",
            alt_esc_prefix: "alt_escape",
            kitty_paste_events: "paste_events",
          };
          return info.modes[aliases[key] ?? key];
        },
      },
    };
  }
  applyTheme(theme: any): void {
    this.native({ op: "theme", theme });
  }
  async spawn(
    cwd: string,
    socket: string,
    id: number,
    executable: string,
    command: string | null = null,
    interactive_command = false,
    extra: [string, string][] = [],
  ): Promise<void> {
    const fds = new Int32Array(2);
    if (n.probe_pty(ptr(fds))) throw Error("OpenPtyFailed");
    const [master, slave] = fds;
    const shell = launch_command.shell();
    const env: Record<string, string | undefined> = {
      ...process.env,
      SHELL: shell,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      // Programs talk to our Ghostty emulator, not the daemon's original host.
      TERM_PROGRAM: "ghostty",
      TERM_PROGRAM_VERSION: undefined,
      CORGI_SOCKET: socket,
      CORGI_BIN: hookSender(executable),
      CORGI_PANE: String(id),
      PATH: `${dirname(executable)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    };
    for (const key of ["ITERM_SESSION_ID", "KITTY_WINDOW_ID", "WEZTERM_PANE", "VSCODE_PID", "ALACRITTY_WINDOW_ID"])
      delete env[key];
    for (const p of Provider.all) adapter(p).unnest?.(env);
    for (const [key, value] of extra) env[key] = value;
    n.probe_resize(master, this.cols, this.rows);
    try {
      this.child = Bun.spawn(
        [`${nativeRoot}/bin/pty-exec`, shell, ...launch_command.shellArgs(command, interactive_command)],
        { cwd, env, stdin: slave, stdout: slave, stderr: slave },
      );
      this.pid = this.child.pid;
      this.fd = master;
      this.runs_command = command !== null;
      symbols.app_terminal_fd(this.handle, master, this.pid);
      this.attachReadiness();
      void this.child.exited.then(code => {
        if (!this.destroyed) {
          this.drain();
          this.exited = true;
          this.exit_status = code << 8;
          this.emit("exit", code);
          this.emit("change");
        }
      });
    } catch (error) {
      n.probe_close(master);
      throw error;
    } finally {
      n.probe_close(slave);
    }
  }
  adopt(fd: number, pid: number): void {
    this.fd = fd;
    this.pid = pid;
    this.owner = "runtime";
    symbols.app_terminal_fd(this.handle, fd, pid);
    this.native({ op: "adopt" });
    this.redrawing = true;
    this.attachReadiness();
  }
  private attachReadiness(): void {
    if (this.watch || this.fd < 0) return;
    this.watch = loop().watch(this.fd, () => {
      this.drain();
      this.flushWrites();
      this.arm();
    });
    this.arm();
  }
  private arm(): void {
    if (!this.paused && !this.exited && !this.hung_up && this.watch) this.watch.arm(READ | (this.pendingBytes ? 4 : 0));
  }
  private drain(): void {
    const telemetry_started = telemetry.begin();
    try {
      if (this.paused || this.fd < 0 || this.destroyed) return;
      const output = (this.output ??= Buffer.alloc(65536));
      for (let i = 0; i < 8; i++) {
        const count = n.probe_read(this.fd, ptr(output), output.length);
        if (count > 0) this.feed(output.subarray(0, count));
        else if (count === 0 || count === -5) {
          this.hung_up = true;
          if (!this.child) this.exited = true;
          this.emit("change");
          break;
        } else if (count === -4) continue;
        else if (count === -11 || count === -35) break;
        else {
          this.emit("ioError", Error(`ReadFailed:${count}`));
          break;
        }
      }
    } finally {
      telemetry.end("pty.drain", telemetry_started);
    }
  }
  feed(bytes: Uint8Array | string): void {
    const data = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
    const feed_started = telemetry.begin();
    if (data.length) n.terminal_feed(this.handle, ptr(data), data.length);
    telemetry.end("terminal.feed", feed_started, data.length);
    this.dirty = true;
    this.emit("change");
  }
  read(): boolean {
    this.drain();
    return this.maintain();
  }
  /** Follow up on output already consumed by the readiness callback. */
  maintain(): boolean {
    const dirty = this.dirty || false;
    this.dirty = false;
    let changed = false;
    if (!this.paused) {
      if (this.destroyed) throw Error("TerminalClosed");
      const started = telemetry.begin();
      const tick = n.terminal_maintain(this.handle, this.exited);
      telemetry.end("native.tick", started);
      changed = (tick & 1) !== 0;
      this.waiting = (tick & 2) !== 0;
    }
    this.arm();
    return changed || dirty;
  }
  /** Whether the daemon's tick has work here: output to follow up on, or
   * something waiting on time rather than output. */
  due(): boolean {
    return this.dirty || this.waiting || this.redrawing;
  }
  send(bytes: Uint8Array | string): void {
    const data = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
    if (data.length) {
      const result = n.terminal_send(this.handle, ptr(data), data.length);
      if (result) throw Error(result === -2 ? "InputBackpressure" : "OutOfMemory");
    }
    this.arm();
  }
  write(bytes: Uint8Array | string): void {
    this.send(bytes);
  }
  private flushWrites(): void {
    if (this.destroyed) throw Error("TerminalClosed");
    n.terminal_flush(this.handle);
  }
  flush(): void {
    this.flushWrites();
  }
  resize(cols: number, rows: number): void {
    if (n.terminal_resize(this.handle, cols, rows)) throw Error("InvalidSize");
    this.cols = cols;
    this.rows = rows;
    this.emit("change");
  }
  text(): string {
    return this.native({ op: "text" });
  }
  history(): string {
    return this.native({ op: "history" });
  }
  liveText(): string {
    const revision = this.surface_revision;
    if (this.live_text?.revision === revision) return this.live_text.text;
    const telemetry_started = telemetry.begin();
    try {
      const text = this.readBytes("text", bytes => bytes.toString());
      this.live_text = { revision, text };
      return text;
    } finally {
      telemetry.end("agent.screen", telemetry_started);
    }
  }
  snapshot(): Buffer {
    return this.readBytes("snapshot", bytes => Buffer.from(bytes));
  }
  snapshotBase64(): string {
    return this.readBytes("snapshot", bytes => bytes.toString("base64"));
  }
  /** Borrow the native allocation only until this synchronous read finishes. */
  private readBytes<T>(kind: "snapshot" | "text", read: (bytes: Buffer) => T): T {
    if (this.destroyed) throw Error("TerminalClosed");
    const started = telemetry.begin();
    const address =
      kind === "snapshot"
        ? n.terminal_recovery_snapshot(this.handle, ptr(bytes_length))
        : n.terminal_live_text(this.handle, ptr(bytes_length));
    if (address === null) throw Error(kind === "snapshot" ? "SnapshotFailed" : "NativeOperationFailed");
    const length = Number(bytes_length[0]);
    try {
      if (length > 64 * 1024 * 1024) throw Error("NativeMessageTooLarge");
      const bytes = length ? toBuffer(address, 0, length) : Buffer.alloc(0);
      return read(bytes);
    } finally {
      n.terminal_bytes_free(address, length);
      telemetry.end(kind === "snapshot" ? "terminal.snapshot" : "native.live_text", started, length);
    }
  }
  liveSnapshot(): Buffer {
    let out = Buffer.alloc(16 * 1024 * 1024);
    const size = Number(n.terminal_snapshot(this.handle, ptr(out), out.length));
    if (size < 0) throw Error("SnapshotFailed");
    return Buffer.from(out.subarray(0, size));
  }
  fadedSnapshot(): Buffer {
    return Buffer.from(this.native({ op: "fadedSnapshot" }));
  }
  surface(pane: number, offset: number | null = null): surface.View {
    const telemetry_started = telemetry.begin();
    try {
      return surface.view(this.native({ op: "surface", pane, offset }));
    } finally {
      telemetry.end("surface.capture", telemetry_started);
    }
  }
  hyperlinks(): Link[] {
    return this.native({ op: "links" }).map((link: Wire<Link>) => ({ ...link, id: BigInt(link.id) }));
  }
  search(
    needle: string,
    skip: number = 0,
  ): {
    offset: number | null;
    match: { x: number; y: number; end_x: number; end_y: number } | null;
  } {
    const result: Wire<ReturnType<Terminal["search"]>> = this.native({ op: "search", text: needle, skip });
    return {
      offset: result.offset,
      match: result.match ?? null,
    };
  }
  select(start_x: number, start_y: number, end_x: number, end_y: number): void {
    this.native({ op: "select", start_x, start_y, end_x, end_y });
  }
  selectedText(): string {
    return this.native({ op: "selection" });
  }
  clearSelection(): void {
    this.native({ op: "clearSelection" });
  }
  prefill(command: string): void {
    this.native({ op: "prefill", text: command });
    this.waiting = true;
  }
  pasteEvent(contents: { mime: string; data: string | Uint8Array }[]): boolean {
    return this.native({
      op: "paste",
      contents: contents.map(c => ({ mime: c.mime, data: Buffer.from(c.data).toString("base64") })),
    });
  }
  takeCopied(): string | null {
    if (this.destroyed) throw Error("TerminalClosed");
    return n.terminal_has_copied(this.handle) ? this.native({ op: "takeCopied" }) : null;
  }
  /** Discards input the program has not read yet. */
  dropPending(): void {
    this.native({ op: "takePending" });
  }
  restore(bytes: Uint8Array, title_pid = 0): void {
    this.native({ op: "restore", text: Buffer.from(bytes).toString(), title_pid });
  }
  refreshRedraw(now: number): void {
    this.redrawing = this.native({ op: "refreshRedraw", now });
  }
  updateRender(): void {
    this.surface(0);
  }
  reap(): boolean {
    if (this.exited || this.pid <= 0) return false;
    if (this.child) {
      const code = this.child.exitCode;
      if (code === null) return false;
      this.exited = true;
      this.exit_status = code << 8;
      return true;
    }
    const status = this.native({ op: "reap", pid: this.pid, imported: this.imported, exited: false });
    this.exited = status.exited;
    this.exit_status = status.exit_status;
    return status.reaped;
  }
  get pendingBytes(): number {
    return Number(n.terminal_pending(this.handle));
  }
  expecting(): boolean {
    const info = this.native({ op: "info" });
    return info.initial_input !== null || info.synchronized_since !== null;
  }
  pause(): void {
    this.paused = true;
    this.watch?.close();
    this.watch = undefined;
  }
  resume(): void {
    this.paused = false;
    this.attachReadiness();
  }
  releaseFD(): number {
    this.pause();
    const fd = this.fd;
    this.fd = -1;
    symbols.app_terminal_fd(this.handle, -1, -1);
    return fd;
  }
  stop(): void {
    this.pause();
    const fd = this.fd;
    this.fd = -1;
    symbols.app_terminal_fd(this.handle, -1, -1);
    if (fd >= 0) n.probe_close(fd);
    if (this.owner === "runtime" && this.pid > 0 && !this.exited) {
      try {
        process.kill(-this.pid, "SIGHUP");
      } catch {}
      try {
        process.kill(this.pid, "SIGHUP");
      } catch {}
    }
    this.exited = true;
    this.pid = -1;
    this.native({ op: "stop" });
  }
  destroy(): void {
    if (this.destroyed) return;
    this.stop();
    n.terminal_free(this.handle);
    this.destroyed = true;
    this.live_text = null;
    this.output = null;
    this.removeAllListeners();
  }
  close(): void {
    this.destroy();
  }
}
/** What the installed hook command runs as `$CORGI_BIN hook <provider>`: the
 * native sender, so an agent's hooks don't start the Bun application. */
function hookSender(executable: string): string {
  const sender = `${nativeRoot}/bin/corgi-hook`;
  return existsSync(sender) ? sender : executable;
}
