import assert from "node:assert/strict";
import { Socket, type SocketConnectOpts } from "node:net";
import { dlopen, ptr, suffix, FFIType, type Pointer } from "bun:ffi";
import { n } from "./native_ffi";
import { nativeRoot } from "./native_paths";

export const native = dlopen(`${nativeRoot}/lib/libcorgi_fd.${suffix}`, {
  fd_loop_new: { args: ["ptr"], returns: "ptr" },
  fd_loop_arm: { args: ["ptr", "i32", "u32", "u32"], returns: "i32" },
  fd_loop_stats: { args: ["ptr", "ptr"], returns: "void" },
  fd_loop_free: { args: ["ptr"], returns: "void" },
  fd_raw: { args: ["i32"], returns: "i32" },
  fd_cpu_ns: { args: [], returns: FFIType.u64_fast },
  fd_cloexec: { args: ["i32"], returns: "i32" },
  fd_try_lock: { args: ["i32"], returns: "i32" },
}).symbols;

export const READ = 1, WRITE = 4;
export const wouldBlock = (result: number) => result === -11 || result === -35;
export class ReadyLoop {
  private handle: Pointer|bigint|null;
  private socket: Socket;
  private next = 1;
  private callbacks = new Map<number, (events: number) => void>();
  stale = 0;
  callbacksRun = 0;
  constructor() {
    const fd = new Int32Array(1);
    this.handle = native.fd_loop_new(ptr(fd))!;
    assert(this.handle, "native readiness loop allocation");
    // Bun's imported-FD connect overload is absent from Node's declarations.
    this.socket = new Socket().connect({ fd: fd[0] } as unknown as SocketConnectOpts);
    let pending:Buffer = Buffer.alloc(0);
    this.socket.on("data", (chunk: Buffer) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let offset = 0;
      while (offset + 8 <= pending.length) {
        const token = pending.readUInt32LE(offset), events = pending.readUInt32LE(offset + 4);
        offset += 8;
        const callback = this.callbacks.get(token);
        if (callback) { this.callbacksRun++; callback(events); }
        else this.stale++;
      }
      pending = pending.subarray(offset);
    });
    this.socket.on("error", error => { throw error; });
  }
  watch(fd: number, callback: (events: number) => void) {
    assert.equal(n.probe_nonblock(fd), 0);
    const token = this.next++;
    assert(token < 0xffffffff);
    this.callbacks.set(token, callback);
    let active = true;
    return {
      arm: (events: number) => {
        assert(active && this.handle, "arming a closed registration");
        assert.equal(native.fd_loop_arm(this.handle, fd, token, events), 0);
      },
      close: () => {
        if (!active) return;
        active = false;
        this.callbacks.delete(token);
        if (this.handle) assert.equal(native.fd_loop_arm(this.handle, fd, token, 0), 0);
      },
    };
  }
  stats() {
    const out = new BigUint64Array(2);
    native.fd_loop_stats(this.handle, ptr(out));
    return { waits: Number(out[0]), events: Number(out[1]), callbacks: this.callbacksRun, stale: this.stale };
  }
  close() {
    if (!this.handle) return;
    this.callbacks.clear();
    native.fd_loop_free(this.handle);
    this.handle = null;
    this.socket.destroy();
  }
}

// One outstanding wait per direction. No timer or periodic readiness scan.
export class AsyncFD {
  private readWake?: () => void;
  private writeWake?: () => void;
  private watch;
  constructor(private loop: ReadyLoop, readonly fd: number) {
    this.watch = loop.watch(fd, () => {
      const r = this.readWake, w = this.writeWake;
      this.readWake = this.writeWake = undefined;
      r?.(); w?.();
    });
  }
  private wait(writing: boolean) {
    return new Promise<void>(resolve => {
      if (writing) { assert(!this.writeWake); this.writeWake = resolve; }
      else { assert(!this.readWake); this.readWake = resolve; }
      this.watch.arm((this.readWake ? READ : 0) | (this.writeWake ? WRITE : 0));
    });
  }
  async read(buffer: Buffer) {
    for (;;) {
      const count = n.probe_read(this.fd, ptr(buffer), buffer.length);
      if (count >= 0) return count;
      if (count === -5) return 0; // Linux PTY slave hangup.
      if (count === -4) continue;
      assert(wouldBlock(count), `read fd ${this.fd}: ${count}`);
      await this.wait(false);
    }
  }
  async write(buffer: Buffer) {
    let offset = 0;
    while (offset < buffer.length) {
      const slice = buffer.subarray(offset);
      const count = n.probe_write(this.fd, ptr(slice), slice.length);
      if (count > 0) offset += count;
      else if (count === -4) continue;
      else { assert(wouldBlock(count), `write fd ${this.fd}: ${count}`); await this.wait(true); }
    }
  }
  close() {
    assert(!this.readWake && !this.writeWake, "close only after outstanding operations settle");
    this.watch.close();
    assert.equal(n.probe_close(this.fd), 0);
  }
}
