import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Runtime } from "./runtime";
import { Viewer } from "./viewer_client";
import { EXE, JsonSocket, registerCase, shellJoin, sleep, versioned, writeExecutable } from "./support";

// Viewer stamps and session hashes contain u64 values. The default JSON.parse
// rounds them and makes an unchanged receipt look stale.
function parseWire(line: string) {
  let quoted = false,
    escaped = false,
    result = "";
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
      result += char;
    } else if (char >= "0" && char <= "9") {
      let end = i + 1;
      while (end < line.length && line[end] >= "0" && line[end] <= "9") end++;
      const digits = line.slice(i, end);
      result += digits.length >= 16 && BigInt(digits) > BigInt(Number.MAX_SAFE_INTEGER) ? `"${digits}"` : digits;
      i = end - 1;
    } else result += char;
  }
  return JSON.parse(result);
}

function wireRequest(value: Record<string, any>) {
  return JSON.stringify(value, (key, item) =>
    (key === "identity" || key === "session_hash" || key === "resources_hash") &&
    typeof item === "string" &&
    /^\d{16,}$/.test(item)
      ? `__RAW_U64_${item}__`
      : item,
  ).replace(/"__RAW_U64_(\d+)__"/g, "$1");
}

class WireViewer {
  client!: JsonSocket;
  pane: number;
  cols: number;
  rows: number;
  session_hash: any = null;
  resources_hash: any = null;
  /** Whether it asks for resource readings, which wake it as they come. */
  resources = true;
  known: any = null;
  frame: any = null;
  session: any = null;
  response_bytes = 0;
  constructor(pane: number, cols = 80, rows = 24) {
    this.pane = pane;
    this.cols = cols;
    this.rows = rows;
  }
  static async create(test: Runtime, pane: number, cols = 80, rows = 24) {
    const viewer = new WireViewer(pane, cols, rows);
    viewer.client = await JsonSocket.connect(test.path);
    await viewer.call({ op: "viewer.open", cwd: test.temp.name });
    test.addCleanup(() => viewer.close());
    return viewer;
  }
  close() {
    this.client.close();
  }
  async call(request: { op: string; [field: string]: any }) {
    this.client.socket.write(wireRequest(versioned(request)) + "\n");
    const line = await this.client.lines.next(5000);
    this.response_bytes = Buffer.byteLength(line) + 1;
    const reply = parseWire(line);
    if ("err" in reply) throw new Error(JSON.stringify(reply));
    return reply;
  }
  async sync(offset: any = null, accept = true, options: Record<string, any> = {}) {
    const reply = await this.call({
      op: "viewer.sync",
      session_hash: this.session_hash,
      resources_hash: this.resources_hash,
      resources: this.resources,
      interests: [
        {
          pane: this.pane,
          cols: this.cols,
          rows: this.rows,
          offset,
          known: this.known,
        },
      ],
      focus: this.pane,
      ...options,
    });
    this.session_hash = reply.session_hash;
    this.resources_hash = reply.resources_hash;
    if (reply.session != null) this.session = reply.session;
    if (accept && reply.surfaces.length) {
      this.frame = reply.surfaces[0];
      this.known = this.frame.stamp;
    }
    return reply;
  }
  text() {
    return this.frame ? this.frame.surface.lines.join("") : "";
  }
}

class ViewerSync extends Runtime {
  async new(command = "printf 'IDLE_SURFACE'; sleep 60") {
    return (
      await this.command("pane.create", {
        workspace: (await this.session()).workspaces[0].id,
        cwd: this.temp.name,
        command,
      })
    ).pane;
  }
  async ready(viewer: WireViewer, text: string) {
    await this.until(async () => {
      await viewer.sync();
      return viewer.text().includes(text);
    });
  }

  async echoPane(name: string) {
    const fixture = join(this.temp.name, `${name}.ts`);
    writeExecutable(
      fixture,
      `process.stdin.setRawMode(true);
process.stdin.on("data", data => process.stdout.write(data));
process.stdin.resume();
process.stdout.write("READY\\r\\n");
`,
    );
    const pane = await this.new("exec " + shellJoin([process.execPath, fixture]));
    await this.until(async () => {
      const screen = await this.command("pane.read", { target: pane, view: "screen" });
      return (
        screen.text.includes("READY") &&
        (await this.session()).panes.some((p: { id: number; command: string }) => p.id === pane && p.command === name)
      );
    });
    return pane;
  }

  /** A reply on the watch stream follows every notification already queued there. */
  async watchWakes(watch: JsonSocket) {
    watch.send({ op: "ping" });
    let wakes = 0;
    for (;;) {
      const reply = await watch.read();
      if (reply.type === "viewer.wake") {
        wakes++;
        continue;
      }
      this.assertEqual(reply.ok, true);
      this.assertGreater(reply.pid, 0);
      return wakes;
    }
  }

