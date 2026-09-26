import { describe, expect, test } from "bun:test";
import { daemons, stopOthers } from "../scripts/stop-other-daemons";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  test("preserves main, gracefully stops others, and kills an unresponsive daemon", async () => {
    let running = [10, 11, 12];
    const shut: number[] = [], signals: [number, string][] = [];
    await stopOthers({
      list: () => running.map((pid) => ({ pid, command: "/opt/corgi serve" })),
      mainPid: async () => 10,
      shutdown: async ({ pid }) => { shut.push(pid); if (pid === 11) running = running.filter((p) => p !== pid); },
      signal: (pid, signal) => { signals.push([pid, signal]); if (signal === "SIGKILL") running = running.filter((p) => p !== pid); },
      pause: async () => {}, log: () => {},
    });
    expect(shut).toEqual([11, 12]);
    expect(signals).toEqual([[12, "SIGTERM"], [12, "SIGKILL"]]);
    expect(running).toEqual([10]);
  });

  test("does not signal a reused PID or kill when main cannot be identified", async () => {
    let command = "/opt/corgi serve";
    const actions = {
      list: () => [{ pid: 11, command }], mainPid: async () => 10,
      shutdown: async () => { command = "/some/other/process"; },
      signal: () => { throw new Error("must not signal"); }, pause: async () => {}, log: () => {},
    };
    await stopOthers(actions);
    await expect(stopOthers({ ...actions, mainPid: async () => { throw new Error("main unresponsive"); } })).rejects.toThrow("main unresponsive");
  });

  test("go.sh invokes cleanup only for the main environment", async () => {
    const root = mkdtempSync(join(tmpdir(), "corgi-launch-cleanup-"));
    const outside: string[] = [];
    try {
      mkdirSync(join(root, "scripts"));
      mkdirSync(join(root, "zig-out/bin"), { recursive: true });
      mkdirSync(join(root, "bin"));
      copyFileSync(join(import.meta.dir, "../go.sh"), join(root, "go.sh"));
      writeFileSync(join(root, "scripts/zig"), "#!/bin/sh\nexit 0\n");
      writeFileSync(join(root, "bin/id"), "#!/bin/sh\necho 424242\n");
      writeFileSync(join(root, "scripts/stop-other-daemons.ts"), 'await Bun.write(process.env.CLEANUP_MARKER!, "called");\n');
      writeFileSync(join(root, "zig-out/bin/corgi"), '#!/usr/bin/env bun\nconsole.log(JSON.stringify({args:process.argv.slice(2),socket:process.env.CORGI_SOCKET,dir:process.env.CORGI_ENV_DIR}));\n');
      for (const file of ["go.sh", "scripts/zig", "bin/id", "zig-out/bin/corgi"]) chmodSync(join(root, file), 0o755);
      for (const [args, socket, cleanup] of [
        [[], undefined, true], [["--reload"], undefined, true],
        [["--temp", "ping"], undefined, false], [["--env", "test", "ping"], undefined, false],
        [["ping"], "/tmp/other/control.sock", false],
      ] as const) {
        const marker = join(root, "cleanup");
        rmSync(marker, { force: true });
        const env = { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, HOME: root, XDG_STATE_HOME: join(root, "state"), CLEANUP_MARKER: marker };
        for (const key of ["CORGI_PANE", "CORGI_SOCKET", "CORGI_ENV_DIR", "CORGI_ENV_BASE"]) delete env[key];
        if (socket) env.CORGI_SOCKET = socket;
        const child = Bun.spawn(["/bin/sh", join(root, "go.sh"), ...args], { env, stdout: "pipe", stderr: "pipe" });
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
