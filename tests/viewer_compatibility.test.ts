import * as websocket_socket from "../src/websocket_socket";
import type { Duplex } from "node:stream";
import * as websocket_server from "../src/fixtures/websocket_server";
import * as errors from "../src/errors";
import * as wire_websocket from "../src/wire_websocket";
import { join } from "node:path";
import { Runtime } from "./runtime";
import { Viewer } from "./viewer_client";
import { EXE, Lines, Pty, registerCase, run, shellJoin, versioned } from "./support";
import * as rpc from "../src/rpc";
import * as protocol from "../src/protocol";
import * as rpc_http from "../src/rpc_http";

const current = protocol.viewer_version,
  newer = current + 1;

class ReplyProxy {
  server: websocket_server.Server;
  connections: Duplex[] = [];
  sync_reply: any = null;
  open_reply: any = null;
  uninstall_on_sync = false;
  synced = false;
  constructor(
    public path: string,
    public upstream: string,
  ) {
    const daemon = new rpc_http.Client(upstream);
    this.server = websocket_server.createServer(
      client => this.forward(client),
      // Discovery and other one-shot requests pass through unchanged.
      async request => Response.json(await daemon.post(await request.json())),
    );
  }
  async start() {
    await new Promise<void>(resolve => this.server.listen(this.path, resolve));
  }
  /** Relays the viewer's WebSocket to the daemon's, a line at a time. */
  forward(client: websocket_server.Socket) {
    const server = new websocket_socket.Socket(this.upstream);
    this.connections.push(client, server);
    const requests = new Lines(),
      replies = new Lines();
    client.setEncoding("utf8");
    server.setEncoding("utf8");
    client.on("data", data => requests.feed(String(data)));
    server.on("data", data => replies.feed(String(data)));
    client.on("close", () => {
      server.destroy();
      requests.end();
    });
    // A reload closes the daemon's side; the viewer hears it the same way and reconnects.
    server.on("error", error => {
      if (errors.is(error, "ServerReloading")) client.close(wire_websocket.reloading);
    });
    server.on("close", () => {
      client.destroy();
      replies.end();
    });
    const pending = new Map<number, protocol.Op>();
    const forwardRequests = async () => {
      for (;;) {
        const line = await requests.next(30000),
          request = JSON.parse(line),
          id = protocol.requestId(request);
        if (id !== null) pending.set(id, protocol.parse(request));
        server.write(line + "\n");
      }
    };
    const forwardReplies = async () => {
      for (;;) {
        const line = await replies.next(30000),
          id = protocol.requestId(JSON.parse(line)),
          op = id === null ? null : pending.get(id);
        if (id !== null) pending.delete(id);
        let replacement: object | null = null;
        if (op === "viewer.open") replacement = this.open_reply;
        // A viewer with a data connection configures its stream on this one,
        // and while nothing changes, only sends receipts.
        if (
          op === "viewer.sync" ||
          op === "viewer.stream" ||
          op === "viewer.stream.configure" ||
          op === "viewer.receipt"
        ) {
          if (op !== "viewer.receipt") replacement = this.sync_reply;
          this.synced = true;
          if (this.uninstall_on_sync) {
            this.uninstall_on_sync = false;
            // Deliver the uninstall event, then close without answering the pending sync.
            client.end(JSON.stringify({ type: "uninstalled" }) + "\n");
            return;
          }
        }
        const reply = replacement === null ? line : JSON.stringify({ ...replacement, request_id: id });
        client.write(reply + "\n");
      }
    };
    void Promise.all([forwardRequests(), forwardReplies()]).catch(() => {
      client.destroy();
      server.destroy();
    });
  }
  async close() {
    for (const connection of this.connections) connection.destroy();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }
}

