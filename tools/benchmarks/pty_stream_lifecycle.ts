/** Public stream lifetime proof before any throughput comparison. Linux only. */
import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Socket, type SocketConnectOpts } from "node:net";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { dlopen, ptr } from "bun:ffi";
import { ReadyLoop, READ, WRITE, wouldBlock } from "../../src/fd_loop";
import { n } from "../../src/native_ffi";
import * as benchmark from "./cpu_lock";

const library = resolve(process.argv[2]),
  helper = dlopen(library, {
    pty_fixture_open: { args: ["ptr"], returns: "i32" },
    pty_fixture_writer: { args: ["i32", "ptr", "usize"], returns: "ptr" },
    pty_fixture_writer_ex: { args: ["i32", "ptr", "usize", "i32", "i32"], returns: "ptr" },
    pty_fixture_status: { args: ["ptr", "ptr"], returns: "void" },
    pty_fixture_stop: { args: ["ptr"], returns: "usize" },
  }).symbols,
  release = await benchmark.acquire();
type Mode = "ready" | "web" | "node-sync" | "node-microtask";
type Owner = {
  stop(): Promise<void>;
  tryStop?(bytes: number, ms: number): Promise<boolean>;
  chunks: Buffer[];
  errors: string[];
  maxDeliveredPerPass: number;
  stopped: boolean;
};
const pause = () => new Promise<void>(resolve => setImmediate(resolve));
function code(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : String(error);
}
function sha(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}
function rawRead(fd: number) {
  const buffer = Buffer.alloc(65536),
    chunks: Buffer[] = [];
  for (let count = 0; count < 4096; count++) {
    const got = n.probe_read(fd, ptr(buffer), buffer.length);
    if (got > 0) chunks.push(Buffer.from(buffer.subarray(0, got)));
    else if (got === -4) continue;
    else if (got === 0 || got === -5 || wouldBlock(got)) return Buffer.concat(chunks);
    else throw Error(`read: ${got}`);
  }
  throw Error("raw drain exceeded fixture bound");
}
async function remainderAfterStop(fd: number, expected: number) {
  const chunks: Buffer[] = [];
  let size = 0,
    quiet = 0;
  const deadline = Date.now() + 100;
  // A successful slave write can still be in the tty flip/line-discipline queue.
  // Only the original master is read here; the candidate has already stopped.
  while (Date.now() < deadline) {
    const chunk = rawRead(fd);
    if (chunk.length) {
      chunks.push(chunk);
      size += chunk.length;
      quiet = 0;
    } else quiet++;
    if (size >= expected && quiet >= 2) break;
    await Bun.sleep(1);
  }
  return Buffer.concat(chunks);
}
function owner(mode: Mode, fd: number, first?: () => void, publication?: (publish: () => void) => void): Owner {
  const result: Owner = {
    stop: async () => {},
    chunks: [],
    errors: [],
    maxDeliveredPerPass: 0,
    stopped: false,
  };
  const accept = (chunk: Uint8Array) => {
    result.chunks.push(Buffer.from(chunk));
    if (first) {
      const callback = first;
      first = undefined;
      callback();
    }
  };
  if (mode === "ready") {
    const loop = new ReadyLoop(),
      buffer = Buffer.alloc(65536);
    const watch = loop.watch(fd, () => {
      let delivered = 0;
      for (let i = 0; i < 8 && !result.stopped; i++) {
        const got = n.probe_read(fd, ptr(buffer), buffer.length);
        if (got > 0) {
          delivered += got;
          accept(buffer.subarray(0, got));
        } else if (got === -4) continue;
        else if (wouldBlock(got)) break;
        else {
          if (got !== 0 && got !== -5) result.errors.push(String(got));
          break;
        }
      }
      result.maxDeliveredPerPass = Math.max(result.maxDeliveredPerPass, delivered);
      if (!result.stopped) watch.arm(READ);
    });
    watch.arm(READ);
    result.stop = async () => {
      if (result.stopped) return;
      result.stopped = true;
      watch.close();
      loop.close();
    };
    return result;
  }
  const web = Bun.file(fd).stream();
  if (mode === "web") {
    const reader = web.getReader();
    const work = (async () => {
      try {
        let delivered = 0;
        while (!result.stopped) {
          const chunk = await reader.read();
          if (chunk.done) break;
          // A read settled before stop still belongs to this owner.
          accept(chunk.value);
          delivered += chunk.value.length;
          result.maxDeliveredPerPass = Math.max(result.maxDeliveredPerPass, delivered);
          if (delivered >= 8 * 65536) {
            await pause();
            delivered = 0;
          }
        }
      } catch (error) {
        result.errors.push(code(error));
      }
    })();
    result.stop = async () => {
      if (result.stopped) return;
      result.stopped = true;
      try {
        await reader.cancel();
      } catch (error) {
        // Cancellation of an already-errored Web stream repeats its read error.
        if (code(error) !== "EIO") throw error;
        if (!result.errors.includes("EIO")) result.errors.push("EIO");
      }
      await work;
      reader.releaseLock();
    };
    return result;
  }
  const options = { highWaterMark: 65536, autoDestroy: false };
  const stream = Readable.fromWeb(web as unknown as NodeReadableStream, options);
  let queued = false;
  stream.on("error", error => result.errors.push(code(error)));
  const pump = () => {
    queued = false;
    if (result.stopped) return;
    let delivered = 0;
    for (let i = 0; i < 8 && !result.stopped; i++) {
      if (!stream.readableLength) stream.read(0);
      if (!stream.readableLength) break;
      const chunk = stream.read(Math.min(65536, stream.readableLength)) as Buffer | null;
      if (!chunk) break;
      delivered += chunk.length;
      accept(chunk);
    }
    result.maxDeliveredPerPass = Math.max(result.maxDeliveredPerPass, delivered);
    if (stream.readableLength && !result.stopped) schedule();
  };
  const schedule = () => {
    if (queued || result.stopped) return;
    queued = true;
    setImmediate(pump);
  };
  stream.on("readable", schedule);
  if (publication) {
    const original = Promise.prototype.then;
    let intercepted = false;
    Promise.prototype.then = function (this: Promise<unknown>, fulfilled, rejected) {
      if (intercepted) return original.call(this, fulfilled, rejected);
      intercepted = true;
      return original.call(this, value => publication(() => fulfilled?.(value)), rejected);
    } as typeof Promise.prototype.then;
    try {
      stream.read(0);
    } finally {
      Promise.prototype.then = original;
    }
    assert.ok(intercepted, "did not intercept the empty-PTY native pending pull");
  } else stream.read(0);
  const quiesce = async (budget: number, ms: number) => {
    if (result.stopped) return true;
    result.stopped = true;
    stream.pause();
    stream.off("readable", schedule);
    if (mode === "node-microtask") await Promise.resolve();
    const deadline = performance.now() + ms;
    let bytes = 0;
    // Candidate handoff sequence under examination, not an assumed guarantee.
    for (let i = 0; ; i++) {
      assert.ok(i < 4096, "stream drain exceeded fixture bound");
      if (bytes >= budget || performance.now() >= deadline) {
        result.stopped = false;
        stream.on("readable", schedule);
        schedule();
        return false;
      }
      if (!stream.readableLength) stream.read(0);
      if (!stream.readableLength) break;
      const chunk = stream.read(Math.min(65536, budget - bytes, stream.readableLength)) as Buffer | null;
      if (chunk === null) break;
      bytes += chunk.length;
      accept(chunk);
    }
    const closed = new Promise<void>(resolve => stream.once("close", resolve));
    stream.destroy();
    await closed;
    await Promise.resolve();
    return true;
  };
  result.tryStop = quiesce;
  result.stop = async () => {
    await quiesce(Infinity, Infinity);
  };
  return result;
}

