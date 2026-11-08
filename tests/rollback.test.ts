import { join } from "node:path";
import { readFileSync } from "node:fs";
import { Runtime, EXE } from "./runtime";
import { Pty, deadline, registerCase, writeExecutable } from "./support";
import { Connection } from "../src/rpc";

class Rollback extends Runtime {
  async rejectedRollback(reason: string) {
    const workspace = (await this.session()).workspaces[0].id,
      pane = (await this.command("pane.create", { workspace, command: "exec /bin/sh" })).pane,
      before = await this.session(),
      attempts = join(this.temp.name, "attempts"),
      candidate = writeExecutable(
        join(this.temp.name, "reject"),
        `
import { readFileSync, writeSync, appendFileSync } from "node:fs";
const state = JSON.parse(readFileSync(3, "utf8"));
appendFileSync(${JSON.stringify(attempts)}, state.version + "\\n");
writeSync(4, state.version === 7 ? "UnsupportedStateVersion\\n" : ${JSON.stringify(reason + "\n")});
process.exit(1);
`,
      ),
      client = new Connection(this.path),
      observer = new Connection(this.path, { compression: true });
    try {
      await observer.call("hello");
      const { link } = await observer.call("link.open");
      await observer.call("viewer.open");
      const disconnected = new Promise<void>(resolve => observer.onClose(resolve));
      await client.call("viewer.open");
      this.assertEqual(await client.request("server.reload", { executable: candidate }), { err: reason });
      this.assertEqual(readFileSync(attempts, "utf8"), "7\n6\n");
      this.assertFalse(client.disconnected);
      this.assertEqual((await client.call("ping")).pid, before.server_pid);
      this.assertEqual((await this.session()).panes[0].pid, before.panes[0].pid);
      await deadline(disconnected, 3000, "compressed viewer did not reconnect after rejection");
      const resumed = new Connection(this.path);
      try {
        await resumed.call("hello");
        this.assertTrue((await resumed.call("link.resume", { link })).viewer);
      } finally {
        resumed.close();
      }
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
  async test_rejected_format_6_keeps_the_daemon_and_WS_clients_alive() {
    await this.rejectedRollback("InvalidCheckpoint");
  }
  async test_older_formats_are_not_retried_beyond_format_6() {
    await this.rejectedRollback("UnsupportedStateVersion");
  }
  async requestRollback(compression: boolean) {
    const workspace = (await this.session()).workspaces[0].id,
      pane = (await this.command("pane.create", { workspace, command: "exec /bin/sh" })).pane,
      before = await this.session(),
      client = new Connection(this.path, { compression, timeout_ms: 10000 });
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
      const after = await this.session();
      this.assertNotEqual(after.server_pid, before.server_pid);
      this.assertEqual(results[0].value.server_pid, after.server_pid);
      this.assertEqual(after.panes[0].pid, before.panes[0].pid);
      this.assertNotIn("MUST_NOT_RUN", (await this.command("pane.read", { target: pane, view: "screen" })).text);
      await this.command("pane.input", { target: pane, data: "printf 'ROLLBACK_%s\\n' ALIVE\r" });
      await this.until(async () =>
        (await this.command("pane.read", { target: pane, view: "screen" })).text.includes("ROLLBACK_ALIVE"),
      );
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
      const after = await this.session();
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
          "test_live_rollback_preserves_shells_and_explains_viewer_and_subscription_disconnects",
        ].map(name => [name, "requires a pre-WS format-6 CORGI_OLD_EXE"]),
      ),
});