class ViewerCompatibility extends Runtime {
  async proxy() {
    const path = join(this.temp.name, "viewer.sock");
    const proxy = new ReplyProxy(path, this.path);
    await proxy.start();
    this.addCleanup(() => proxy.close());
    return [proxy, { ...this.env, CORGI_SOCKET: path }] as const;
  }
  assert_explanation(code: number | null, output: string) {
    this.assertEqual(code, 1, output);
    this.assertIn("this viewer is incompatible with the server", output);
    this.assertIn(`requires viewer protocol ${current}`, output);
    this.assertIn("Reattach using the same Corgi version as the server", output);
    this.assertNotIn("MissingField", output);
    this.assertNotIn("panic:", output);
  }
  async test_server_rejects_open_before_creating_or_attaching() {
    for (const version of [undefined, current - 1, newer, -1, String(current)]) {
      const result = await this.raw_rpc({
        op: "viewer.open",
        cwd: { incompatible: "payload" },
        viewer_protocol: version,
      });
      this.assertEqual(result.err, "UnsupportedViewerProtocol");
      this.assertEqual(result.viewer_protocol, current);
    }
    this.assertEqual((await this.session()).panes, []);
    this.assertEqual((await this.raw_rpc({ op: "viewer.list" })).viewers, []);
  }
  async test_server_rechecks_sync_after_a_viewer_resumes() {
    let client = new rpc.Connection(this.path);
    try {
      const call = (request: { op: string; [field: string]: unknown }): Promise<any> =>
        client.rawRequest(versioned(request));
      const { link } = await call({ op: "link.open" });
      const opened = await call({ op: "viewer.open", onboarding: true });
      this.assertEqual(opened.viewer_protocol, current);
      const oldPid = (await this.session()).server_pid;
      await this.run_cli("reload", EXE);
      this.assertNotEqual((await this.session()).server_pid, oldPid);
      await this.until(() => client.disconnected);
      client = new rpc.Connection(this.path);
      this.assertTrue((await call({ op: "link.resume", link })).viewer);
      const rejected = await call({
        op: "viewer.sync",
        viewer_protocol: newer,
        interests: "different format",
      });
      this.assertEqual(rejected.err, "UnsupportedViewerProtocol");
      this.assertEqual(rejected.viewer_protocol, current);
      const accepted = await call({ op: "viewer.sync", interests: [] });
      this.assertEqual(accepted.type, "view");
    } finally {
      client.close();
    }
  }
  async test_connected_viewer_explains_incompatible_handoff_responses() {
    const [proxy, env] = await this.proxy(),
      originalEnv = this.env;
    const replies = [
      {},
      { viewer_protocol: newer },
      { viewer_protocol: String(current) },
      { err: "UnsupportedViewerProtocol", viewer_protocol: newer },
      { err: "UnsupportedProtocol" },
    ];
    for (const reply of replies) {
      proxy.sync_reply = null;
      this.env = env;
      let viewer: Viewer;
      try {
        viewer = await Viewer.create(this);
      } finally {
        this.env = originalEnv;
      }
      const oldPid = (await this.session()).server_pid;
      await this.run_cli("reload", EXE);
      this.assertNotEqual((await this.session()).server_pid, oldPid);
      this.assertFalse((await viewer.poll()).detached);
      proxy.sync_reply = reply;
      (viewer.proc.stdin as Bun.FileSink).write('{"op":"poll"}\n');
      await (viewer.proc.stdin as Bun.FileSink).flush();
      const code = await viewer.proc.exited;
      const stderr = await viewer.stderr;
      this.assert_explanation(code, stderr);
    }
  }
  async test_attach_restores_terminal_before_explaining_incompatibility() {
    const [proxy, env] = await this.proxy();
    delete (env as Record<string, string | undefined>).CORGI_PANE;
    const pty = new Pty(80, 24);
    this.addCleanup(() => pty.close());
    const before = await pty.settings();
    pty.start([EXE, "--no-update"], { env, cwd: this.temp.name });
    await this.until(() => proxy.synced);
    await this.run_cli("reload", EXE);
    proxy.sync_reply = { viewer_protocol: newer };
    const code = await pty.proc.exited;
    this.assert_explanation(code, pty.output);
    this.assertLess(pty.output.indexOf("\x1b[?1049l"), pty.output.indexOf("this viewer is incompatible"));
    this.assertEqual(await pty.settings(), before);
  }
  async test_new_viewer_rejects_unversioned_open_reply() {
    const [proxy, env] = await this.proxy();
    proxy.open_reply = { ok: true, workspace: 1, bell_seq: 0 };
    const process = await run([EXE, "__viewer-test"], {
      input: "",
      env,
      cwd: this.temp.name,
      timeout: 5000,
      check: false,
    });
    this.assert_explanation(process.code, process.stderr);
  }
  async test_uninstall_during_a_pending_sync_shows_farewell_and_exits_successfully() {
    const [proxy, env] = await this.proxy(),
      pty = new Pty(80, 24);
    this.addCleanup(() => pty.close());
    const before = await pty.settings();
    const shell = `${shellJoin([EXE, "--no-update"])}; viewer_status=$?; printf 'AFTER_FAREWELL_READY\n'; IFS= read -r line; printf 'AFTER_FAREWELL:%s\n' "$line"; exit "$viewer_status"`;
    pty.start(["/bin/sh", "-c", shell], { env, cwd: this.temp.name });
    await this.until(() => proxy.synced);
    proxy.uninstall_on_sync = true;
    await pty.waitFor("The Farm", 10_000);
    pty.write("ignored-during-farewell\n");
    await pty.waitFor("Corgi was uninstalled.", 10_000);
    await pty.waitFor("AFTER_FAREWELL_READY");
    pty.write("after-farewell\n");
    await pty.waitFor("AFTER_FAREWELL:after-farewell");
    this.assertEqual(await pty.proc.exited, 0);
    this.assertIn("The Farm", pty.output);
    this.assertNotIn("ConnectionClosed", pty.output);
    this.assertEqual(await pty.settings(), before);
  }
}
registerCase("ViewerCompatibility", ViewerCompatibility, { inherited: false });
