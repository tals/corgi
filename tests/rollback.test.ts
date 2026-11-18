import { join } from "node:path";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Runtime, EXE, running } from "./runtime";
import { Pty, deadline, registerCase, writeExecutable, quote } from "./support";
import * as rpc from "../src/rpc";

class Rollback extends Runtime {
  /** A request to the older daemon a rollback left, in its own runtime protocol. */
  async older(value: { op: string; [field: string]: unknown }): Promise<any> {
    const hello: any = await this.http.discover();
    const reply: any = await this.http.post({ ...value, protocol: hello.protocol });
    if (reply.err) throw Error(`older ${value.op}: ${reply.err}`);
    return reply;
  }
  async olderScreen(pane: number): Promise<string> {
    return (await this.older({ op: "session.command", command: { "pane.read": { target: pane, view: "screen" } } }))
      .result.text;
  }
  async test_a_rejected_format_6_candidate_is_tried_once_and_keeps_the_daemon_and_WS_clients_alive() {
    const workspace = (await this.session()).workspaces[0].id,
      pane = (await this.command("pane.create", { workspace, command: "exec /bin/sh" })).pane,
      before = await this.session(),
      attempts = join(this.temp.name, "attempts"),
      reject = (reason: string) =>
        writeExecutable(
          join(this.temp.name, `reject-${reason}`),
          `
import { readFileSync, writeSync, appendFileSync } from "node:fs";
if (process.argv[2] === "__handoff-info") { console.error("corgi: UnknownCommand"); process.exit(1); }
const state = JSON.parse(readFileSync(3, "utf8"));
appendFileSync(${JSON.stringify(attempts)}, state.version + "\\n");
writeSync(4, state.version === 7 ? "UnsupportedStateVersion\\n" : ${JSON.stringify(reason + "\n")});
process.exit(1);
`,
        ),
      client = new rpc.Connection(this.path),
      observer = new rpc.Connection(this.path, { compression: true });
    try {
      await observer.call("hello");
      await observer.call("link.open");
      await observer.call("viewer.open");
      await client.call("viewer.open");
      // Format 6 reports its own refusal, and an older format is never tried.
      for (const reason of ["InvalidCheckpoint", "UnsupportedStateVersion"]) {
        rmSync(attempts, { force: true });
        this.assertEqual(await client.request("server.reload", { executable: reject(reason) }), { err: reason });
        this.assertEqual(readFileSync(attempts, "utf8"), "7\n6\n");
      }
      this.assertFalse(client.disconnected);
      this.assertEqual((await client.call("ping")).pid, before.server_pid);
      this.assertEqual((await this.session()).panes[0].pid, before.panes[0].pid);
      // Nothing was handed over, so every connection, compressed or not, carries on.
      this.assertFalse(observer.disconnected);
      this.assertEqual((await observer.call("ping")).pid, before.server_pid);
      await client.call("session.command", {
        command: { "pane.input": { target: pane, data: "printf 'STILL_%s\\n' ALIVE\r" } },
      });
      await this.until(async () =>
        (await this.command("pane.read", { target: pane, view: "screen" })).text.includes("STILL_ALIVE"),
      );
    } finally {
      client.close();
      observer.close();
    }
  }
  async requestRollback(compression: boolean) {
    const workspace = (await this.session()).workspaces[0].id,
      pane = (await this.command("pane.create", { workspace, command: "exec /bin/sh" })).pane,
      before = await this.session(),
      client = new rpc.Connection(this.path, { compression, timeout_ms: 10000 });
    try {
      await client.call("hello");
      const results = await Promise.allSettled([
        client.call("server.reload", { executable: process.env.CORGI_OLD_EXE! }),
        client.call("session.command", { command: { "pane.input": { target: pane, data: "MUST_NOT_RUN\r" } } }),
      ]);
      this.assertEqual(results[0].status, "fulfilled");
      this.assertEqual(results[1].status, "rejected");
      if (results[0].status !== "fulfilled" || results[1].status !== "rejected")
        throw Error("UnexpectedRollbackResult");
      this.assertEqual(results[1].reason.message, "ServerRolledBack");
      const after = await this.older({ op: "session.snapshot" });
      this.assertNotEqual(after.server_pid, before.server_pid);
      this.assertEqual(results[0].value.server_pid, after.server_pid);
      this.assertEqual(after.panes[0].pid, before.panes[0].pid);
      this.assertNotIn("MUST_NOT_RUN", await this.olderScreen(pane));
      await this.older({
        op: "session.command",
        command: { "pane.input": { target: pane, data: "printf 'ROLLBACK_%s\\n' ALIVE\r" } },
      });
      await this.until(async () => (await this.olderScreen(pane)).includes("ROLLBACK_ALIVE"));
    } finally {
      client.close();
    }
  }
  async test_WS_requester_gets_the_commit_reply_without_replaying_later_input() {
    await this.requestRollback(false);
  }
  async test_compressed_WS_requester_gets_the_commit_reply_without_replaying_later_input() {
    await this.requestRollback(true);
  }
  async test_HTTP_requester_gets_the_rollback_reply_and_can_upgrade_again() {
    const workspace = (await this.session()).workspaces[0].id;
    await this.command("pane.create", { workspace, command: "exec /bin/sh" });
    const before = await this.session();
    const reply = await this.http.call("server.reload", { executable: process.env.CORGI_OLD_EXE! });
    const old = await this.http.call("hello");
    this.assertEqual(reply.server_pid, old.server_pid);
    this.assertNotEqual(old.server_pid, before.server_pid);
    this.assertEqual(old.transports, undefined);
    this.assertEqual((await this.older({ op: "session.snapshot" })).panes[0].pid, before.panes[0].pid);
    const restored = await this.http.call("server.reload", { executable: EXE });
    this.assertEqual((await this.http.call("hello")).server_pid, restored.server_pid);
    this.assertEqual((await this.session()).panes[0].pid, before.panes[0].pid);
  }
  async test_long_resume_commands_survive_old_readers_and_remain_executable() {
    const workspace = (await this.session()).workspaces[0].id,
      pane = (await this.command("pane.create", { workspace, command: "exec /bin/sh" })).pane,
      saved = await this.rpc({ op: "recovery.save" }),
      file = saved.path,
      daemon = (await this.session()).server_pid,
      output = join(this.temp.name, "resumed-command"),
      expected = "retained ".repeat(400),
      command = `printf '%s' ${quote(expected)} > ${quote(output)}`;
    await this.run_cli("shutdown");
    await this.until(() => !running(daemon));
    const state = JSON.parse(readFileSync(file, "utf8")),
      core = state.transfer.core.panes.find((p: any) => p.id === pane);
    Object.assign(core, { dormant: true, manual_resume: true, command });
    writeFileSync(file, JSON.stringify(state));
    // Prefilled commands wait for an interactive line editor.
    this.env.SHELL = "/bin/bash";
    await this.run_cli("start");
    this.assertTrue((await this.session()).panes.find((p: any) => p.id === pane).dormant);
    const live = (await this.command("pane.create", { workspace, command: "exec /bin/sh" })).pane,
      before = (await this.session()).panes.find((p: any) => p.id === live).pid;
    await this.rpc({ op: "recovery.save" });
    const checked = Bun.spawn([process.env.CORGI_OLD_EXE!, "__update-check", this.path, file], {
      env: this.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    this.assertEqual(JSON.parse(await new Response(checked.stdout).text()), { ok: true });
    this.assertEqual(await checked.exited, 0);
    await this.rpc({ op: "server.reload", executable: process.env.CORGI_OLD_EXE! });
    this.assertEqual((await this.older({ op: "session.snapshot" })).panes.find((p: any) => p.id === live).pid, before);
    await this.older({ op: "session.command", command: { "pane.wake": { target: pane } } });
    let screen = "";
    await this.until(async () =>
      (screen = await this.olderScreen(pane)).replace(/\s+/g, "").includes("resume-commands"),
    ).catch(error => {
      throw new Error(`${error}\n${screen}`);
    });
    await this.older({ op: "session.command", command: { "pane.input": { target: pane, data: "\r" } } });
    await this.until(() => existsSync(output));
    this.assertEqual(readFileSync(output, "utf8"), expected);
    await this.http.call("server.reload", { executable: EXE });
    this.assertEqual((await this.session()).panes.find((p: any) => p.id === live).pid, before);
  }
  async test_live_rollback_preserves_shells_and_explains_viewer_and_subscription_disconnects() {
    const workspace = (await this.session()).workspaces[0].id;
    await this.command("pane.create", { workspace, command: "exec /bin/sh" });
    const before = await this.session(),
      pty = (this.pty = new Pty(80, 24)),
      settings = await pty.settings();
    pty.start([EXE, "--no-update"], { env: this.env, cwd: this.temp.name });
    await this.until(async () => (await this.rpc({ op: "viewer.list" })).viewers.length > 0);
    const watch = Bun.spawn([EXE, "watch", "--json"], { env: this.env, stdout: "pipe", stderr: "pipe" });
    const stderr = new Response(watch.stderr).text(),
      started = Promise.withResolvers<void>();
    const stdout = (async () => {
      for await (const _ of watch.stdout) started.resolve();
    })();
    try {
      await deadline(started.promise, 5000, "subscription never answered");
      await this.rpc({ op: "server.reload", executable: process.env.CORGI_OLD_EXE! });
      this.assertEqual(await deadline(pty.proc.exited, 5000, "viewer did not exit: " + pty.output.slice(-1000)), 1);
      this.assertIn("server rolled back", pty.output);
      this.assertIn("Reattach using the selected Corgi version", pty.output);
      this.assertEqual(await pty.settings(), settings);
      this.assertEqual(await deadline(watch.exited, 5000, "subscription did not exit"), 1);
      this.assertIn("server rolled back", await stderr);
      const after = await this.older({ op: "session.snapshot" });
      this.assertNotEqual(after.server_pid, before.server_pid);
      this.assertEqual(after.panes[0].pid, before.panes[0].pid);
      await this.run_cli("reload", EXE);
      this.assertEqual((await this.session()).panes[0].pid, before.panes[0].pid);
      await this.attach();
      await this.input("printf 'ROUND_TRIP_%s\\n' ALIVE\r");
      await this.until(async () =>
        (await this.command("pane.read", { target: after.panes[0].id, view: "screen" })).text.includes(
          "ROUND_TRIP_ALIVE",
        ),
      );
    } finally {
      if (watch.exitCode === null) watch.kill();
      await deadline(watch.exited, 3000);
      await stdout;
    }
  }
}
registerCase("Rollback", Rollback, {
  inherited: false,
  skipTests: process.env.CORGI_OLD_EXE
    ? {}
    : Object.fromEntries(
        [
          "test_WS_requester_gets_the_commit_reply_without_replaying_later_input",
          "test_compressed_WS_requester_gets_the_commit_reply_without_replaying_later_input",
          "test_HTTP_requester_gets_the_rollback_reply_and_can_upgrade_again",
          "test_live_rollback_preserves_shells_and_explains_viewer_and_subscription_disconnects",
          "test_long_resume_commands_survive_old_readers_and_remain_executable",
        ].map(name => [name, "requires a pre-WS format-6 CORGI_OLD_EXE"]),
      ),
});
