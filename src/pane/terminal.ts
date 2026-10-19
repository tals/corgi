import { existsSync } from "node:fs";
import { EventEmitter } from "node:events";
import { dirname } from "node:path";
import { n, ptr, call, symbols, ReadyLoop, READ, nativeRoot } from "../native_bridge";
import * as launch_command from "../launch/command";
import * as surface from "./surface";
import type { Link } from "./hyperlinks";
import type { Pointer } from "bun:ffi";
import type { Wire } from "../protocol";
let readiness: ReadyLoop | null = null;
const loop = () => (readiness ??= new ReadyLoop());
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
  private output = Buffer.alloc(65536);
  private paused = false;
  private dirty = false;
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
    return BigInt(this.native({ op: "info" }).surface_identity);
  }
  get surface_revision(): bigint {
    return BigInt(this.native({ op: "info" }).surface_revision);
  }
  get title_pid(): number {
    return this.native({ op: "info" }).title_pid;
  }
  get title_revision(): bigint {
    return BigInt(this.native({ op: "info" }).title_revision);
  }
  get title(): string {
    return this.native({ op: "info" }).title;
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
      CORGI_SOCKET: socket,
      CORGI_BIN: hookSender(executable),
      CORGI_PANE: String(id),
      PATH: `${dirname(executable)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    };
    delete env.CODEX_THREAD_ID;
    n.probe_resize(master, this.cols, this.rows);
    try {
      this.child = Bun.spawn(
        [
          `${nativeRoot}/bin/pty-exec`,
          shell,
          ...(command === null ? ["-l"] : [interactive_command ? "-lic" : "-lc", command]),
        ],
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
    if (!this.paused && !this.exited && this.watch) this.watch.arm(READ | (this.pendingBytes ? 4 : 0));
  }
  private drain(): void {
    if (this.paused || this.fd < 0 || this.destroyed) return;
    for (let i = 0; i < 8; i++) {
      const count = n.probe_read(this.fd, ptr(this.output), this.output.length);
      if (count > 0) this.feed(this.output.subarray(0, count));
      else if (count === 0 || count === -5) {
        this.exited = true;
        this.emit("change");
        break;
      } else if (count === -4) continue;
      else if (count === -11 || count === -35) break;
      else {
        this.emit("ioError", Error(`ReadFailed:${count}`));
        break;
      }
    }
  }
  feed(bytes: Uint8Array | string): void {
    const data = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
    if (data.length) n.terminal_feed(this.handle, ptr(data), data.length);
    this.dirty = true;
    this.emit("change");
  }
  read(): boolean {
    this.drain();
    const dirty = this.dirty || false;
    this.dirty = false;
    let changed = false;
    if (!this.paused) {
      const tick = this.native({ op: "tick", exited: this.exited });
      changed = tick.changed;
      this.waiting = tick.expecting;
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
    this.native({ op: "flush" });
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
    return this.native({ op: "liveText" });
  }
  snapshot(): Buffer {
    return Buffer.from(this.native({ op: "snapshot" }));
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
    return surface.view(this.native({ op: "surface", pane, offset }));
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
    return this.native({ op: "takeCopied" });
  }
  /** Discards input the program has not read yet. */
  dropPending(): void {
    this.native({ op: "takePending" });
  }
  restore(bytes: Uint8Array): void {
    this.native({ op: "restore", text: Buffer.from(bytes).toString() });
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
