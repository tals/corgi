import { describe, expect, test } from "bun:test";
import { daemons, stopOthers } from "../scripts/stop-other-daemons";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quote, registerCase } from "./support";
import { Runtime } from "./runtime";

describe("development daemon cleanup", () => {
  test("identifies only same-user servers, including reloaded daemons and paths with spaces", () => {
    expect(daemons(`
501 10 /opt/corgi serve
501 11 /some path/corgi __handoff 4 5
501 12 /opt/corgi
501 13 /bin/sh -c /opt/corgi serve
502 14 /opt/corgi serve
501 15 /opt/corgi __claude-credentials silent
501 16 /opt/notcorgi serve
`, 501, `
10 /opt/corgi
11 /some path/corgi
12 corgi
13 /bin/sh
14 corgi
15 corgi
16 notcorgi
`).map((d) => d.pid)).toEqual([10, 11]);
  });

  /** A fake world where each pause advances the clock by 100ms. */
  function world(running: number[], overrides: Record<string, any> = {}) {
    let clock = 0;
    const shut: string[] = [], signals: [number, string, number][] = [];
    const actions = {
      list: async (pids?: number[]) => running.filter((pid) => !pids || pids.includes(pid)).map((pid) => ({ pid, command: "/opt/corgi serve" })),
      mainPid: async () => 10,
      socket: async ({ pid }: { pid: number }) => pid === 13 ? undefined : `/tmp/corgi-${pid}/control.sock`,
      shutdown: async (socket: string) => { shut.push(socket); if (socket.includes("11")) running = running.filter((p) => p !== 11); return true; },
      signal: (pid: number, signal: string) => {
        signals.push([pid, signal, clock]);
        if (signal === "SIGKILL" || (pid === 13 && signal === "SIGTERM")) running = running.filter((p) => p !== pid);
      },
      pause: async () => { clock += 100; }, now: () => clock, show: () => {},
      ...overrides,
    };
    return { actions, shut, signals, running: () => running };
  }

  test("preserves main, stops others at once, and escalates by time", async () => {
    const { actions, shut, signals, running } = world([10, 11, 12, 13]);
    const rows = await stopOthers(actions);
    expect(shut).toEqual(["/tmp/corgi-11/control.sock", "/tmp/corgi-12/control.sock"]);
    // 13 has no socket to ask, so it is terminated right away; 12 ignored its request.
    expect(signals).toEqual([[13, "SIGTERM", 0], [12, "SIGTERM", 3000], [12, "SIGKILL", 5000]]);
    expect(running()).toEqual([10]);
    expect(rows.map((row) => [row.daemon.pid, row.state])).toEqual([[11, "stopped"], [12, "killed"], [13, "terminated"]]);
  });

  test("gives up on a daemon that survives SIGKILL", async () => {
    const { actions } = world([12], { signal: () => {} });
    const rows = await stopOthers(actions);
    expect(rows.map((row) => [row.daemon.pid, row.state])).toEqual([[12, "stuck"]]);
  });

  test("does not signal a reused PID or kill when main cannot be identified", async () => {
    let command = "/opt/corgi serve";
    const actions = {
      list: async () => [{ pid: 11, command }], mainPid: async () => 10,
      socket: async () => "/tmp/corgi-11/control.sock",
      shutdown: async () => { command = "/some/other/process"; return true; },
      signal: () => { throw new Error("must not signal"); },
      pause: async () => { await Promise.resolve(); }, now: () => 0, show: () => {},
    };
    await stopOthers(actions);
    await expect(stopOthers({ ...actions, mainPid: async () => { throw new Error("main unresponsive"); } })).rejects.toThrow("main unresponsive");
  });

  test("go.ts invokes cleanup only for the main environment", async () => {
    const root = mkdtempSync(join(tmpdir(), "corgi-launch-cleanup-"));
    const outside: string[] = [];
    try {
      mkdirSync(join(root, "scripts"));
      mkdirSync(join(root, "dist"), { recursive: true });
      copyFileSync(join(import.meta.dir, "../go.ts"), join(root, "go.ts"));
      writeFileSync(join(root, "build.ts"), "");
      writeFileSync(join(root, "scripts/stop-other-daemons.ts"), 'export async function stopOtherDaemons() { await Bun.write(process.env.CLEANUP_MARKER!, "called"); }\n');
      writeFileSync(join(root, "dist/corgi"), '#!/usr/bin/env bun\nconsole.log(JSON.stringify({args:process.argv.slice(2),socket:process.env.CORGI_SOCKET,dir:process.env.CORGI_ENV_DIR}));\n');
      chmodSync(join(root, "dist/corgi"), 0o755);
      for (const [args, socket, cleanup] of [
        [[], undefined, true], [["--reload"], undefined, true],
        [["--temp", "ping"], undefined, false], [["--env", "test", "ping"], undefined, false],
        [["ping"], "/tmp/other/control.sock", false],
      ] as const) {
        const marker = join(root, "cleanup");
        rmSync(marker, { force: true });
        const env = { ...process.env, HOME: root, XDG_STATE_HOME: join(root, "state"), CLEANUP_MARKER: marker };
        for (const key of ["CORGI_PANE", "CORGI_SOCKET", "CORGI_ENV_DIR", "CORGI_ENV_BASE"]) delete env[key];
        if (socket) env.CORGI_SOCKET = socket;
        const child = Bun.spawn([process.execPath, join(root, "go.ts"), ...args], { env, stdout: "pipe", stderr: "pipe" });
        const output = await new Response(child.stdout).text();
        const errors = await new Response(child.stderr).text();
        expect(await child.exited, errors).toBe(0);
        expect(existsSync(marker)).toBe(cleanup);
        for (const line of output.trim().split("\n").filter(Boolean)) {
          const value = JSON.parse(line);
          if (value.socket?.startsWith("/tmp/corgi-") && !value.socket.includes("/other/")) outside.push(value.socket.replace(/\/control.sock$/, ""));
        }
      }
    } finally {
      for (const path of outside) rmSync(path, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** Pids of `parent`'s children, zombies included. */
function childrenOf(parent: number) {
  const rows = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid="]).stdout.toString().trim().split("\n");
  return new Set(rows.map((row) => row.trim().split(/\s+/).map(Number)).filter(([, ppid]) => ppid === parent).map(([pid]) => pid));
}

class DaemonChildren extends Runtime {
  async test_closed_and_exited_panes_leave_no_zombie_shells() {
    const daemon = (await this.rpc({ op: "hello", protocol: 1 })).server_pid;
    const shells: number[] = [];
    const closing: number[] = [];
    for (const [name, rest] of [["one", "exec sleep 60"], ["two", "exec sleep 60"], ["exits", "exit 3"]]) {
      const file = join(this.temp.name, `${name}.pid`);
      const { pane } = await this.open_pane({ command: `echo $$ > ${quote(file)}; ${rest}` });
      if (rest !== "exit 3") closing.push(pane);
      shells.push(Number(await this.until(() => existsSync(file) && readFileSync(file, "utf8").trim())));
    }
    for (const shell of shells) this.assertTrue(shell > 0);
    for (const pane of closing) await this.command("pane.close", { target: pane });
    // A zombie is still a child; a collected shell is gone from the list.
    await this.until(() => {
      const children = childrenOf(daemon);
      return shells.every((pid) => !children.has(pid));
    }, 10);
  }
}

registerCase("daemon children", DaemonChildren, { timeout: 60_000 });
