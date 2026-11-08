import { expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { Sandbox } from "../tools/sandbox";
import { world } from "../tools/sandboxes/remote";
import { request } from "../src/remote_lab";
import { EXE } from "./runtime";
import { Terminal } from "../src/pane/terminal";
import { Connection } from "../src/rpc";

test.skipIf(!Bun.which("claude") || !Bun.which("codex"))(
  "remote sandbox runs isolated daemons and controls faults through its private CLI API",
  async () => {
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
      expect(Object.keys(await request(control))).toEqual(["slowloris", "finnicky", "goodboy"]);
      expect((await request(control)).slowloris.latency_ms).toBe(800);
      expect((await request(control)).goodboy.latency_ms).toBe(100);
      expect((await request(control)).finnicky).toMatchObject({ hang_seconds: 5, hang_every_seconds: 30 });
      await request(control, { machine: "slowloris", latency_ms: 150, bandwidth_kib: 128 });
      expect((await request(control)).slowloris).toMatchObject({ latency_ms: 150, bandwidth_kib: 128 });
      await expect(request(control, { machine: "slowloris", latency_ms: -1 })).rejects.toThrow();
      expect((await request(control)).slowloris.latency_ms).toBe(150);
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
      await until(() => screen.text().includes("slowloris"));
      ui.terminal!.write((sandbox.prefix === "ctrl_a" ? "\x01" : "\x02") + "~");
      await until(() => screen.text().includes("Developer") && screen.text().includes("Remote"));
      // Select slowloris from the machine navigation.
      ui.terminal!.write("\x1b[B\t");
      await until(() => screen.text().includes("One-way lag"));
      // Click the live latency slider; both control surfaces share the same state.
      const sliderRow =
        screen
          .text()
          .split("\n")
          .findIndex(line => line.includes("One-way lag")) + 1;
      ui.terminal!.write(`\x1b[<0;75;${sliderRow}M\x1b[<0;75;${sliderRow}m`);
      await until(async () => (await request(control)).slowloris.latency_ms !== 150);
      const cli = Bun.spawn(
        [
          process.execPath,
          resolve(import.meta.dir, "../tools/remote_sandbox.ts"),
          "--socket",
          control,
          "set",
          "slowloris",
          "--latency-ms",
          "0",
        ],
        { stdout: "ignore", stderr: "pipe" },
      );
      expect(await cli.exited).toBe(0);
      expect((await request(control)).slowloris.latency_ms).toBe(0);
      await request(control, { machine: "slowloris", outage_seconds: 2 });
      expect((await request(control)).slowloris.outage_until).toBeGreaterThan(Date.now());
      await request(control, { machine: "slowloris", drop: true });
      await until(async () => (await request(control)).slowloris.outage_until === 0);
      await request(control, { machine: "finnicky", hang_seconds: 0.2, hang_every_seconds: 0.7 });
      for (let cycle = 0; cycle < 2; cycle++) {
        await until(async () => (await request(control)).finnicky.outage_until > Date.now());
        await until(async () => (await request(control)).finnicky.outage_until === 0);
      }
      await request(control, { machine: "finnicky", hang_every_seconds: 0 });
      expect((await request(control)).finnicky.next_hang_at).toBe(0);
      // Check the actual seeded prompts and HTTP links on all four machines.
      for (const name of ["local", "slowloris", "finnicky", "goodboy"]) {
        const socket = name === "local" ? sandbox.env.CORGI_SOCKET : join(sandbox.dir, name, "run/control.sock");
        const connection = new Connection(socket, 2000);
        try {
          const snapshot = await connection.call("session.snapshot", {});
          const read = async (target: number) =>
            (
              await connection.call("session.command", {
                command: { "pane.read": { target, view: "screen", lines: 100n } },
              })
            ).result.text ?? "";
          const screens = await Promise.all(
            snapshot.panes.map(async pane => ({ pane: pane.id, text: await read(pane.id) })),
          );
          const agents = screens.filter(s => s.text.includes("claude · a fake agent"));
          expect(agents).toHaveLength(1);
          const idle = agents[0];
          expect(idle.text).toContain("❯");
          await connection.call("session.command", {
            command: {
              "pane.input": { target: idle.pane, data: "hello\x1b[D\x1b[D\x7fX\x1b[3~\x1b[F\x1b[27;2;13~second\r" },
            },
          });
          await until(async () => (await read(idle.pane)).includes("Done."));
          const edited = await read(idle.pane);
          expect(edited).toContain("Working on: heXo");
          expect(edited).toContain("second");
          expect(edited).not.toContain("[27;");
          expect(edited).not.toContain("[D");
          const working = agents[0];
          await until(async () => (await read(working.pane)).includes("Checking a test case"));
          for (const [title, prompt, answer] of [
            ["Claude Code", "❯", "Claude"],
            ["OpenAI Codex", "›", "Codex"],
          ]) {
            let native: { pane: number; text: string } | undefined;
            await until(async () => {
              const current = await Promise.all(
                snapshot.panes.map(async pane => ({ pane: pane.id, text: await read(pane.id) })),
              );
              native = current.find(pane => pane.text.includes(title) && pane.text.includes(prompt));
              return !!native;
            });
            expect(native!.text).not.toMatch(/Select login method|Sign in with ChatGPT|Enter API key/);
            await connection.call("session.command", {
              command: { "pane.send": { target: native!.pane, text: "Say hello", enter: true } },
            });
            await until(async () => (await read(native!.pane)).includes(`Sandbox reply from ${answer}`));
          }
          const demo = screens.find(s => s.text.includes(`${name} demo:`))!;
          const url = /http:\/\/localhost:\d+/.exec(demo.text)![0];
          expect(await (await fetch(url)).text()).toContain(`<h1>${name}</h1>`);
        } finally {
          connection.close();
        }
      }
      // All remotes are real live Corgi daemons with independent sockets.
      const identities = new Set<string>();
      for (const name of ["slowloris", "finnicky", "goodboy"]) {
        const connection = new Connection(join(sandbox.dir, name, "run/control.sock"), 2000);
        try {
          identities.add((await connection.call("hello")).instance!);
          const snapshot = await connection.call("session.snapshot", {});
          expect(snapshot.workspaces.some(workspace => workspace.name === "Local lab")).toBe(false);
          expect(snapshot.panes.length).toBeGreaterThanOrEqual(4);
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
      // --restart must finish remote checkpoint writers before removing the lab.
      // Otherwise they recreate stale recovery files alongside the fresh seed.
      ui.kill();
      await ui.exited;
      ui.terminal?.close();
      ui = undefined;
      await sandbox.shutdown();
      expect(existsSync(control)).toBe(false);
      for (const name of ["slowloris", "finnicky", "goodboy"])
        expect(existsSync(join(sandbox.dir, name, "run/control.sock"))).toBe(false);
      rmSync(sandbox.dir, { recursive: true, force: true });
      sandbox.prepareHome();
      world.seed(sandbox);
      sandbox.run([EXE, "start", "--update-routed"]);
      await world.arrange(sandbox);
      for (const name of ["local", "slowloris", "finnicky", "goodboy"]) {
        const socket = name === "local" ? sandbox.env.CORGI_SOCKET : join(sandbox.dir, name, "run/control.sock");
        const connection = new Connection(socket, 2000);
        try {
          await until(async () => {
            const snapshot = await connection.call("session.snapshot", { resources: false });
            expect(
              snapshot.workspaces.filter(workspace => workspace.model.tabs.length),
              name,
            ).toHaveLength(1);
            const agents = snapshot.panes.filter(pane => pane.command === "remote_agent");
            if (agents.length !== 2) return false; // Foreground discovery follows process startup.
            expect(agents.every(pane => !pane.exited && !pane.dormant)).toBe(true);
            const screens = await Promise.all(
              agents.map(
                async pane =>
                  (
                    await connection.call("session.command", {
                      command: { "pane.read": { target: pane.id, view: "screen" } },
                    })
                  ).result.text ?? "",
              ),
            );
            return (
              screens.some(text => text.includes("Claude Code") && text.includes("❯")) &&
              screens.some(text => text.includes("OpenAI Codex") && text.includes("›"))
            );
          });
        } finally {
          connection.close();
        }
      }
    } finally {
      ui?.kill();
      if (ui) {
        await ui.exited;
        ui.terminal?.close();
      }
      await sandbox.shutdown();
      const socket = sandbox.env.CORGI_REMOTE_LAB;
      if (socket) await until(() => !existsSync(socket));
      screen.destroy();
      rmSync(sandbox.dir, { recursive: true, force: true });
    }
  },
  120000,
);
