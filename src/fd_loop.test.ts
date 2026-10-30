import { expect, spyOn, test } from "bun:test";
import { native, ReadyLoop, READ, WRITE, wouldBlock } from "./fd_loop";
import { n, pair, ptr } from "./native_ffi";

// Inject transport records without depending on when the reporter thread runs.
function controlled() {
  const loop = new ReadyLoop(),
    [fd, peer] = pair(),
    arm = spyOn(native, "fd_loop_arm").mockReturnValue(0);
  return {
    loop,
    fd,
    arm,
    token: () => Number(arm.mock.calls.at(-1)![2]),
    notify(token: number, events = READ) {
      const bytes = Buffer.alloc(8);
      bytes.writeUInt32LE(token);
      bytes.writeUInt32LE(events, 4);
      loop["socket"].emit("data", bytes);
    },
    close() {
      arm.mockRestore();
      loop.close();
      n.probe_close(fd);
      n.probe_close(peer);
    },
  };
}

test("unchanged interests share one arm until a notification is dispatched", () => {
  const f = controlled();
  let delivered = 0;
  try {
    const watch = f.loop.watch(f.fd, () => {
      delivered++;
      watch.arm(READ);
      watch.arm(READ);
    });
    watch.arm(READ);
    const token = f.token();
    watch.arm(READ);
    watch.arm(READ);
    expect(f.arm).toHaveBeenCalledTimes(1);
    f.notify(token);
    expect(delivered).toBe(1);
    expect(f.arm).toHaveBeenCalledTimes(2);
    f.notify(token);
    expect(delivered).toBe(2);
    expect(f.arm).toHaveBeenCalledTimes(3);
    watch.close();
    watch.close();
    expect(f.arm).toHaveBeenCalledTimes(4);
    expect(f.arm.mock.calls.at(-1)![3]).toBe(0);
    expect(() => watch.arm(READ)).toThrow("arming a closed registration");
  } finally {
    f.close();
  }
});

test("duplicate watches invalidate each other when ownership changes or either closes", () => {
  const f = controlled();
  try {
    const original = f.loop.watch(f.fd, () => {}),
      temporary = f.loop.watch(f.fd, () => {});
    original.arm(READ);
    const originalToken = f.token();
    temporary.arm(READ);
    expect(f.token()).not.toBe(originalToken);
    temporary.arm(READ);
    expect(f.arm).toHaveBeenCalledTimes(2);
    temporary.close();
    original.arm(READ);
    expect(f.arm).toHaveBeenCalledTimes(4);
    expect(f.token()).toBe(originalToken);
    const other = f.loop.watch(f.fd, () => {});
    other.arm(READ);
    original.close();
    other.arm(READ);
    expect(f.arm).toHaveBeenCalledTimes(7);
    other.close();
  } finally {
    f.close();
  }
});

test("queued older notifications force rearming current read and write interests", () => {
  const f = controlled();
  let desired = READ | WRITE;
  try {
    const watch = f.loop.watch(f.fd, () => watch.arm(desired));
    watch.arm(desired);
    const token = f.token();
    desired = READ;
    watch.arm(desired);
    expect(f.arm).toHaveBeenCalledTimes(2);
    // macOS can deliver the old WRITE filter separately after it was deleted.
    f.notify(token, WRITE);
    expect(f.arm).toHaveBeenCalledTimes(3);
    expect(f.arm.mock.calls.at(-1)![3]).toBe(READ);
    f.notify(token, READ);
    expect(f.arm).toHaveBeenCalledTimes(4);
    desired = READ | WRITE;
    watch.arm(desired);
    watch.arm(desired);
    expect(f.arm).toHaveBeenCalledTimes(5);
    f.notify(token, READ);
    expect(f.arm).toHaveBeenCalledTimes(6);
    expect(f.arm.mock.calls.at(-1)![3]).toBe(READ | WRITE);
    watch.close();
  } finally {
    f.close();
  }
});

test("a queued sibling event cannot preserve a newer registration's cached arm", () => {
  const f = controlled();
  try {
    const old = f.loop.watch(f.fd, () => {}),
      current = f.loop.watch(f.fd, () => {});
    old.arm(READ);
    const oldToken = f.token();
    current.arm(READ);
    f.notify(oldToken);
    current.arm(READ);
    expect(f.arm).toHaveBeenCalledTimes(3);
    old.close();
    current.close();
  } finally {
    f.close();
  }
});

test("failed arms and notifications invalidate cached zero interests", () => {
  const f = controlled();
  try {
    const watch = f.loop.watch(f.fd, () => {});
    watch.arm(0);
    const token = f.token();
    watch.arm(0);
    expect(f.arm).toHaveBeenCalledTimes(1);
    f.notify(token);
    watch.arm(0);
    expect(f.arm).toHaveBeenCalledTimes(2);
    f.arm.mockReturnValueOnce(-5);
    expect(() => watch.arm(READ)).toThrow();
    watch.arm(0);
    expect(f.arm).toHaveBeenCalledTimes(4);
    watch.close();
    expect(f.arm).toHaveBeenCalledTimes(5);
  } finally {
    f.close();
  }
});