const rows: object[] = [];
async function extended(
  mode: "node-sync" | "node-microtask",
  when: "pending" | "publication-gate" | "socket-order" | "flood",
  iteration: number,
) {
  const fds = new Int32Array(2),
    signal = new Int32Array(2),
    data = Buffer.alloc(256 * 1024);
  assert.equal(helper.pty_fixture_open(ptr(fds)), 0);
  for (let i = 0; i < data.length; i++) data[i] = (i * 11 + (i >>> 8)) & 255;
  const [master, slave] = fds;
  let stop: Promise<void> | undefined,
    socket: Socket | undefined,
    writer: ReturnType<typeof helper.pty_fixture_writer> = null,
    accepted = 0,
    gateCalls = 0,
    ticks = 0,
    rollback = false,
    resumedBytes = 0,
    forcedRollbackBytes = 0;
  const read = owner(
    mode,
    master,
    undefined,
    when === "publication-gate"
      ? publish => {
          gateCalls++;
          queueMicrotask(publish);
          stop = read.stop();
        }
      : undefined,
  );
  const timer = setInterval(() => ticks++, 1);
  try {
    if (when === "pending") {
      await read.stop();
      const marker = data.subarray(0, 512);
      assert.equal(n.probe_write(slave, ptr(marker), marker.length), marker.length);
      accepted = marker.length;
    } else {
      if (when === "socket-order") {
        assert.equal(n.probe_pair(ptr(signal)), 0);
        socket = new Socket().connect({ fd: signal[0] } as unknown as SocketConnectOpts);
        socket.once("data", () => {
          stop = read.stop();
        });
      }
      writer = helper.pty_fixture_writer_ex(
        slave,
        ptr(data),
        data.length,
        when === "flood" ? 1 : 0,
        socket ? signal[1] : -1,
      );
      assert.ok(writer);
      const deadline = Date.now() + 2000;
      if (when === "flood") {
        await Bun.sleep(25);
        const beforeForced = read.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        assert.equal(await read.tryStop!(0, 0), false, "zero budget must abort without destroying reader");
        await Bun.sleep(5);
        forcedRollbackBytes = read.chunks.reduce((sum, chunk) => sum + chunk.length, 0) - beforeForced;
        assert.ok(forcedRollbackBytes > 0, "forced rollback did not resume delivery");
        const before = read.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        rollback = !(await read.tryStop!(512 * 1024, 2));
        if (rollback) {
          await Bun.sleep(10);
          resumedBytes = read.chunks.reduce((sum, chunk) => sum + chunk.length, 0) - before;
          assert.ok(resumedBytes > 0, "rollback did not resume delivery");
        }
      } else {
        while (!stop) {
          assert.ok(Date.now() < deadline, "stop trigger missing");
          await Bun.sleep(1);
        }
        await stop;
      }
      accepted = Number(helper.pty_fixture_stop(writer));
      writer = null;
      await read.stop();
    }
    const delivered = Buffer.concat(read.chunks),
      remainder = await remainderAfterStop(master, accepted - delivered.length),
      combined = Buffer.concat([delivered, remainder]);
    let exact = combined.length === accepted;
    for (let i = 0; i < combined.length && exact; i++) exact = combined[i] === data[i % data.length];
    assert.ok(n.probe_isatty(master), "original descriptor closed");
    assert.ok(read.maxDeliveredPerPass <= 512 * 1024, "ordinary pump exceeded delivery fairness budget");
    const row = {
      mode,
      when,
      iteration,
      exact,
      accepted,
      delivered: delivered.length,
      remaining: remainder.length,
      missing: accepted - combined.length,
      rollback,
      resumedBytes,
      forcedRollbackBytes,
      gateCalls,
      ticks,
      maxDeliveredPerPass: read.maxDeliveredPerPass,
      errors: read.errors,
    };
    rows.push(row);
    console.log(JSON.stringify({ type: "case", ...row }));
    if (when === "pending" || when === "flood") assert.ok(exact, "bounded stop/rollback lost bytes");
  } catch (error) {
    console.log(JSON.stringify({ type: "failure", mode, when, iteration, error: String(error) }));
    throw error;
  } finally {
    clearInterval(timer);
    if (writer) helper.pty_fixture_stop(writer);
    await read.stop();
    socket?.destroy();
    if (socket) n.probe_close(signal[1]);
    n.probe_close(master);
    n.probe_close(slave);
  }
}
async function duplex(mode: Mode) {
  const fds = new Int32Array(2);
  assert.equal(helper.pty_fixture_open(ptr(fds)), 0);
  const [master, slave] = fds,
    input = Buffer.alloc(256 * 1024),
    output = Buffer.alloc(512 * 1024);
  for (let i = 0; i < input.length; i++) input[i] = (i * 31 + (i >>> 8)) & 255;
  for (let i = 0; i < output.length; i++) output[i] = (i * 19 + (i >>> 9)) & 255;
  const read = owner(mode, master),
    writes = new ReadyLoop();
  let offset = 0,
    blocked = 0,
    writer = helper.pty_fixture_writer(slave, ptr(output), output.length);
  assert.ok(writer);
  const flush = () => {
    for (let i = 0; i < 8 && offset < input.length; i++) {
      const bytes = input.subarray(offset, offset + 65536),
        count = n.probe_write(master, ptr(bytes), bytes.length);
      if (count > 0) offset += count;
      else if (count === -4) continue;
      else {
        assert.ok(wouldBlock(count), `write: ${count}`);
        blocked++;
        break;
      }
    }
    watch.arm(offset < input.length ? WRITE : 0);
  };
  const watch = writes.watch(master, flush),
    received: Buffer[] = [];
  let receivedBytes = 0;
  try {
    // Fill the input side before letting the peer consume it, ensuring WRITE
    // readiness is needed while the independent stream owns output reads.
    flush();
    const deadline = Date.now() + 4000;
    while (receivedBytes < input.length || Buffer.concat(read.chunks).length < output.length) {
      assert.ok(Date.now() < deadline, "duplex fixture stalled");
      const chunk = rawRead(slave);
      received.push(chunk);
      receivedBytes += chunk.length;
      await Bun.sleep(1);
    }
    assert.equal(Number(helper.pty_fixture_stop(writer)), output.length);
    writer = null;
    await read.stop();
    assert.ok(blocked > 0, "fixture did not exercise pending WRITE interest");
    assert.deepEqual(Buffer.concat(received), input, "queued input reordered");
    assert.deepEqual(Buffer.concat(read.chunks), output, "concurrent output reordered");
    const row = {
      mode,
      when: "duplex",
      exact: true,
      blocked,
      inputBytes: offset,
      outputBytes: output.length,
      errors: read.errors,
      maxDeliveredPerPass: read.maxDeliveredPerPass,
    };
    rows.push(row);
    console.log(JSON.stringify({ type: "case", ...row }));
  } catch (error) {
    console.log(JSON.stringify({ type: "failure", mode, when: "duplex", error: String(error) }));
    throw error;
  } finally {
    if (writer) helper.pty_fixture_stop(writer);
    watch.close();
    writes.close();
    await read.stop();
    n.probe_close(master);
    n.probe_close(slave);
  }
}
try {
  if (process.argv.includes("--extended")) {
    for (const mode of ["node-sync", "node-microtask"] as const) {
      for (const when of ["pending", "publication-gate", "socket-order", "flood"] as const) {
        for (let i = 0; i < (when === "socket-order" ? 32 : when === "flood" ? 4 : 1); i++)
          await extended(mode, when, i);
      }
    }
  } else
    for (const mode of ["ready", "web", "node-sync", "node-microtask"] as const) {
      await duplex(mode);
      for (const when of ["idle", "first-chunk", "queued", "complete", "hangup", "hangup-tail"] as const) {
        for (let iteration = 0; iteration < (when === "first-chunk" || when === "queued" ? 12 : 1); iteration++) {
          const fds = new Int32Array(2);
          assert.equal(helper.pty_fixture_open(ptr(fds)), 0);
          const [master, slave] = fds;
          const data = Buffer.alloc(2 * 1024 * 1024);
          for (let i = 0; i < data.length; i++) data[i] = (i * 17 + Math.floor(i / 251)) & 255;
          let stop: Promise<void> | undefined,
            accepted = 0,
            slaveClosed = false;
          const read = owner(
            mode,
            master,
            when === "first-chunk"
              ? () => {
                  stop = read.stop();
                }
              : undefined,
          );
          let writer = when === "idle" ? null : helper.pty_fixture_writer(slave, ptr(data), data.length);
          assert.ok(when === "idle" || writer);
          const stopWriter = () => {
            if (!writer) return;
            accepted = Number(helper.pty_fixture_stop(writer));
            writer = null;
          };
          const status = new BigUint64Array(3);
          try {
            if (when === "queued") await pause();
            else if (when !== "idle") {
              const deadline = Date.now() + 4000;
              while (!stop && Buffer.concat(read.chunks).length < data.length) {
                helper.pty_fixture_status(writer, ptr(status));
                assert.equal(Number(status[2]), 0, "producer write failed");
                if (when === "hangup-tail" && status[1]) break;
                assert.ok(Date.now() < deadline, "reader did not deliver complete fixture");
                await Bun.sleep(1);
              }
            }
            if (when === "hangup" || when === "hangup-tail") {
              stopWriter();
              assert.equal(n.probe_close(slave), 0);
              slaveClosed = true;
              await pause();
              await pause();
            }
            await (stop ?? read.stop());
            stopWriter();
            const delivered = Buffer.concat(read.chunks),
              remainder = await remainderAfterStop(master, accepted - delivered.length);
            const combined = Buffer.concat([delivered, remainder]),
              expected = data.subarray(0, accepted);
            // An open original master is required after destroying the stream's duplicate.
            const stillOpen = n.probe_isatty(master) === 1;
            const row = {
              mode,
              when,
              iteration,
              accepted,
              delivered: delivered.length,
              remaining: remainder.length,
              exact: combined.equals(expected),
              missing: accepted - combined.length,
              stillOpen,
              errors: read.errors,
              maxDeliveredPerPass: read.maxDeliveredPerPass,
              sha: sha(combined),
              expectedSha: sha(expected),
            };
            rows.push(row);
            console.log(JSON.stringify({ type: "case", ...row }));
            assert.ok(stillOpen, "stream closed the original PTY master");
            if (mode === "ready") assert.deepEqual(combined, expected, "baseline lost or reordered bytes");
          } catch (error) {
            console.log(JSON.stringify({ type: "failure", mode, when, iteration, error: String(error) }));
            throw error;
          } finally {
            stopWriter();
            await read.stop();
            n.probe_close(master);
            if (!slaveClosed) n.probe_close(slave);
          }
        }
      }
    }
  console.log(
    JSON.stringify(
      {
        type: "summary",
        bun: Bun.version,
        revision: Bun.revision,
        helper: library,
        helperSha: sha(readFileSync(library)),
        sourceSha: sha(readFileSync(import.meta.filename)),
        purpose: "lifetime correctness only; fixture copies and polling are not performance evidence",
        rows,
      },
      null,
      2,
    ),
  );
} finally {
  await release();
}
