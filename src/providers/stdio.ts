//! A provider process Corgi starts, speaking JSON lines on its stdin and
//! stdout. Clients that run their provider themselves build on it; a handoff
//! passes its pipes to the next daemon.
import { n, ptr } from "../native_bridge";
import { native as fdNative } from "../fd_loop";
import * as json from "../json";
import * as binary from "../base64";
import { max_image_bytes, max_images, type Saved } from "./adapter";
/** Room for an accepted prompt's inline images, plus its text and controls.
 * Providers may echo the same images back in a user message. */
const max_output = 1024 * 1024,
  max_prompt = max_images * Math.ceil(max_image_bytes / 3) * 4 + max_output,
  max_line = max_prompt + 4 * 1024 * 1024;
function pipe() {
  const fds = new Int32Array(2);
  if (n.probe_pipe(ptr(fds)) !== 0) throw Error("PipeFailed");
  return [...fds];
}
export class Stdio {
  pid = -1;
  stdin = -1;
  stdout = -1;
  input: Buffer = Buffer.alloc(0);
  output: Buffer = Buffer.alloc(0);
  /** A process restored from a handoff stays the old daemon's until adopted. */
  owner: "runtime" | "handoff" = "runtime";
  exited = false;
  closed = false;
  static spawn(
    command: string[],
    options: { cwd: string; env?: Record<string, string | undefined>; stderr?: "inherit" | "ignore" },
  ): Stdio {
    const io = new Stdio(),
      [childInput, parentInput] = pipe(),
      [parentOutput, childOutput] = pipe();
    try {
      const child = Bun.spawn(command, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdin: childInput,
        stdout: childOutput,
        stderr: options.stderr ?? "ignore",
        detached: true,
      });
      io.pid = child.pid;
      void child.exited.then(() => {
        io.exited = true;
      });
    } catch (error) {
      n.probe_close(parentInput);
      n.probe_close(parentOutput);
      throw error;
    } finally {
      n.probe_close(childInput);
      n.probe_close(childOutput);
    }
    io.stdin = parentInput;
    io.stdout = parentOutput;
    for (const fd of [io.stdin, io.stdout]) {
      n.probe_nonblock(fd);
      fdNative.fd_cloexec(fd);
    }
    return io;
  }
  write(value: unknown) {
    if (this.closed || this.exited) throw Error("HeadlessExited");
    const line = Buffer.from(json.stringify(value) + "\n");
    if (this.output.length + line.length - 1 > max_prompt) throw Error("HeadlessBackpressure");
    this.output = Buffer.concat([this.output, line]);
  }
  /** Queues a tool reply, or waits for earlier output to drain. One large
   * reply can fill an empty buffer; an exited process needs no reply. */
  reply(value: unknown): boolean {
    if (this.closed || this.exited) return true;
    const line = Buffer.from(json.stringify(value) + "\n");
    if (this.output.length && this.output.length + line.length - 1 > max_output) return false;
    this.output = Buffer.concat([this.output, line]);
    return true;
  }
  flush() {
    while (this.output.length && this.stdin >= 0) {
      const size = n.probe_write(this.stdin, ptr(this.output), this.output.length);
      if (size <= 0) break;
      this.output = this.output.subarray(size);
    }
  }
  /** The JSON values it printed since the last call; a line that isn't JSON is skipped. */
  read(): unknown[] {
    const values: unknown[] = [];
    if (this.closed) return values;
    this.flush();
    const buffer = Buffer.alloc(16384);
    for (let i = 0; i < 8 && this.stdout >= 0; i++) {
      const size = n.probe_read(this.stdout, ptr(buffer), buffer.length);
      if (size <= 0) {
        if (size === 0) this.exited = true;
        break;
      }
      this.input = Buffer.concat([this.input, buffer.subarray(0, size)]);
      if (this.input.length > max_line) throw Error("HeadlessMessageTooLarge");
      let end: number;
      while ((end = this.input.indexOf(10)) >= 0) {
        const line = this.input.subarray(0, end).toString();
        this.input = Buffer.from(this.input.subarray(end + 1));
        if (!line.trim()) continue;
        try {
          values.push(json.parse(line));
        } catch {}
      }
    }
    return values;
  }
  async wait(deadline: number) {
    await Bun.sleep(Math.max(0, Math.min(10, deadline - Date.now())));
  }
  save(live: boolean): Saved {
    return {
      state: {
        pid: live ? this.pid : -1,
        input: binary.encode(live ? this.input : Buffer.alloc(0)),
        output: binary.encode(live ? this.output : Buffer.alloc(0)),
        exited: this.exited,
      },
      handles: live ? [this.stdin, this.stdout] : [],
    };
  }
  /** The process a handoff passed on, or, from a cold checkpoint, one that is gone. */
  static restore(saved: Saved, live: boolean): Stdio {
    const io = new Stdio(),
      state: any = saved.state ?? {};
    io.owner = "handoff";
    io.exited = !live || state.exited === true;
    if (live) io.pid = Number(state.pid ?? -1);
    if (live && saved.handles.length === 2 && saved.handles.every(fd => fd >= 0)) {
      [io.stdin, io.stdout] = saved.handles;
      io.input = binary.decode(state.input ?? "");
      io.output = binary.decode(state.output ?? "");
      for (const fd of saved.handles) fdNative.fd_cloexec(fd);
    }
    return io;
  }
  adopt() {
    this.owner = "runtime";
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.owner === "runtime" && !this.exited && this.pid > 0)
      try {
        process.kill(-this.pid, "SIGKILL");
      } catch {
        try {
          process.kill(this.pid, "SIGKILL");
        } catch {}
      }
    for (const fd of [this.stdin, this.stdout]) if (fd >= 0) n.probe_close(fd);
    this.stdin = this.stdout = -1;
  }
}
