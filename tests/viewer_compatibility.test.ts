import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { Runtime } from "./runtime";
import { Viewer } from "./viewer_client";
import { EXE, JsonSocket, Lines, Pty, registerCase, run } from "./support";

class ReplyProxy {
  server: Server;
  connections: Socket[] = [];
  sync_reply: any = null;
  open_reply: any = null;
  synced = false;
  constructor(
    public path: string,
    public upstream: string,
  ) {
    this.server = createServer(client => this.forward(client));
  }
  async start() {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.path, resolve);
    });
  }
  forward(client: Socket) {
    const server = createConnection(this.upstream);
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
    server.on("close", () => {
      client.destroy();
      replies.end();
    });
    const loop = async () => {
      try {
        while (true) {
          const line = await requests.next(30000),
            request = JSON.parse(line);
          server.write(line + "\n");
          const upstreamReply = await replies.next(30000);
          let reply = upstreamReply;
          if (request.op === "viewer.open" && this.open_reply !== null) reply = JSON.stringify(this.open_reply);
          if (request.op === "viewer.sync") {
            if (this.sync_reply !== null) reply = JSON.stringify(this.sync_reply);
            this.synced = true;
          }
          client.write(reply + "\n");
        }
      } catch {
        client.destroy();
        server.destroy();
      }
    };
    void loop();
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
    this.assertIn("requires viewer protocol 3", output);
    this.assertIn("Reattach using the same Corgi version as the server", output);
    this.assertNotIn("MissingField", output);
    this.assertNotIn("panic:", output);
  }
  async test_server_rejects_open_before_creating_or_attaching() {
    for (const version of [null, 2, 4, -1, "3"]) {
      const request: any = {
        op: "viewer.open",
        protocol: 1,
        cwd: this.temp.name,
      };
      if (version !== null) request.viewer_protocol = version;
      const result = await this.raw_rpc(request);
      this.assertEqual(result.err, "UnsupportedViewerProtocol");
      this.assertEqual(result.viewer_protocol, 3);
    }
    this.assertEqual((await this.session()).panes, []);
    this.assertEqual((await this.raw_rpc({ op: "viewer.list" })).viewers, []);
  }
  async test_server_rechecks_sync_on_inherited_connection() {
    const client = await JsonSocket.connect(this.path);
    try {
      const call = (request: any) => client.request({ protocol: 1, ...request });
      const opened = await call({
        op: "viewer.open",
        viewer_protocol: 3,
        onboarding: true,
      });
      this.assertEqual(opened.viewer_protocol, 3);
      const oldPid = (await this.session()).server_pid;
      await this.run_cli("reload", EXE);
      this.assertNotEqual((await this.session()).server_pid, oldPid);
      const rejected = await call({
        op: "viewer.sync",
        viewer_protocol: 4,
        interests: "different format",
      });
      this.assertEqual(rejected.err, "UnsupportedViewerProtocol");
      this.assertEqual(rejected.viewer_protocol, 3);
      const accepted = await call({
        op: "viewer.sync",
        viewer_protocol: 3,
        interests: [],
      });
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
      { viewer_protocol: 4 },
      { viewer_protocol: "3" },
      { err: "UnsupportedViewerProtocol", viewer_protocol: 4 },
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
      const stderr = await (viewer as any).stderr;
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
    proxy.sync_reply = { viewer_protocol: 4 };
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
}
registerCase("ViewerCompatibility", ViewerCompatibility, { inherited: false });