  async test_idle_sync_omits_surfaces_and_metadata_but_delivers_controls() {
    const pane = await this.new(),
      viewer = await WireViewer.create(this, pane);
    await this.ready(viewer, "IDLE_SURFACE");
    const reply = await this.until(async () => {
      const result = await viewer.sync();
      return result.session == null ? result : null;
    });
    this.assertEqual(reply.surfaces, []);
    this.assertLess(viewer.response_bytes, 400);
    for (let i = 0; i < 10; i++) this.assertEqual((await viewer.sync()).surfaces, []);
    await this.command("pane.rename", {
      target: pane,
      name: "Renamed metadata",
    });
    const renamed = await viewer.sync();
    this.assertIsNotNone(renamed.session);
    this.assertEqual(renamed.surfaces, []);
    this.assertEqual(viewer.session.panes.find((p: any) => p.id === pane).name, "Renamed metadata");
    await this.rpc({
      op: "action",
      name: "rename",
      value: "Queued",
      viewer: renamed.viewer,
    });
    const control = await viewer.sync();
    this.assertEqual(control.controls[0].value, "Queued");
    this.assertEqual(control.surfaces, []);
    this.assertEqual((await viewer.sync(null, true, { ack: control.controls[0].seq })).controls, []);
  }

  async test_output_modes_viewport_resize_and_theme_invalidate_receipts() {
    const fixture = join(this.temp.name, "modes.ts");
    writeExecutable(
      fixture,
      `#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
spawnSync('stty', ['raw', '-echo'], { stdio: 'inherit' });
process.stdout.write(Array.from({length: 60}, (_, i) => 'ROW_' + String(i).padStart(3, '0') + '\\r\\n').join(''));
process.stdin.on('data', () => process.stdout.write('\\x1b[?1h\\x1b[?2004h'));
process.stdin.resume();
`,
    );
    const pane = await this.new(shellJoin(["bun", fixture])),
      viewer = await WireViewer.create(this, pane);
    await this.ready(viewer, "ROW_059");
    const live = viewer.known;
    this.assertTrue((await viewer.sync(0)).surfaces.length);
    this.assertIn("ROW_000", viewer.text());
    this.assertEqual((await viewer.sync(0)).surfaces, []);
    this.assertTrue((await viewer.sync()).surfaces.length);
    this.assertEqual(viewer.known, live);
    viewer.cols = 90;
    this.assertEqual((await viewer.sync(null, true, { active: true })).surfaces[0].surface.cols, 90);
    this.assertEqual((await viewer.sync()).surfaces, []);
    const before = viewer.text();
    await this.command("pane.input", { target: pane, data: "m" });
    await this.until(async () => {
      await viewer.sync();
      return viewer.frame.modes.cursor_keys && viewer.frame.modes.bracketed_paste;
    });
    this.assertEqual(viewer.text(), before);
    this.assertEqual((await viewer.sync()).surfaces, []);
    await viewer.call({
      op: "theme",
      theme: { background: { r: 1, g: 2, b: 3 } },
    });
    this.assertTrue((await viewer.sync()).surfaces.length);
    this.assertEqual((await viewer.sync()).surfaces, []);
  }

  async test_unapplied_surface_is_retried_and_handoff_invalidates_receipts() {
    const pane = await this.new("exec /bin/sh"),
      viewer = await WireViewer.create(this, pane);
    await viewer.sync();
    await this.command("pane.input", {
      target: pane,
      data: "printf 'LATEST_%s\\n' OUTPUT\r",
    });
    await this.until(async () => {
      const reply = await viewer.sync(null, false);
      return reply.surfaces.length && reply.surfaces[0].surface.lines.join("").includes("LATEST_OUTPUT") ? reply : null;
    });
    this.assertTrue((await viewer.sync(null, false)).surfaces.length);
    this.assertTrue((await viewer.sync()).surfaces.length);
    this.assertEqual((await viewer.sync()).surfaces, []);
    const identity = viewer.known.identity,
      before = await this.session();
    const result = await this.rpc({
      op: "server.reload",
      executable: EXE,
    });
    this.assertNotEqual(result.server_pid, before.server_pid);
    this.assertTrue((await viewer.sync()).surfaces.length);
    this.assertNotEqual(viewer.known.identity, identity);
    this.assertIn("LATEST_OUTPUT", viewer.text());
    this.assertEqual((await this.session()).panes[0].pid, before.panes[0].pid);
  }

  async test_synchronized_output_timeout_publishes_held_changes() {
    const fixture = join(this.temp.name, "sync.ts"),
      begin = join(this.temp.name, "begin");
    writeExecutable(
      fixture,
      `#!/usr/bin/env bun
import { existsSync } from 'node:fs';
process.stdout.write('READY');
while (!existsSync('begin')) await Bun.sleep(5);
process.stdout.write('\\x1b[?2026h\\x1b[2J\\x1b[HAFTER_TIMEOUT');
await Bun.sleep(60000);
`,
    );
    const pane = await this.new(shellJoin(["bun", fixture])),
      viewer = await WireViewer.create(this, pane);
    await this.ready(viewer, "READY");
    writeFileSync(begin, "");
    await sleep(0.1);
    await viewer.sync();
    this.assertIn("READY", viewer.text());
    this.assertNotIn("AFTER_TIMEOUT", viewer.text());
    await this.ready(viewer, "AFTER_TIMEOUT");
    this.assertEqual((await viewer.sync()).surfaces, []);
  }

