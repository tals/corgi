import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdirSync, existsSync, rmSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Sandbox } from "./sandbox";
import { world } from "./sandboxes/remote";

test("remote shutdown waits for supervisor cleanup even when its status request fails", async () => {
  const sandbox = new Sandbox(`remote-shutdown-${process.pid}`, world, join(import.meta.dir, ".."), process.execPath);
  mkdirSync(sandbox.dir, { recursive: true });
  const control = join(sandbox.dir, "network.sock");
  const server = createServer(client => client.destroy());
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(control, resolve));
    timer = setTimeout(() => server.close(), 100);
    await world.shutdown!(sandbox);
    expect(existsSync(control)).toBe(false);
  } finally {
    clearTimeout(timer);
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(sandbox.dir, { recursive: true, force: true });
  }
});

test.skipIf(!Bun.which("sshd") || !Bun.which("ssh-keygen"))(
  "repeated shutdown signals wait for remote children before removing the control socket",
  async () => {
    const directory = mkdtempSync("/tmp/corgi-remote-lifetime-"),
      exe = join(directory, "fake-corgi"),
      names = ["slowloris", "finnicky", "goodboy"];
    writeFileSync(
      exe,
      `#!${process.execPath}
import { writeFileSync } from "node:fs";
const home = process.env.HOME;
if (process.argv[2] === "serve") {
  writeFileSync(home + "/pid", String(process.pid));
  setInterval(() => {}, 1000);
  let stopping = false;
  process.on("SIGTERM", () => {
    if (stopping) return;
    stopping = true;
    writeFileSync(home + "/stopping", "yes");
    setTimeout(() => { writeFileSync(home + "/finished", "yes"); process.exit(0); }, 300);
  });
} else if (process.argv[2] === "__remote-info") console.log(JSON.stringify({ bridge: "fake-bridge" }));
else console.log(JSON.stringify({ result: { workspace: 1 } }));
`,
      { mode: 0o700 },
    );
    mkdirSync(join(directory, "state"));
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "remote_sandbox.ts"), "serve", directory, exe], {
      env: { ...process.env, XDG_STATE_HOME: join(directory, "state") },
      stdout: "ignore",
      stderr: "pipe",
    });
    const until = async (check: () => boolean) => {
      const end = Date.now() + 5000;
      while (!check() && Date.now() < end) {
        if (child.exitCode !== null) throw Error(await new Response(child.stderr).text());
        await Bun.sleep(5);
      }
      expect(check()).toBe(true);
    };
    try {
      const control = join(directory, "network.sock");
      await until(() => existsSync(control));
      child.kill("SIGTERM");
      await until(() => names.every(name => existsSync(join(directory, name, "stopping"))));
      expect(existsSync(control)).toBe(true);
      child.kill("SIGTERM");
      await child.exited;
      expect(names.every(name => existsSync(join(directory, name, "finished")))).toBe(true);
      expect(existsSync(control)).toBe(false);
    } finally {
      child.kill("SIGKILL");
      await child.exited;
      for (const name of names)
        try {
          process.kill(Number(readFileSync(join(directory, name, "pid"), "utf8")), "SIGKILL");
        } catch {}
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
