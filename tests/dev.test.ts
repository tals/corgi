import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Runtime, EXE, ROOT } from "./runtime";
import { Pty, deadline, registerCase, run, sleep } from "./support";
const developerScript = process.env.CORGI_DEV_SCRIPT || join(ROOT, "go.ts");

class Dev extends Runtime {
  async configure() {
    this.env.ZIG_GLOBAL_CACHE_DIR ??= join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "zig");
    // Discover the host signing identity before go.ts runs with the isolated HOME.
    if (process.platform === "darwin" && !this.env.CORGI_SIGN_IDENTITY) {
      this.env.CORGI_SIGN_IDENTITY = (
        await run(["/bin/sh", join(ROOT, "scripts/sign-macos"), "--identity"], {
          env: process.env,
        })
      ).stdout.trim();
    }
  }
  async launch() {
    delete this.env.CORGI_PANE;
    this.pty = await Pty.spawn([developerScript], {
      env: this.env,
      cols: 80,
      rows: 24,
    });
    this.proc = this.pty.proc;
    return this.wait_viewer();
  }
  async wait_viewer(old?: number) {
    const end = Date.now() + 15_000;
    while (Date.now() < end) {
      const viewers = (await this.rpc({ op: "viewer.list" })).viewers;
      if (viewers.length === 1 && viewers[0].id !== old && viewers[0].pane) return viewers[0];
      await sleep(0.03);
    }
    this.fail(`viewer did not attach/relaunch: ${this.pty.output.slice(-4000)}`);
  }
  async test_unchanged_daemon_and_nested_client_relaunch() {
    const before = await this.rpc({ op: "hello", protocol: 1 });
    this.assertEqual(before.build_id, createHash("sha256").update(readFileSync(EXE)).digest("hex"));
    const viewer = await this.launch(),
      panes = (await this.session()).panes.map((p: any) => [p.id, p.pid]);
    await this.command("pane.input", {
      data: developerScript + "\r",
      target: viewer.pane,
    });
    await this.wait_viewer(viewer.id);
    this.assertEqual((await this.rpc({ op: "hello", protocol: 1 })).server_pid, before.server_pid);
    this.assertEqual(
      (await this.session()).panes.map((p: any) => [p.id, p.pid]),
      panes,
    );
    this.pty.write("\x02q");
    this.assertEqual(await deadline(this.proc.exited, 6000), 0);
  }
  async test_changed_daemon_reloads_and_keeps_panes() {
    await this.command("pane.create", {
      workspace: (await this.session()).workspaces[0].id,
      command: "sleep 60",
    });
    const panes = (await this.session()).panes.map((p: any) => [p.id, p.pid]);
    await this.rpc({
      op: "server.reload",
      protocol: 1,
      executable: process.env.CORGI_OLD_EXE,
    });
    const old = await this.rpc({ op: "hello", protocol: 1 });
    await this.launch();
    const current = await this.rpc({ op: "hello", protocol: 1 });
    this.assertNotEqual(old.build_id, current.build_id);
    this.assertEqual(current.executable, realpathSync(EXE));
    this.assertEqual(current.build_id, createHash("sha256").update(readFileSync(EXE)).digest("hex"));
    this.assertNotEqual(old.server_pid, current.server_pid);
    this.assertEqual(
      (await this.session()).panes.map((p: any) => [p.id, p.pid]),
      panes,
    );
  }
}
registerCase("Dev", Dev, {
  skipTests: process.env.CORGI_OLD_EXE ? {} : { test_changed_daemon_reloads_and_keeps_panes: "requires another build" },
});
