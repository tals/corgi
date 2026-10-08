import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { registerCase, run, shellJoin } from "./support";
import { Runtime } from "./runtime";
import { Viewer } from "./viewer_client";
import { fixture } from "./ports";

class Ports extends Runtime {
  fixturePid: number | null = null;
  async setUp() {
    await super.setUp();
    for (const key of ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"])
      delete this.env[key];
  }
  async tearDown() {
    if (this.fixturePid) {
      try {
        process.kill(this.fixturePid, "SIGTERM");
      } catch {}
    }
    await super.tearDown();
  }
  async newPane(command: string) {
    const ws = (await this.session()).workspaces[0].id;
    return (
      await this.command("pane.create", {
        workspace: ws,
        cwd: this.temp.name,
        command,
      })
    ).pane;
  }
  workspacePorts(ws: number) {
    return this.session().then(
      (snapshot: any) =>
        snapshot.ports.workspaces.find((w: any) => w.id === ws) ?? {},
    );
  }
  async test_inventory_http_https_udp_and_per_viewer_links() {
    const root = this.temp.name;
    const cert = join(root, "cert.pem"),
      key = join(root, "key.pem");
    await run([
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
    ]);
    const hosted = fixture(root, { cert, key });
    const pane = await this.newPane(hosted.command + " & wait");
    await this.until(() => existsSync(hosted.ready));
    const info = JSON.parse(readFileSync(hosted.ready, "utf8"));
    this.fixturePid = info.pid;
    const ws = (await this.session()).workspaces[0].id;
    // Each rescan probes a few endpoints; let rescans happen back to back.
    await this.untilAdvancing(3, async () => {
      const endpoints = (await this.workspacePorts(ws)).endpoints ?? [];
      return (
        endpoints.length === 4 &&
        endpoints.filter((e: any) => e.scheme !== "unknown").length === 3
      );
    });
    const work = await this.workspacePorts(ws);
    this.assertGreaterEqual(work.background, 1);
    const endpoints = Object.fromEntries(
      work.endpoints.map((e: any) => [e.port, e]),
    );
    for (const e of Object.values(endpoints) as any[]) {
      this.assertEqual(e.pid, info.pid);
      this.assertEqual(e.pane, pane);
    }
    this.assertEqual(endpoints[info.wild].scheme, "http");
    this.assertEqual(endpoints[info.secure].scheme, "https");
    this.assertEqual(endpoints[info.udp].transport, "udp");
    this.assertEqual(endpoints[info.udp].scheme, "unknown");
    this.assertTrue(endpoints[info.wild].interfaces.length > 0);
    this.assertTrue(
      endpoints[info.local].interfaces.every((i: any) => i.kind === "loopback"),
    );
    const local = await Viewer.create(this);
    await local.request({ op: "size", cols: 160, rows: 40 });
    await local.input("\x1b[<0;28;6M\x1b[<32;100;6M\x1b[<0;100;6m");
    let data = await this.until(async () => {
      const frame = (await local.poll()).data;
      return frame.includes("Open Link ↗ 3") ? frame : false;
    }, 12);
    this.assertIn("Open Link ↗ 3", data);
    this.assertNotIn("http://localhost:", data);
    this.assertIn(
      "\x1b]22;pointer\x1b\\",
      (await local.input("\x1b[<35;90;3M")).data,
    );
    this.assertFalse((await local.input("\x1b[<0;90;3M")).effects.length);
    let state = await local.input("\x1b[<0;90;3m");
    this.assertFalse(state.effects.length);
    data = state.data;
    this.assertIn(`;http://localhost:${info.wild}\x1b\\`, data);
    this.assertIn(`https://localhost:${info.secure}`, data);
    this.assertIn("Links · Esc to close", data);
    this.assertIn("\x1b]22;default\x1b\\", data);
    this.assertIn(
      "\x1b]22;pointer\x1b\\",
      (await local.input("\x1b[<35;52;16M")).data,
    );
    this.assertFalse((await local.input("\x1b[<0;52;16M")).effects.length);
    this.assertEqual((await local.input("\x1b[<0;52;16m")).effects, [
      { open_url: `http://localhost:${work.endpoints[0].port}` },
    ]);
    await local.input("\x1b[<0;90;3M");
    await local.input("\x1b[<32;95;3M");
    state = await local.input("\x1b[<0;90;3m");
    this.assertFalse(state.effects.length);
    this.assertNotIn("Links · Esc to close", state.data);
    await local.input("\x1b[<0;90;3M\x1b[<0;90;3m");
    await local.input("\x1b[B");
    this.assertEqual((await local.input("\r")).effects.length, 1);
    this.env.SSH_CONNECTION = "100.80.1.9 12345 100.80.1.2 22";
    const remote = await Viewer.create(this);
    await remote.request({ op: "size", cols: 160, rows: 40 });
    await remote.input("\x1b[<0;28;6M\x1b[<32;100;6M\x1b[<0;100;6m");
    data = (await remote.poll()).data;
    this.assertFalse(
      (await remote.input("\x1b[<0;7;5M\x1b[<0;7;5m")).effects.length,
    );
    this.assertNotIn("http://localhost:", data);
    this.assertNotIn("https://localhost:", data);
    this.assertNotIn(`localhost:${info.local}`, data);
    this.assertNotIn(`:${info.udp}`, data);
    const choices = endpoints[info.wild].interfaces.filter(
      (i: any) =>
        i.kind !== "loopback" &&
        !i.address.startsWith("169.254.") &&
        !i.address.startsWith("fe80:"),
    );
    if (choices.length) {
      const rank: any = { tailscale: 0, vpn: 1, network: 2 };
      const preferred = choices.sort(
        (a: any, b: any) =>
          rank[a.kind] - rank[b.kind] || Number(a.ipv6) - Number(b.ipv6),
      )[0];
      this.assertIn(`http://${preferred.address}:${info.wild}`, data);
    }
    const second = (
      await this.command("workspace.create", { name: "Other", cwd: root })
    ).workspace;
    await this.command("pane.create", {
      workspace: second,
      command: "sleep 60",
    });
    await this.until(
      async () =>
        (await this.session()).ports.workspaces.some(
          (w: any) => w.id === second,
        ),
      15,
    );
    this.assertFalse((await this.workspacePorts(second)).endpoints.length);
    await this.command("pane.close", { target: pane });
    await this.until(
      async () =>
        !(await this.session()).ports.workspaces.some(
          (w: any) => w.endpoints.length,
        ),
      15,
    );
  }
  async test_single_url_opens_directly() {
    const hosted = fixture(this.temp.name, { single: true });
    await this.newPane("exec " + hosted.command);
    await this.until(() => existsSync(hosted.ready));
    const port = JSON.parse(readFileSync(hosted.ready, "utf8")).single;
    await this.until(
      async () =>
        (await this.session()).ports.workspaces.some((w: any) =>
          w.endpoints.some((e: any) => e.http_status === 200),
        ),
      20,
    );
    const viewer = await Viewer.create(this);
    const data = (await viewer.poll()).data;
    this.assertIn(`http://localhost:${port}`, data);
    this.assertNotIn("Open Link ↗ 1", data);
    this.assertIn(
      "\x1b]22;pointer\x1b\\",
      (await viewer.input("\x1b[<35;14;3M")).data,
    );
    this.assertIn(
      "\x1b]22;default\x1b\\",
      (await viewer.input("\x1b[<35;110;30M")).data,
    );
    const state = await viewer.input("\x1b[<0;14;3M\x1b[<0;14;3m");
    this.assertEqual(state.effects, [{ open_url: `http://localhost:${port}` }]);
    this.assertNotIn("Links · Esc to close", state.data);
  }
  async test_get_probe_filters_http_errors_and_counts_foreground_workload() {
    const hosted = fixture(this.temp.name, { status: true });
    await this.newPane("exec " + hosted.command);
    await this.until(() => existsSync(hosted.ready));
    const ports = JSON.parse(readFileSync(hosted.ready, "utf8"));
    const ws = (await this.session()).workspaces[0].id;
    await this.untilAdvancing(3, async () => {
      const ends = (await this.workspacePorts(ws)).endpoints ?? [];
      return ends.length === 6 && ends.every((e: any) => e.probed_at > 0);
    });
    const work = await this.workspacePorts(ws);
    this.assertEqual(work.background, 1);
    const endpoints = Object.fromEntries(
      work.endpoints.map((e: any) => [e.port, e]),
    );
    for (const status of [200, 302, 401, 404, 500]) {
      this.assertEqual(endpoints[ports[String(status)]].http_status, status);
      this.assertEqual(endpoints[ports[String(status)]].scheme, "http");
    }
    this.assertEqual(endpoints[ports.raw].scheme, "unknown");
    const viewer = await Viewer.create(this);
    await viewer.request({ op: "size", cols: 160, rows: 40 });
    await viewer.input("\x1b[<0;28;6M\x1b[<32;100;6M\x1b[<0;100;6m");
    // Probe completion precedes asynchronous link naming.
    let data = await this.until(async () => {
      const frame = (await viewer.poll()).data;
      return frame.includes("Open Link ↗ 2") ? frame : false;
    }, 12);
    this.assertIn("Open Link ↗ 2", data);
    data = (await viewer.input("\x1b[<0;90;3M\x1b[<0;90;3m")).data;
    for (const status of [200, 302])
      this.assertIn(`http://localhost:${ports[String(status)]}`, data);
    for (const status of ["401", "404", "500", "raw"]) {
      this.assertNotIn(`http://localhost:${ports[status]}`, data);
      this.assertNotIn(`:${ports[status]}`, data);
    }
    await this.advance(3.2); // A later rescan keeps the recent probe.
    const cached = Object.fromEntries(
      (await this.workspacePorts(ws)).endpoints.map((e: any) => [e.port, e]),
    );
    this.assertEqual(cached[ports["401"]].http_status, 401);
    this.assertNotIn(
      `http://localhost:${ports["401"]}`,
      (await viewer.poll()).data,
    );
  }
}

registerCase("ports", Ports, {
  skip:
    !Bun.which("lsof") || !Bun.which("curl")
      ? "discovery requires lsof and curl"
      : undefined,
  timeout: 120_000,
});