  async test_watch_wakes_a_viewer_only_when_something_changed() {
    const pane = await this.echoPane("watch-visible"),
      viewer = await WireViewer.create(this, pane);
    viewer.resources = false;
    await this.ready(viewer, "READY");
    const id = (await viewer.sync()).viewer;
    const watch = await JsonSocket.connect(this.path);
    this.addCleanup(() => watch.close());
    watch.socket.write(JSON.stringify(versioned({ op: "viewer.watch", viewer: id })) + "\n");
    this.assertEqual(JSON.parse(await watch.lines.next()), { ok: true });
    // No input means no output from the established foreground process.
    await this.settle();
    await this.watchWakes(watch);
    await this.settle();
    this.assertEqual(await this.watchWakes(watch), 0);
    await this.command("pane.rename", { target: pane, name: "Woken" });
    this.assertEqual(JSON.parse(await watch.lines.next()).type, "viewer.wake");
    await viewer.sync();
    this.assertEqual(viewer.session.panes.find((p: any) => p.id === pane).name, "Woken");
    await this.rpc({
      op: "action",
      name: "rename",
      value: "Queued",
      viewer: id,
    });
    this.assertEqual(JSON.parse(await watch.lines.next()).type, "viewer.wake");
  }

  async test_watch_ignores_output_the_viewer_does_not_show() {
    const pane = await this.echoPane("watch-visible"),
      viewer = await WireViewer.create(this, pane);
    viewer.resources = false;
    await this.ready(viewer, "READY");
    const id = (await viewer.sync()).viewer;
    const hidden = await this.echoPane("watch-hidden");
    const watch = await JsonSocket.connect(this.path);
    this.addCleanup(() => watch.close());
    watch.socket.write(JSON.stringify(versioned({ op: "viewer.watch", viewer: id })) + "\n");
    this.assertEqual(JSON.parse(await watch.lines.next()), { ok: true });
    await this.settle();
    await this.watchWakes(watch);
    await this.command("pane.input", { target: hidden, data: "HIDDEN_OUTPUT" });
    await this.until(async () =>
      (await this.command("pane.read", { target: hidden, view: "screen" })).text.includes("HIDDEN_OUTPUT"),
    );
    await this.settle();
    this.assertEqual(await this.watchWakes(watch), 0);
    // Hidden surfaces stay quiet, but their metadata is still visible.
    await this.command("pane.rename", { target: hidden, name: "Hidden renamed" });
    this.assertGreater(await this.watchWakes(watch), 0);
    await viewer.sync();
    this.assertEqual(viewer.session.panes.find((p: { id: number }) => p.id === hidden).name, "Hidden renamed");
    await this.command("pane.input", { target: pane, data: "VISIBLE_OUTPUT" });
    this.assertEqual(JSON.parse(await watch.lines.next()).type, "viewer.wake");
    await this.ready(viewer, "VISIBLE_OUTPUT");
  }

  async test_watch_survives_a_reload() {
    const pane = await this.echoPane("watch-visible"),
      viewer = await WireViewer.create(this, pane);
    await this.ready(viewer, "READY");
    const id = (await viewer.sync()).viewer;
    const watch = await JsonSocket.connect(this.path);
    this.addCleanup(() => watch.close());
    watch.socket.write(JSON.stringify(versioned({ op: "viewer.watch", viewer: id })) + "\n");
    this.assertEqual(JSON.parse(await watch.lines.next()), { ok: true });
    const reload = await this.rpc({ op: "server.reload", executable: EXE });
    this.assertTrue(reload.ok, JSON.stringify(reload));
    // The new daemon wakes the watcher it inherited, then keeps waking it.
    this.assertEqual(JSON.parse(await watch.lines.next()).type, "viewer.wake");
    await this.settle();
    await this.watchWakes(watch);
    await this.command("pane.rename", { target: pane, name: "After reload" });
    this.assertEqual(JSON.parse(await watch.lines.next()).type, "viewer.wake");
  }

  async test_search_updates_selection_on_an_unchanged_viewport() {
    const pane = await this.new("printf 'one NEEDLE two NEEDLE'; sleep 60");
    const viewer = await Viewer.create(this);
    this.addCleanup(() => viewer.close());
    await viewer.focus(pane);
    await this.until(async () => (await viewer.poll()).data.includes("one NEEDLE two NEEDLE"));
    const first = (await viewer.input("\x02s/NEEDLE\r")).data;
    const second = (await viewer.input("n")).data;
    this.assertNotEqual(first, second);
    const copied = (await viewer.input("y")).effects[0].write_terminal;
    const encoded = copied.split("52;c;", 2)[1].split("\x07", 1)[0];
    this.assertEqual(Buffer.from(encoded, "base64").toString(), "NEEDLE");
  }
}
registerCase("ViewerSync", ViewerSync);
