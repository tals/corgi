import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { Connection } from "../src/rpc";
import { Runtime } from "./runtime";
import { EXE, JsonSocket, deadline, registerCase, run, versioned, writeExecutable } from "./support";

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
  async test_bugreport_keeps_diagnostics_from_an_older_daemon() {
    const path = join(this.temp.name, "legacy.sock");
    const server = createServer(socket => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", chunk => {
        buffer += chunk;
        if (!buffer.includes("\n")) return;
        const query = JSON.parse(buffer.trim());
        // Protocol 3 ignores request ids and replies without them.
        switch (query.op) {
          case "hello":
            socket.end(JSON.stringify({ type: "hello", protocol: 3, server_pid: 7 }) + "\n");
            break;
          case "bugreport":
            socket.end(
              JSON.stringify({
                ok: true,
                uptime_ms: 192 * 60000,
                viewers: [{ id: 2, terminal: { name: "Legacy Terminal", cols: 100, rows: 30 } }],
              }) + "\n",
            );
            break;
          default:
            socket.end('{"err":"UnsupportedProtocol"}\n');
        }
      });
    });
    await new Promise<void>(resolve => server.listen(path, resolve));
    try {
      const result = await run([EXE, "bugreport", "--full"], {
        env: { ...this.env, CORGI_SOCKET: path },
        cwd: this.temp.name,
      });
      this.assertIn("pid 7, up 3h 12m", result.stdout);
      this.assertIn("Legacy Terminal", result.stdout);
      this.assertIn("from viewer 2", result.stdout);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
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
        this.assertEqual(await conn.request("server.reload", { executable: EXE }), { err: "ReloadBusy" });
        this.release(fail);
        this.assertEqual(await added, fail ? { err: "WorktreeAddFailed" } : { ok: true });
        this.assertEqual(existsSync(path), !fail);
      }
    } finally {
      this.release();
      conn.close();
    }
  }
  async test_reload_drops_pending_git_then_preserves_correlated_and_pipelined_replies() {
    const conn = new Connection(this.path);
    try {
      const before = await conn.call("ping");
      this.arm("branches");
      const branches = conn.request("git.branches", { workspace: 1 });
      await this.until(() => existsSync(join(this.gate, "started")));
      this.assertTrue((await conn.call("server.reload", { executable: EXE })).ok);
      this.assertEqual(await branches, { err: "Reloading" });
      this.release();
      const [reloaded, ping] = await Promise.all([conn.call("server.reload", { executable: EXE }), conn.call("ping")]);
      this.assertTrue(reloaded.ok);
      this.assertNotEqual(ping.pid, before.pid);
      this.assertEqual((await conn.call("ping")).pid, ping.pid);
    } finally {
      this.release();
      conn.close();
    }
  }
  async test_requests_without_ids_reply_in_order() {
    const socket = await JsonSocket.connect(this.path);
    try {
      this.arm("branches");
      socket.send(versioned({ op: "git.branches", workspace: 1 }));
      socket.send({ op: "ping" });
      await this.until(() => existsSync(join(this.gate, "started")));
      const other = new Connection(this.path);
      try {
        this.assertTrue((await deadline(other.call("ping"), 3000)).ok);
      } finally {
        other.close();
      }
      this.release();
      const branches = await socket.read(8000);
      this.assertFalse("request_id" in branches);
      this.assertTrue(branches.branches.some((branch: { name: string }) => branch.name === "main"));
      this.assertTrue((await socket.read()).ok);
    } finally {
      this.release();
      socket.close();
    }
  }
  async test_followed_history_replies_before_its_events() {
    const conn = new Connection(this.path);
    try {
      this.assertEqual(
        (await conn.call("agent.subscribe", { workspace: 1, cwd: this.temp.name })).type,
        "agent.preview",
      );
      this.assertEqual(await deadline(conn.call("agent.history", { follow: true }), 3000), { ok: true });
      this.assertTrue((await deadline(conn.call("ping"), 3000)).ok);
    } finally {
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