test("closed tokens stay ignored after the descriptor gets a new watch", () => {
  const f = controlled();
  let oldCalls = 0,
    newCalls = 0;
  try {
    const old = f.loop.watch(f.fd, () => oldCalls++);
    old.arm(READ);
    const oldToken = f.token();
    old.close();
    const current = f.loop.watch(f.fd, () => newCalls++);
    current.arm(READ);
    const newToken = f.token();
    expect(newToken).not.toBe(oldToken);
    f.notify(oldToken);
    current.arm(READ);
    expect(f.arm).toHaveBeenCalledTimes(3);
    expect(oldCalls).toBe(0);
    f.notify(newToken);
    expect(newCalls).toBe(1);
    current.arm(READ);
    expect(f.arm).toHaveBeenCalledTimes(4);
    current.close();
  } finally {
    f.close();
  }
});

test("coalesced and fragmented readiness records retain their delivery order", () => {
  const f = controlled(),
    delivered: [number, number][] = [];
  try {
    const first = f.loop.watch(f.fd, events => delivered.push([1, events]));
    first.arm(READ);
    const firstToken = f.token();
    const second = f.loop.watch(f.fd, events => delivered.push([2, events]));
    second.arm(READ | WRITE);
    const secondToken = f.token(),
      records = Buffer.alloc(24);
    for (const [i, token, events] of [
      [0, firstToken, READ],
      [1, secondToken, WRITE],
      [2, secondToken, READ],
    ]) {
      records.writeUInt32LE(token, i * 8);
      records.writeUInt32LE(events, i * 8 + 4);
    }
    f.loop["socket"].emit("data", records.subarray(0, 11));
    expect(delivered).toEqual([[1, READ]]);
    f.loop["socket"].emit("data", records.subarray(11, 15));
    expect(delivered).toEqual([[1, READ]]);
    f.loop["socket"].emit("data", records.subarray(15));
    expect(delivered).toEqual([
      [1, READ],
      [2, WRITE],
      [2, READ],
    ]);
    first.close();
    second.close();
  } finally {
    f.close();
  }
});

test("real one-shot reads continue after repeated arms and pause resumes with a new token", async () => {
  const loop = new ReadyLoop(),
    [fd, peer] = pair(),
    bytes = Buffer.alloc(128);
  let received = "";
  const consume = () => {
    for (;;) {
      const count = n.probe_read(fd, ptr(bytes), bytes.length);
      if (count <= 0) {
        expect(wouldBlock(count)).toBe(true);
        break;
      }
      received += bytes.subarray(0, count).toString();
    }
    watch.arm(READ);
  };
  let watch = loop.watch(fd, consume);
  const send = (value: string) => {
    const chunk = Buffer.from(value);
    expect(n.probe_write(peer, ptr(chunk), chunk.length)).toBe(chunk.length);
  };
  const until = async (value: string) => {
    const deadline = Date.now() + 2000;
    while (received !== value && Date.now() < deadline) await Bun.sleep(5);
    expect(received).toBe(value);
  };
  try {
    watch.arm(READ);
    watch.arm(READ);
    send("one");
    await until("one");
    watch.arm(READ);
    send("two");
    await until("onetwo");
    watch.close();
    send("paused");
    await Bun.sleep(10);
    expect(received).toBe("onetwo");
    watch = loop.watch(fd, consume);
    watch.arm(READ);
    watch.arm(READ);
    await until("onetwopaused");
  } finally {
    watch.close();
    loop.close();
    n.probe_close(fd);
    n.probe_close(peer);
  }
});

test("adding write interest wakes once and removing it leaves reads armed", async () => {
  const loop = new ReadyLoop(),
    [fd, peer] = pair(),
    bytes = Buffer.alloc(32);
  let writes = 0,
    received = "";
  const watch = loop.watch(fd, events => {
    if (events & WRITE) writes++;
    if (events & READ) {
      const count = n.probe_read(fd, ptr(bytes), bytes.length);
      if (count > 0) received += bytes.subarray(0, count).toString();
    }
    watch.arm(READ);
  });
  const until = async (ready: () => boolean) => {
    const deadline = Date.now() + 2000;
    while (!ready() && Date.now() < deadline) await Bun.sleep(5);
    expect(ready()).toBe(true);
  };
  try {
    watch.arm(READ);
    watch.arm(READ | WRITE);
    watch.arm(READ | WRITE);
    await until(() => writes > 0);
    const chunk = Buffer.from("read");
    expect(n.probe_write(peer, ptr(chunk), chunk.length)).toBe(chunk.length);
    await until(() => received === "read");
    expect(writes).toBe(1);
  } finally {
    watch.close();
    loop.close();
    n.probe_close(fd);
    n.probe_close(peer);
  }
});
