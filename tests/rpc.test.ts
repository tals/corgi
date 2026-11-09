import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Connection } from "../src/rpc";
import * as protocol from "../src/protocol";
import { Runtime } from "./runtime";
import { EXE, deadline, lines, registerCase, run, versioned, writeExecutable } from "./support";
import * as viewer_connection from "../src/viewer_connection";
import * as websocket_socket from "../src/websocket_socket";

class Rpc extends Runtime {
  private gate!: string;
  async configure() {
    const git = Bun.which("git")!;
    for (const args of [
      ["init", "-b", "main"],
      ["config", "user.name", "Test"],
      ["config", "user.email", "test@example.invalid"],
      ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "base"],
    ])
      await run([git, "-C", this.temp.name, ...args], { env: this.env });
    this.gate = join(this.temp.name, "git-gate");
    mkdirSync(this.gate);
    const bin = join(this.temp.name, "bin");
    writeExecutable(
      join(bin, "git"),
      `
import { existsSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2), gate = ${JSON.stringify(this.gate)};
const operation = args.includes('--format=%(refname)%09%(committerdate:unix)') ? 'branches'
  : args.includes('worktree') && args.includes('add') ? 'worktree' : '';
const armed = join(gate, 'armed'), release = join(gate, 'release');
if (operation && existsSync(armed) && readFileSync(armed, 'utf8') === operation) {
  await new Promise(resolve => {
    const watcher = watch(gate, () => {
      if (existsSync(release)) { watcher.close(); resolve(); }
    });
    writeFileSync(join(gate, 'started'), '');
    if (existsSync(release)) { watcher.close(); resolve(); }
  });
  if (readFileSync(release, 'utf8') === 'fail') process.exit(1);
}
process.exit(await Bun.spawn([${JSON.stringify(git)}, ...args], {
  stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
}).exited);
`,
    );
    this.env.PATH = bin + ":" + this.env.PATH;
  }
  private arm(operation: "branches" | "worktree") {
    for (const file of ["started", "release"]) rmSync(join(this.gate, file), { force: true });
    writeFileSync(join(this.gate, "armed"), operation);
  }
  private release(fail = false) {
    rmSync(join(this.gate, "armed"), { force: true });
    writeFileSync(join(this.gate, "release"), fail ? "fail" : "ok");
  }
  async test_a_reload_closes_subscriptions_and_a_viewer_resumes_its_link() {
    const viewer = new viewer_connection.Connection(this.path),
      subscriber = new Connection(this.path);
    try {
      await viewer.request("viewer.open", { cwd: this.temp.name });
      await subscriber.call("session.subscribe", { output: false });
      const before: any = await viewer.request("viewer.sync", { interests: [] });
      await this.rpc({ op: "server.reload", executable: EXE });
      await this.until(() => subscriber.disconnected);
      this.assertEqual(subscriber.failure?.message, "ServerReloading");
      const after: any = await viewer.request("viewer.sync", { interests: [] });
      this.assertEqual(after.viewer, before.viewer);
      this.assertEqual((await this.rpc({ op: "viewer.list" })).viewers.length, 1);
    } finally {
      viewer.close();
      subscriber.close();
    }
  }
  async test_bugreport_keeps_diagnostics_from_an_older_daemon() {
    const path = join(this.temp.name, "older.sock");
    // An older daemon answers HTTP in its own runtime protocol.
    const server = Bun.serve({
      unix: path,
      async fetch(request) {
        const query = await request.json();
        switch (query.op) {
          case "hello":
            return Response.json({ type: "hello", protocol: protocol.version - 1, server_pid: 7 });
          case "bugreport":
            return Response.json({
              ok: true,
              uptime_ms: 192 * 60000,
              viewers: [{ id: 2, terminal: { name: "Older Terminal", cols: 100, rows: 30 } }],
            });
          default:
            return Response.json({ err: "UnsupportedProtocol" }, { status: 400 });
        }
      },
    });
    try {
      const result = await run([EXE, "bugreport", "--full"], {
        env: { ...this.env, CORGI_SOCKET: path },
        cwd: this.temp.name,
      });
      this.assertIn("pid 7, up 3h 12m", result.stdout);
      this.assertIn("Older Terminal", result.stdout);
      this.assertIn("from viewer 2", result.stdout);
    } finally {
      await server.stop(true);
    }
  }
  async test_unversioned_cli_controls_accept_older_daemon_replies() {
    const path = join(this.temp.name, "older.sock"),
      requests: object[] = [];
    const server = Bun.serve({
      unix: path,
      async fetch(request) {
        requests.push(await request.json());
        return Response.json({ ok: true });
      },
    });
    try {
      for (const args of [
        ["focus", "3", "--viewer", "9"],
        ["workspace", "switch", "2"],
      ]) {
        const result = await run([EXE, ...args, "--json"], {
          env: { ...this.env, CORGI_SOCKET: path },
          cwd: this.temp.name,
        });
        this.assertEqual(JSON.parse(result.stdout), { ok: true });
      }
      this.assertEqual(requests, [
        { op: "focus", pane: 3, viewer: 9 },
        { op: "workspace.switch", workspace: 2 },
      ]);
    } finally {
      await server.stop(true);
    }
  }
  async test_shared_rpc_keeps_branch_replies_errors_and_viewer_sync_separate() {
    const conn = new Connection(this.path);
    try {
      await conn.call("viewer.open", { cwd: this.temp.name });
      for (const fail of [false, true]) {
        this.arm("branches");
        const branches = conn.request("git.branches", { workspace: 1 });
        await this.until(() => existsSync(join(this.gate, "started")));
        this.assertTrue((await deadline(conn.call("ping"), 3000)).ok);
        this.assertEqual((await conn.call("viewer.sync", { interests: [] })).type, "view");
        this.assertEqual(await conn.rawRequest({ op: "missing" }), { err: "UnknownOperation" });
        this.assertEqual(await conn.rawRequest(versioned({ op: "viewer.search" })), { err: "MissingField" });
        this.release(fail);
        const result = await branches;
        if (fail) this.assertEqual(result, { err: "BranchesUnavailable" });
        else {
          this.assertFalse("err" in result);
          if (!("err" in result)) this.assertTrue(result.branches.some(branch => branch.name === "main"));
        }
      }
      const printed = JSON.parse(await this.run_cli("rpc", '{"op":"ping"}'));
      this.assertEqual(Object.keys(printed).sort(), ["ok", "pid"]);
    } finally {
      this.release();
      conn.close();
    }
  }
  async test_shared_rpc_keeps_worktree_success_and_failure_with_their_request() {
    await this.advance(4);
    await this.until(async () => !!(await this.session()).workspaces[0].worktrees?.common_dir);
    const conn = new Connection(this.path);
    try {
      await conn.call("ping");
      for (const fail of [false, true]) {
        this.arm("worktree");
        const path = join(this.temp.name, fail ? "failed-tree" : "added-tree");
        const added = conn.request("worktree.add", {
          workspace: 1,
          path,
          branch: fail ? "failed" : "added",
          base: "main",
        });
        await this.until(() => existsSync(join(this.gate, "started")));
        this.assertTrue((await deadline(conn.call("ping"), 3000)).ok);
        this.assertEqual(await conn.request("server.reload", { executable: EXE }), {
          err: "ReloadBusy",
          busy: { op: "worktree.add", path },
        });
        this.release(fail);
        this.assertEqual(await added, fail ? { err: "WorktreeAddFailed" } : { ok: true });
        this.assertEqual(existsSync(path), !fail);
      }
    } finally {
      this.release();
      conn.close();
    }
  }
  async test_reload_cancels_pending_git_and_closes_requests_held_behind_it() {
    let conn = new Connection(this.path);
    try {
      const before = await conn.call("ping");
      this.arm("branches");
      const branches = conn.request("git.branches", { workspace: 1 });
      await this.until(() => existsSync(join(this.gate, "started")));
      this.assertTrue((await conn.call("server.reload", { executable: EXE })).ok);
      this.assertEqual(await branches, { err: "Reloading" });
      this.release();
      await this.until(() => conn.disconnected);
      conn = new Connection(this.path);
      const [reloaded, ping] = await Promise.allSettled([
        conn.call("server.reload", { executable: EXE }),
        conn.call("ping"),
      ]);
      if (reloaded.status !== "fulfilled") throw reloaded.reason;
      this.assertNotEqual(reloaded.value.server_pid, before.pid);
      // The ping waited behind the reload and closed with the old daemon.
      this.assertEqual(ping.status === "rejected" && ping.reason.message, "ServerReloading");
      conn = new Connection(this.path);
      this.assertEqual((await conn.call("ping")).pid, reloaded.value.server_pid);
    } finally {
      this.release();
      conn.close();
    }
  }
  async test_failed_reload_releases_an_untagged_branch_request() {
    const socket = new websocket_socket.Socket(this.path),
      replies = lines(socket);
    try {
      this.arm("branches");
      socket.write(JSON.stringify(versioned({ op: "git.branches", workspace: 1 })) + "\n");
      socket.write('{"op":"ping"}\n');
      await this.until(() => existsSync(join(this.gate, "started")));
      const reloaded = await this.raw_rpc({
        op: "server.reload",
        executable: join(this.temp.name, "missing-corgi"),
      });
      this.assertEqual(reloaded.err, "ReloadCandidateFailed");
      this.assertEqual(JSON.parse(await replies.next()), { err: "Reloading" });
      this.assertTrue(JSON.parse(await replies.next(1000)).ok);
    } finally {
      this.release();
      socket.destroy();
    }
  }
  async test_requests_without_ids_reply_in_order() {
    const socket = new websocket_socket.Socket(this.path),
      replies = lines(socket);
    try {
      this.arm("branches");
      socket.write(JSON.stringify(versioned({ op: "git.branches", workspace: 1 })) + "\n");
      socket.write('{"op":"ping"}\n');
      await this.until(() => existsSync(join(this.gate, "started")));
      const other = new Connection(this.path);
      try {
        this.assertTrue((await deadline(other.call("ping"), 3000)).ok);
      } finally {
        other.close();
      }
      this.release();
      const branches = JSON.parse(await replies.next(8000));
      this.assertFalse("request_id" in branches);
      this.assertTrue(branches.branches.some((branch: { name: string }) => branch.name === "main"));
      this.assertTrue(JSON.parse(await replies.next()).ok);
    } finally {
      this.release();
      socket.destroy();
    }
  }
  async test_followed_history_replies_before_its_events() {
    const project = join(this.env.CLAUDE_CONFIG_DIR!, "projects", "rpc-history"),
      session = "00000000-0000-4000-8000-000000000001";
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(project, session + ".jsonl"),
      JSON.stringify({
        type: "user",
        cwd: this.temp.name,
        message: { role: "user", content: "RPC history ordering" },
      }) + "\n",
    );
    const conn = new Connection(this.path),
      history = Promise.withResolvers<Extract<protocol.Event, { type: "agent.history" }>>(),
      unsubscribe = conn.onEvent(event => {
        if (event.type === "agent.history") history.resolve(event);
      });
    try {
      this.assertEqual(
        (await conn.call("agent.subscribe", { workspace: 1, cwd: this.temp.name })).type,
        "agent.preview",
      );
      // Make the initial followed snapshot ready before asking for it.
      await this.until(async () =>
        (await conn.call("agent.history")).history?.entries.some(entry => entry.session === session),
      );
      const wire: string[] = [];
      let buffer = "";
      conn.socket.on("data", chunk => {
        buffer += chunk;
        for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
          const message = JSON.parse(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
          // Observe wire order: promise callbacks can run after event callbacks
          // even when the reply was first in the same socket chunk.
          if ("request_id" in message) wire.push("reply");
          else if (message.type === "agent.history") wire.push("history");
        }
      });
      this.assertEqual(await deadline(conn.call("agent.history", { follow: true }), 3000), { ok: true });
      const event = await deadline(history.promise, 3000);
      this.assertTrue(event.update.full);
      this.assertTrue(
        event.update.entries.some(entry => entry.session === session && entry.first === "RPC history ordering"),
      );
      this.assertEqual(wire.slice(0, 2), ["reply", "history"]);
      this.assertTrue((await deadline(conn.call("ping"), 3000)).ok);
    } finally {
      unsubscribe();
      conn.close();
    }
  }
  async test_disconnected_deferred_request_finishes_without_blocking_reload() {
    const conn = new Connection(this.path);
    try {
      await conn.call("ping");
      this.arm("branches");
      const branches = conn.call("git.branches", { workspace: 1 }).then(
        () => "unexpected success",
        error => error.message,
      );
      await this.until(() => existsSync(join(this.gate, "started")));
      conn.close();
      this.assertEqual(await branches, "ConnectionClosed");
      this.release();
      await this.until(async () => {
        const response = await this.raw_rpc({ op: "server.reload", executable: EXE });
        if (response.err === "ReloadBusy") return false;
        this.assertTrue(response.ok);
        return true;
      });
    } finally {
      this.release();
      conn.close();
    }
  }
}
registerCase("Rpc", Rpc);
