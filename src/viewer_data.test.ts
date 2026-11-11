import { sshEndpoint } from "./ssh_path";
import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { Server } from "./server";
import { Connection } from "./rpc";
import { Stream } from "./machine_stream";
import { Endpoint, localEndpoint } from "./machine_connection";
import { Remote } from "./daemon_transport";
import { Host } from "./host";
import { Probe } from "./terminal_info";
import * as socket_server from "./socket_server";
import * as viewer from "./viewer_protocol";
import * as protocol from "./protocol";

async function until(done: () => boolean) {
  const end = performance.now() + 3000;
  while (!done()) {
    if (performance.now() >= end) throw Error("TestTimedOut");
    await Bun.sleep(2);
  }
}
function fixture() {
  const directory = mkdtempSync("/tmp/corgi-viewer-data-"),
    path = directory + "/s",
    server = new Server(path, "", "0".repeat(64)),
    // Served as the daemon serves itself, without the rest of its startup.
    listening = socket_server.listen(path, Reflect.get(server, "accept").call(server));
  return {
    path,
    server,
    async close() {
      for (const client of [...server.clients]) client.close();
      await Reflect.get(server, "jobs");
      await listening.stop(true);
      server.runtime.destroy();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

for (const compression of [false, true])
  test(`control replies and actions survive a paused ${compression ? "zstd" : "plain"} pane reader`, async () => {
    const f = fixture(),
      control = new Connection(f.path, { compression }),
      data = new Connection(f.path, { compression });
    try {
      await control.call("hello");
      const { link } = await control.call("link.open");
      await control.call("viewer.open", { cwd: "/tmp", pid: process.pid });
      await data.call("hello");
      const bound = await data.call("viewer.data", { link });
      const owner = f.server.clients.find(c => c.viewer)!;
      expect(bound.viewer).toBe(owner.viewer_id);
      expect(viewer.data(f.server, owner)?.compressed).toBe(compression);
      const stream = new Stream(control, () => {}, true, data);
      const controls: protocol.Event[] = [];
      control.onEvent(event => controls.push(event));
      // Pause Bun's reader as well as the Duplex wrapper: bytes cannot merely
      // move from the kernel into a hidden application buffer.
      const ws = Reflect.get(data.socket, "ws") as Bun.WebSocket;
      ws.pause();
      data.socket.pause();
      stream.configure({ interests: [], watched: false }, 1);
      await until(() => owner.stream !== null);
      viewer.queue(f.server, owner, { kind: "action", name: "relaunch", value: "/tmp/replacement" });
      expect((await control.call("ping")).ok).toBe(true);
      await until(() => controls.some(e => e.type === "viewer.controls"));
      expect(stream.take()).toBeNull();
      expect(stream.fresh).toBe(false);
      expect(controls.find(e => e.type === "viewer.controls")).toMatchObject({
        controls: [{ kind: "action", name: "relaunch", value: "/tmp/replacement" }],
      });
      const before = stream.age();
      await Bun.sleep(30);
      await Reflect.get(stream, "receipt").call(stream, owner.stream!.sequence);
      expect(stream.age()).toBeGreaterThan(before + 20);
      ws.resume();
      data.socket.resume();
      await until(() => stream.fresh);
      expect(stream.take()!.frame.controls).toEqual([]);
      control.close();
      await until(() => data.failure !== null);
      expect(f.server.clients.some(c => c.stream_data)).toBe(false);
    } finally {
      control.close();
      data.close();
      await f.close();
    }
  });

test("data binding requires a live viewer link and replaces the previous data lane", async () => {
  const f = fixture(),
    control = new Connection(f.path),
    first = new Connection(f.path),
    replacement = new Connection(f.path);
  try {
    await control.call("hello");
    const { link } = await control.call("link.open");
    await expect(first.call("viewer.data", { link })).rejects.toThrow("NoViewer");
    await control.call("viewer.open", { cwd: "/tmp", pid: process.pid });
    await first.call("viewer.data", { link });
    await expect(first.call("viewer.open", { cwd: "/tmp", pid: process.pid })).rejects.toThrow("AlreadyAttached");
    await replacement.call("viewer.data", { link });
    await until(() => first.failure !== null);
    expect(f.server.clients.filter(c => c.stream_data)).toHaveLength(1);
    await expect(replacement.call("viewer.data", { link })).rejects.toThrow("AlreadyAttached");
  } finally {
    control.close();
    first.close();
    replacement.close();
    await f.close();
  }
});

test("the active machine endpoint opens both lanes and applies controls before any pane frame", async () => {
  const f = fixture(),
    endpoint = localEndpoint(f.path, new Probe(), new Host());
  try {
    await Reflect.get(endpoint, "step").call(endpoint, true, 0);
    const owner = f.server.clients.find(c => c.viewer)!;
    expect(viewer.data(f.server, owner)).toBeDefined();
    expect(endpoint.machine.viewer_id).toBe(owner.viewer_id);
    const data = Reflect.get(endpoint, "data").channel as Connection;
    (Reflect.get(data.socket, "ws") as Bun.WebSocket).pause();
    data.socket.pause();
    viewer.queue(f.server, owner, { kind: "action", name: "relaunch", value: "/tmp/replacement" });
    await until(() => Reflect.get(endpoint, "controls").length > 0);
    await Reflect.get(endpoint, "step").call(endpoint, true, 0);
    expect(endpoint.relaunch).toBe("/tmp/replacement");
  } finally {
    await endpoint.close();
    await f.close();
  }
});

test("remote lanes open together, including reconnects started while viewing another machine", async () => {
  const f = fixture();
  let opened = 0;
  const open = spyOn(Remote.prototype, "open").mockImplementation(async function (this: Remote) {
    Object.defineProperty(this, "socket", { value: f.path });
    opened++;
    await until(() => opened === 2);
  });
  const endpoint = sshEndpoint(
    { name: "parallel", target: "unused", executable: "/corgi", socket: f.path, home: "/tmp" },
    new Probe(),
    new Host(),
  );
  try {
    await Reflect.get(endpoint, "step").call(endpoint, true, 0);
    expect(opened).toBe(2);
    expect(f.server.clients.filter(c => c.viewer || c.stream_data)).toHaveLength(2);
    await Reflect.get(f.server, "jobs");
    Reflect.get(endpoint, "disconnect").call(endpoint);
    opened = 0;
    Object.defineProperty(endpoint, "shown", { value: false, configurable: true });
    await Reflect.get(endpoint, "connect").call(endpoint);
    expect(opened).toBe(2);
  } finally {
    await endpoint.close();
    await Reflect.get(f.server, "jobs");
    Reflect.deleteProperty(endpoint, "shown");
    open.mockRestore();
    await f.close();
  }
});
