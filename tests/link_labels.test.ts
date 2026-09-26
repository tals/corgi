/** Terminal evidence to native inference to named workspace link and click. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Runtime, EXE, screen_text } from "./runtime";
import { Viewer } from "./viewer_client";
import { registerCase, shellJoin, sleep, tempDir } from "./support";
import { inferenceProgram, lines } from "./activity_summary";

class LinkLabels extends Runtime {
  inference_temp!: ReturnType<typeof tempDir>;
  log!: string;
  control!: string;
  fixture_pid = 0;
  async configure() {
    Object.assign(this.env, {
      CORGI_INFERENCE_PROVIDER: "codex",
      CORGI_INFERENCE_BIN: inferenceProgram,
      CORGI_INFERENCE_TEST_LOG: this.log,
      CORGI_INFERENCE_TEST_CONTROL: this.control,
    });
  }
  async setUp() {
    this.inference_temp = tempDir("corgi-link-label-");
    this.log = join(this.inference_temp.name, "requests.jsonl");
    this.control = join(this.inference_temp.name, "control.json");
    writeFileSync(this.control, JSON.stringify({ label: "Finance", delay: 1 }));
    await super.setUp();
    for (const key of ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"])
      delete this.env[key];
  }
  async tearDown() {
    if (this.fixture_pid)
      try {
        process.kill(this.fixture_pid, "SIGTERM");
      } catch {}
    try {
      await super.tearDown();
    } finally {
      this.inference_temp?.cleanup();
    }
  }
  async new(command: string) {
    const ws = (await this.session()).workspaces[0].id;
    return (
      await this.command("pane.create", {
        workspace: ws,
        cwd: this.temp.name,
        command,
      })
    ).pane;
  }
  async start_server() {
    const script = join(this.temp.name, "finance.ts"),
      ready = join(this.temp.name, "ready.json");
    writeFileSync(
      script,
      `import { createServer } from 'node:http';\nimport { writeFileSync } from 'node:fs';\nconst s=createServer((req,res)=>{res.statusCode=200;res.end();});\ns.listen(0,'127.0.0.1',()=>{const port=s.address().port;console.log('Finance personal dashboard ready at http://localhost:'+port);writeFileSync(process.argv[2],JSON.stringify({port,pid:process.pid}));});\n`,
    );
    const pane = await this.new(
      "exec " + shellJoin([process.execPath, script, ready]),
    );
    await this.until(() => existsSync(ready));
    const info = JSON.parse(readFileSync(ready, "utf8"));
    this.fixture_pid = info.pid;
    return { pane, info };
  }
  async endpoints() {
    return (await this.session()).ports.workspaces.flatMap(
      (w: any) => w.endpoints,
    );
  }
  async test_names_link_from_owning_terminal_and_preserves_destination() {
    const { pane, info } = await this.start_server();
    await this.until(
      async () =>
        (await this.endpoints()).some((e: any) => e.label === "Finance"),
      25,
    );
    const payload = JSON.parse(lines(this.log)[0]);
    this.assertIn("Finance personal dashboard", payload.terminal);
    this.assertEqual(payload.pid, info.pid);
    this.assertEqual(payload.url, `http://localhost:${info.port}`);
    const viewer = await Viewer.create(this);
    this.assertIn("Open Finance ↗", (await viewer.poll()).data);
    this.assertIn(
      "\x1b]22;pointer\x1b\\",
      (await viewer.input("\x1b[<35;14;3M")).data,
    );
    const state = await viewer.input("\x1b[<0;14;3M\x1b[<0;14;3m");
    this.assertEqual(state.effects, [{ open_url: payload.url }]);
    await sleep(1);
    this.assertEqual(lines(this.log).length, 1);
    this.assertEqual((await this.rpc({ op: "native.list" })).sessions, []);
    await this.command("pane.close", { target: pane });
    await this.until(async () => (await this.endpoints()).length === 0, 15);
    this.assertNotIn("Open Finance", (await viewer.poll()).data);
  }
  async test_pending_dots_glimmer_then_resolve_without_changing_the_url() {
    writeFileSync(this.control, JSON.stringify({ label: "Finance", delay: 4 }));
    const { info } = await this.start_server();
    await this.until(
      async () => (await this.endpoints()).some((e: any) => e.label_pending),
      25,
    );
    const viewer = await Viewer.create(this);
    const first = (await viewer.poll()).data;
    this.assertIn("Open ... ↗", screen_text(first, 100, 30)[2]);
    const colors = (frame: string) =>
      [...frame.matchAll(/\x1b\[38;2;(\d+;\d+;\d+)m\./g)].map((m) => m[1]);
    this.assertEqual(colors(first).length, 3);
    await this.until(
      async () =>
        JSON.stringify(colors((await viewer.poll()).data)) !==
        JSON.stringify(colors(first)),
      2,
    );
    this.assertIn("Open ... ↗", screen_text(viewer.state.data, 100, 30)[2]);
    const clicked = await viewer.input("\x1b[<0;14;3M\x1b[<0;14;3m");
    this.assertEqual(clicked.effects, [
      { open_url: `http://localhost:${info.port}` },
    ]);
    await this.until(
      async () =>
        (await this.endpoints()).some(
          (e: any) => e.label === "Finance" && !e.label_pending,
        ),
      10,
    );
    const final = (await viewer.poll()).data;
    this.assertIn("Open Finance ↗", final);
    this.assertEqual(colors(final), []);
  }
  async test_inflight_result_and_cached_name_survive_reload_without_rebilling() {
    writeFileSync(
      this.control,
      JSON.stringify({ label: "Finance", delay: 2.5 }),
    );
    await this.start_server();
    await this.until(() => existsSync(this.log), 25);
    this.assertTrue((await this.endpoints()).some((e: any) => e.label_pending));
    await this.rpc({ op: "server.reload", protocol: 1, executable: EXE });
    await this.until(
      async () =>
        (await this.endpoints()).some(
          (e: any) => e.label === "Finance" && !e.label_pending,
        ),
      25,
    );
    this.assertEqual(
      lines(this.log).length,
      1,
      "completed in-flight link inference was billed again",
    );
    await this.rpc({ op: "server.reload", protocol: 1, executable: EXE });
    await this.until(
      async () =>
        (await this.endpoints()).some((e: any) => e.label === "Finance"),
      25,
    );
    await sleep(1);
    this.assertEqual(
      lines(this.log).length,
      1,
      "cached link name was inferred again after reload",
    );
  }
  async test_invalid_guess_keeps_fallback_and_does_not_loop() {
    writeFileSync(
      this.control,
      JSON.stringify({ label: "Bad\x1b[2J", delay: 0 }),
    );
    await this.start_server();
    await this.until(() => existsSync(this.log), 25);
    await sleep(0.8);
    this.assertTrue((await this.endpoints()).every((e: any) => !e.label));
    this.assertTrue(
      (await this.endpoints()).every((e: any) => !e.label_pending),
    );
    const viewer = await Viewer.create(this);
    this.assertIn("Open Link ↗", (await viewer.poll()).data);
    await sleep(1);
    this.assertEqual(lines(this.log).length, 1);
  }
  async test_late_guess_for_removed_endpoint_is_discarded() {
    writeFileSync(
      this.control,
      JSON.stringify({ label: "Stale App", delay: 2 }),
    );
    const { pane } = await this.start_server();
    await this.until(() => existsSync(this.log), 25);
    await this.command("pane.close", { target: pane });
    await this.until(async () => (await this.endpoints()).length === 0, 15);
    await sleep(2.2);
    const viewer = await Viewer.create(this);
    this.assertNotIn("Open Stale App", (await viewer.poll()).data);
  }
}
registerCase("LinkLabels", LinkLabels, { inherited: false });
