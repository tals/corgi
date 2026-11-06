import { test, expect, spyOn } from "bun:test";
import { toBuffer, type Pointer } from "bun:ffi";
import * as fs from "node:fs";
import { Output } from "./terminal_output";
import { pair, n, ptr } from "./native_ffi";

async function until(test: () => boolean) {
  const end = Date.now() + 3000;
  while (!test()) {
    if (Date.now() > end) throw Error("Timeout");
    await Bun.sleep(1);
  }
}

test("blocked terminal output yields to timers and preserves partial frames, images and controls", async () => {
  const [writer, reader] = pair(),
    flags = n.probe_flags(writer, -1),
    output = new Output(writer);
  n.probe_nonblock(reader);
  try {
    const frame = Buffer.alloc(8 * 1024 * 1024, 120),
      tail = Buffer.from("\x1b_Ga=d\x1b\\\x1b[?25h");
    output.write(frame);
    output.write(tail);
    expect(output.pending).toBeGreaterThan(0);
    let drained = false;
    const draining = output.drain().then(() => {
      drained = true;
    });
    let timer = false;
    setTimeout(() => {
      timer = true;
    }, 5);
    await until(() => timer);
    expect(drained).toBe(false);
    expect(output.pending).toBeGreaterThan(0);
    const chunks: Buffer[] = [],
      scratch = Buffer.alloc(65536);
    await until(() => {
      for (;;) {
        const count = n.probe_read(reader, ptr(scratch), scratch.length);
        if (count <= 0) break;
        chunks.push(Buffer.from(scratch.subarray(0, count)));
      }
      return chunks.reduce((size, chunk) => size + chunk.length, 0) === frame.length + tail.length;
    });
    await draining;
    expect(drained).toBe(true);
    expect(Buffer.concat(chunks)).toEqual(Buffer.concat([frame, tail]));
    expect(output.pending).toBe(0);
  } finally {
    output.close();
    expect(n.probe_flags(writer, -1) & fs.constants.O_NONBLOCK).toBe(flags & fs.constants.O_NONBLOCK);
    n.probe_close(writer);
    n.probe_close(reader);
  }
});

test("terminal queue admission is bounded and closing wakes a drain", async () => {
  const [writer, reader] = pair(),
    output = new Output(writer);
  try {
    output.write(Buffer.alloc(16 * 1024 * 1024, 120));
    expect(() => output.write(Buffer.alloc(1024 * 1024))).toThrow("OutputBackpressure");
    const drained = output.drain();
    output.close();
    await expect(drained).rejects.toThrow("OutputClosed");
  } finally {
    output.close();
    n.probe_close(writer);
    n.probe_close(reader);
  }
});

test("emergency resets bypass queued output, retry a blocked write and restore descriptor flags", () => {
  const [writer, reader] = pair(),
    flags = n.probe_flags(writer, -1),
    output = new Output(writer);
  const native = n as unknown as {
    probe_write(fd: number, data: Pointer, length: number): number;
    probe_writable(fd: number, timeout: number): number;
  };
  let blocked = true,
    attempts = 0;
  const received: Buffer[] = [],
    write = spyOn(native, "probe_write").mockImplementation((_fd, data, length) => {
      if (blocked) return -11;
      received.push(Buffer.from(toBuffer(data, 0, Math.min(2, length))));
      return Math.min(2, length);
    }),
    writable = spyOn(native, "probe_writable").mockImplementation((_fd, timeout) => {
      expect(timeout).toBeGreaterThan(0);
      expect(timeout).toBeLessThanOrEqual(500);
      blocked = false;
      attempts++;
      return 1;
    });
  try {
    output.write(Buffer.alloc(16 * 1024 * 1024, 120));
    const reset = "\x1b[?2026l\x1b[?25h\x1b[?1002l\x1b[?1049l";
    output.emergency(reset);
    expect(Buffer.concat(received).toString()).toBe("\x18\x1b\\" + reset);
    expect(attempts).toBe(1);
    expect(output.pending).toBe(0);
    expect(n.probe_flags(writer, -1) & fs.constants.O_NONBLOCK).toBe(flags & fs.constants.O_NONBLOCK);
  } finally {
    write.mockRestore();
    writable.mockRestore();
    output.close();
    n.probe_close(writer);
    n.probe_close(reader);
  }
});

test.each(["OutputTimeout", "OutputBackpressure"])("detach resends its terminal reset after %s", async failure => {
  const [writer, reader] = pair(),
    output = new Output(writer),
    flags = n.probe_flags(reader, -1),
    reset = "\x1b[?25h\x1b[?1002l\x1b[?1049l",
    emergency = spyOn(output, "emergency");
  n.probe_nonblock(reader);
  const drain = spyOn(output, "drain").mockRejectedValue(Error("OutputTimeout"));
  try {
    if (failure === "OutputBackpressure") output.write(Buffer.alloc(16 * 1024 * 1024, 120));
    // Free the socket, leaving any admitted frame in the output queue.
    const scratch = Buffer.alloc(65536);
    while (n.probe_read(reader, ptr(scratch), scratch.length) > 0) {}
    await expect(output.finish(reset)).rejects.toThrow(failure);
    expect(emergency).toHaveBeenCalledWith(reset);
    const chunks: Buffer[] = [];
    for (;;) {
      const count = n.probe_read(reader, ptr(scratch), scratch.length);
      if (count <= 0) break;
      chunks.push(Buffer.from(scratch.subarray(0, count)));
    }
    expect(Buffer.concat(chunks).toString()).toEndWith("\x18\x1b\\" + reset);
    expect(output.pending).toBe(0);
  } finally {
    drain.mockRestore();
    emergency.mockRestore();
    output.close();
    n.probe_flags(reader, flags);
    n.probe_close(writer);
    n.probe_close(reader);
  }
});
