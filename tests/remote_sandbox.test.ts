import { expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { Sandbox } from "../tools/sandbox";
import { world } from "../tools/sandboxes/remote";
import { request } from "../src/remote_lab";
import { EXE } from "./runtime";
import { Terminal } from "../src/pane/terminal";
import { Connection } from "../src/rpc";

test("remote sandbox runs isolated daemons and controls faults through its private CLI API", async () => {
  const sandbox = new Sandbox(`remote-test-${process.pid}`, world, resolve(import.meta.dir, ".."), EXE);
  let ui: ReturnType<typeof Bun.spawn> | undefined;
  const screen = new Terminal(100, 35);
  const until = async (predicate: () => boolean | Promise<boolean>) => {
    const end = Date.now() + 30000;
    while (Date.now() < end) {
      if (await predicate()) return;
      await Bun.sleep(30);
    }
    throw Error("Remote sandbox condition timed out: " + screen.text());
  };
  try {
    sandbox.prepareHome();
    world.seed(sandbox);
    sandbox.run([EXE, "start", "--update-routed"]);
    await world.arrange(sandbox);
    const control = sandbox.env.CORGI_REMOTE_LAB;
    expect(Object.keys(await request(control))).toEqual(["atlas", "borealis", "cirrus"]);
    await request(control, { machine: "atlas", latency_ms: 150, bandwidth_kib: 128 });
    expect((await request(control)).atlas).toMatchObject({ latency_ms: 150, bandwidth_kib: 128 });
    await expect(request(control, { machine: "atlas", latency_ms: -1 })).rejects.toThrow();
    expect((await request(control)).atlas.latency_ms).toBe(150);
    ui = Bun.spawn([EXE], {
      cwd: sandbox.dir,
      env: sandbox.env,
      terminal: {
        cols: 100,
        rows: 35,
        data(_terminal, bytes) {
          screen.feed(bytes);
        },
      },
    });
    await until(() => screen.text().includes("atlas"));
    ui.terminal!.write((sandbox.prefix === "ctrl_a" ? "\x01" : "\x02") + "~");
    await until(() => screen.text().includes("Developer") && screen.text().includes("connectivity"));
    ui.terminal!.write("\t");
    await until(() => screen.text().includes("Sandbox faults"));
    // Click the live latency slider; both control surfaces share the same state.
    ui.terminal!.write("\x1b[<0;50;22M\x1b[<0;50;22m");
    await until(async () => (await request(control)).atlas.latency_ms !== 150);
    const cli = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, "../tools/remote_sandbox.ts"),
        "--socket",
        control,
        "set",
        "atlas",
        "--latency-ms",
        "0",
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    expect(await cli.exited).toBe(0);
    expect((await request(control)).atlas.latency_ms).toBe(0);
    await request(control, { machine: "atlas", outage_seconds: 2 });
    expect((await request(control)).atlas.outage_until).toBeGreaterThan(Date.now());
    await request(control, { machine: "atlas", drop: true });
    await until(async () => (await request(control)).atlas.outage_until === 0);
    // All remotes are real live Corgi daemons with independent sockets.
    const identities = new Set<string>();
    for (const name of ["atlas", "borealis", "cirrus"]) {
      const connection = new Connection(join(sandbox.dir, name, "run/control.sock"), 2000);
      try {
        identities.add((await connection.call("hello")).instance!);
        const snapshot = await connection.call("session.snapshot", {});
        expect(snapshot.workspaces.some(workspace => workspace.name === "Local lab")).toBe(false);
        expect(snapshot.panes.length).toBeGreaterThanOrEqual(3);
      } finally {
        connection.close();
      }
      const child = Bun.spawn([EXE, "ping"], {
        env: { ...sandbox.env, CORGI_SOCKET: join(sandbox.dir, name, "run/control.sock") },
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(await child.exited).toBe(0);
    }
    expect(identities.size).toBe(3);
  } finally {
    ui?.kill();
    if (ui) {
      await ui.exited;
      ui.terminal?.close();
    }
    sandbox.shutdown();
    const socket = sandbox.env.CORGI_REMOTE_LAB;
    if (socket) await until(() => !existsSync(socket));
    screen.destroy();
    rmSync(sandbox.dir, { recursive: true, force: true });
  }
}, 120000);
