/** Opt-in live Herdr -> Corgi handoff. Uses only disposable runtime paths. */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  EXE,
  JsonSocket,
  registerCase,
  run,
  shellJoin,
  sleep,
  TestCase,
  tempDir,
} from "./support";

const cliValue = (flag: string) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const CORGI = cliValue("--corgi") ?? process.env.CORGI_TEST_BIN ?? EXE;
// The live donor is deliberately opt-in; a host-installed Herdr alone must not
// make the ordinary Bun suite start an external runtime.
const HERDR = cliValue("--herdr") ?? process.env.HERDR_TEST_BIN;

class HerdrHandoff extends TestCase {
  temp!: ReturnType<typeof tempDir>;
  root!: string;
  env!: Record<string, string>;
  corgiSocket!: string;
  herdrSocket!: string;
  donor: any;
  receiver: any;
  processes: any[] = [];
  logs: string[] = [];

  async setUp() {
    this.temp = tempDir("corgi-handoff-");
    this.root = realpathSync(this.temp.name);
    this.corgiSocket = join(this.root, "control.sock");
    this.env = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (
        value !== undefined &&
        ![
          "CORGI_",
          "HERDR_",
          "XDG_",
          "CODEX_",
          "CLAUDE_",
          "TMUX",
          "ZDOTDIR",
          "ENV",
          "BASH_ENV",
        ].some((prefix) => key.startsWith(prefix))
      )
        this.env[key] = value;
    }
    for (const name of [
      "home",
      "config",
      "state",
      "cache",
      "data",
      "run",
      "tmp",
    ])
      mkdirSync(join(this.root, name), { mode: 0o700 });
    Object.assign(this.env, {
      HOME: join(this.root, "home"),
      XDG_CONFIG_HOME: join(this.root, "config"),
      XDG_STATE_HOME: join(this.root, "state"),
      XDG_CACHE_HOME: join(this.root, "cache"),
      XDG_DATA_HOME: join(this.root, "data"),
      XDG_RUNTIME_DIR: join(this.root, "run"),
      TMPDIR: join(this.root, "tmp"),
      SHELL: "/bin/sh",
      TERM: "xterm-256color",
      CODEX_HOME: join(this.root, "home/.codex"),
      CLAUDE_CONFIG_DIR: join(this.root, "home/.claude"),
      CORGI_SOCKET: this.corgiSocket,
      CORGI_BELL: "off",
      CORGI_INFERENCE_PROVIDER: "off",
      CORGI_SUMMARY_COMMAND: "off",
    });
    for (const app of ["herdr", "herdr-dev"]) {
      const directory = join(this.root, "config", app);
      mkdirSync(directory, { mode: 0o700 });
      writeFileSync(
        join(directory, "config.toml"),
        'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\nshell_mode = "non_login"\n[update]\nversion_check = false\nmanifest_check = false\n',
      );
    }
    this.donor = this.launch([HERDR!, "server"], "herdr");
    const pong = await this.until(async () => {
      this.assertIsNone(this.donor.exitCode, "Herdr exited during startup");
      const paths = ["herdr", "herdr-dev"].map((app) =>
        join(this.root, "config", app, "herdr.sock"),
      );
      const found = paths.filter(existsSync);
      if (found.length === 1) {
        this.herdrSocket = found[0];
        return this.herdr("ping");
      }
      return null;
    }, "Herdr startup");
    this.assertTrue(
      pong.capabilities?.live_handoff,
      "This Herdr build does not advertise live_handoff",
    );
    this.receiver = this.launch([CORGI, "serve"], "corgi");
    await this.until(() => this.corgi({ op: "ping" }), "Corgi startup");
  }

  launch(argv: string[], label: string) {
    const log = join(this.root, `${label}.log`);
    this.logs.push(log);
    const proc = Bun.spawn(argv, {
      env: this.env,
      cwd: this.root,
      stdin: "ignore",
      stdout: Bun.file(log),
      stderr: Bun.file(log),
    });
    this.processes.push(proc);
    return proc;
  }
  async exchange(path: string, message: any) {
    if (!path.startsWith(this.root + "/"))
      throw new Error("socket outside handoff fixture");
    const socket = await JsonSocket.connect(path);
    try {
      const response = await socket.request(message);
      this.assertNotIn("error", response, response);
      this.assertNotIn("err", response, response);
      return response;
    } finally {
      socket.close();
    }
  }
  corgi(message: any) {
    return this.exchange(this.corgiSocket, { protocol: 1, ...message });
  }
  async herdr(method: string, params: any = {}) {
    return (
      await this.exchange(this.herdrSocket, {
        id: "migration-test",
        method,
        params,
      })
    ).result;
  }
  async command(operation: string, params: any = {}) {
    return (
      await this.corgi({
        op: "session.command",
        command: { [operation]: params },
      })
    ).result;
  }
  async until<T>(
    predicate: () => Promise<T> | T,
    description: string,
    seconds = 15,
  ): Promise<T> {
    const deadline = Date.now() + seconds * 1000;
    let last: any;
    while (Date.now() < deadline) {
      try {
        const value = await predicate();
        if (value) return value;
        last = value;
      } catch (error) {
        last = error;
      }
      await sleep(0.05);
    }
    this.fail(`Timed out waiting for ${description}: ${String(last)}`);
  }
  async sourceShell(label = "Migrated website", tab = "Development") {
    const folder = join(this.root, label.replaceAll(" ", "-"));
    mkdirSync(folder);
    const created = await this.herdr("workspace.create", {
      cwd: folder,
      label,
    });
    const pane = created.root_pane.pane_id;
    await this.herdr("tab.rename", { tab_id: created.tab.tab_id, label: tab });
    return [pane, folder] as const;
  }
  sourceInput(pane: number, text: string) {
    return this.herdr("pane.send_input", {
      pane_id: pane,
      text,
      keys: ["Enter"],
    });
  }
  async sourcePid(pane: number) {
    return (await this.herdr("pane.process_info", { pane_id: pane }))
      .process_info.shell_pid;
  }
  async viewerPgid() {
    return Number(
      (
        await run(["ps", "-o", "pgid=", "-p", String(process.pid)])
      ).stdout.trim(),
    );
  }
  async handoff(operation: number, viewerPgid?: number) {
    await this.corgi({
      op: "onboarding.handoff",
      operation,
      socket: this.herdrSocket,
      viewer_pgid: viewerPgid ?? (await this.viewerPgid()),
    });
    return this.until(
      async () => {
        const progress = (
          await this.corgi({ op: "onboarding.status", operation })
        ).progress;
        return ["complete", "failed"].includes(progress.phase)
          ? progress
          : null;
      },
      "handoff completion",
      45,
    );
  }
  async importedPane(pid: number) {
    return (await this.corgi({ op: "session.snapshot" })).panes.find(
      (p: any) => p.pid === pid,
    );
  }
  async shellReceipt(pane: number, filename: string, source = false) {
    const path = join(this.root, filename);
    const text = `printf '%s %s\\n' "$$" "$handoff_token" > ${shellJoin([path])}`;
    if (source) await this.sourceInput(pane, text);
    else await this.command("pane.input", { target: pane, data: text + "\r" });
    return this.until(
      () => (existsSync(path) ? readFileSync(path, "utf8").trim() : null),
      "shell receipt",
    );
  }

  async test_process_state_layout_and_terminal_io_survive() {
    const original = (await this.corgi({ op: "session.snapshot" }))
      .workspaces[0].id;
    const existing = (
      await this.command("pane.create", {
        workspace: original,
        cwd: this.root,
        command: "exec /bin/sh",
      })
    ).pane;
    const existingPid = (await this.corgi({ op: "session.snapshot" })).panes[0]
      .pid;
    const [first, folder] = await this.sourceShell();
    await this.sourceInput(first, "handoff_token=only-in-this-shell");
    const firstPid = await this.sourcePid(first);
    this.assertEqual(
      await this.shellReceipt(first, "before", true),
      `${firstPid} only-in-this-shell`,
    );
    await this.herdr("pane.split", {
      target_pane_id: first,
      direction: "right",
      ratio: 0.4,
      cwd: folder,
    });
    const [research] = await this.sourceShell("Migrated research", "Notes");
    const snapshot = (await this.herdr("session.snapshot")).snapshot;
    const split = snapshot.panes.find(
      (p: any) => ![first, research].includes(p.pane_id),
    ).pane_id;
    const pids = new Set(
      await Promise.all(
        snapshot.panes.map((p: any) => this.sourcePid(p.pane_id)),
      ),
    );
    const splitShellPid = await this.sourcePid(split);
    const heartbeat = join(this.root, "heartbeat");
    const worker = join(this.root, "worker.ts");
    writeFileSync(
      worker,
      `import { writeFileSync, renameSync } from 'node:fs';
let count = 0; const path = process.argv[2];
setInterval(() => { writeFileSync(path + '.tmp', process.pid + ' ' + (++count)); renameSync(path + '.tmp', path); }, 50);
for await (const chunk of Bun.stdin.stream()) { for (const line of new TextDecoder().decode(chunk).split('\\n')) if (line.trim()) console.log('WORKER_ACK:' + line.trim()); }
`,
    );
    await this.sourceInput(
      split,
      shellJoin([process.execPath, worker, heartbeat]),
    );
    const [beforePid, beforeCount] = (await this.until(
      () => (existsSync(heartbeat) ? readFileSync(heartbeat, "utf8") : null),
      "foreground workload",
    ))!
      .split(" ")
      .map(Number);
    const progress = await this.handoff(1);
    this.assertEqual(progress.phase, "complete", progress);
    this.assertEqual([progress.completed, progress.total], [3, 3]);
    this.assertEqual(await this.donor.exited, 0);
    this.assertFalse(existsSync(this.herdrSocket));
    const after = await this.corgi({ op: "session.snapshot" });
    this.assertEqual(
      new Set(after.panes.map((p: any) => p.pid)),
      new Set([...pids, existingPid]),
    );
    this.assertEqual(after.workspaces.length, 3);
    this.assertEqual(
      after.panes.find((p: any) => p.id === existing).pid,
      existingPid,
    );
    const website = after.workspaces.find(
      (w: any) => w.name === "Migrated website",
    );
    const researchWs = after.workspaces.find(
      (w: any) => w.name === "Migrated research",
    );
    this.assertEqual(
      website.model.tabs.map((t: any) => t.title),
      ["Development"],
    );
    this.assertEqual(
      researchWs.model.tabs.map((t: any) => t.title),
      ["Notes"],
    );
    const branch = website.model.nodes[website.model.tabs[0].root].split;
    this.assertEqual(branch.axis, "horizontal");
    this.assertTrue(Math.abs(branch.ratio - 400) <= 1);
    const imported = await this.importedPane(firstPid);
    this.assertEqual(imported.cwd, folder);
    this.assertEqual(
      await this.shellReceipt(imported.id, "after"),
      `${firstPid} only-in-this-shell`,
    );
    await this.until(
      () =>
        existsSync(heartbeat) &&
        Number(readFileSync(heartbeat, "utf8").split(" ")[1]) > beforeCount + 3,
      "continued foreground work",
    );
    this.assertEqual(
      Number(readFileSync(heartbeat, "utf8").split(" ")[0]),
      beforePid,
    );
    const target = (await this.importedPane(splitShellPid)).id;
    await this.command("pane.input", { target, data: "after-migration\r" });
    await this.until(
      async () =>
        (
          await this.command("pane.read", { target, view: "screen" })
        ).text.includes("WORKER_ACK:after-migration"),
      "transferred terminal output",
    );
    await this.corgi({
      op: "onboarding.handoff",
      operation: 1,
      socket: this.herdrSocket,
      viewer_pgid: await this.viewerPgid(),
    });
    this.assertEqual(
      (await this.corgi({ op: "session.snapshot" })).panes.length,
      4,
    );
  }

  async test_rejected_handoff_rolls_back_and_can_retry() {
    await this.corgi({
      op: "viewer.open",
      viewer_protocol: 3,
      onboarding: true,
      cwd: this.root,
    });
    this.assertEqual((await this.corgi({ op: "session.snapshot" })).panes, []);
    const [pane] = await this.sourceShell();
    await this.sourceInput(pane, "handoff_token=rollback-survived");
    const pid = await this.sourcePid(pane);
    this.assertEqual(
      await this.shellReceipt(pane, "ready", true),
      `${pid} rollback-survived`,
    );
    const processInfo = (
      await this.herdr("pane.process_info", { pane_id: pane })
    ).process_info;
    const before = await this.corgi({ op: "session.snapshot" });
    let progress = await this.handoff(
      1,
      processInfo.foreground_process_group_id,
    );
    this.assertEqual(progress.phase, "failed", progress);
    this.assertEqual(progress.message, "CannotHandoffCurrentConsole");
    await this.until(() => this.herdr("session.snapshot"), "Herdr rollback");
    this.assertIsNone(this.donor.exitCode);
    this.assertEqual(await this.sourcePid(pane), pid);
    this.assertEqual(
      await this.shellReceipt(pane, "rollback", true),
      `${pid} rollback-survived`,
    );
    const after = await this.corgi({ op: "session.snapshot" });
    this.assertEqual(after.workspaces, before.workspaces);
    this.assertEqual(after.panes, before.panes);
    progress = await this.handoff(2);
    this.assertEqual(progress.phase, "complete", progress);
    const imported = await this.corgi({ op: "session.snapshot" });
    this.assertEqual(
      imported.workspaces.map((w: any) => w.name),
      ["Migrated website"],
    );
    this.assertEqual(
      await this.shellReceipt((await this.importedPane(pid)).id, "retry"),
      `${pid} rollback-survived`,
    );
  }

  async tearDown() {
    for (const proc of this.processes) {
      if (proc.exitCode !== null) continue;
      if (proc === this.receiver) {
        try {
          await this.corgi({ op: "shutdown" });
        } catch {}
      } else proc.kill();
      const result = await Promise.race([
        proc.exited,
        sleep(5).then(() => null),
      ]);
      if (result === null) {
        proc.kill("SIGKILL");
        await proc.exited;
      }
    }
    this.temp?.cleanup();
  }
}

registerCase("Herdr live handoff", HerdrHandoff, {
  skip:
    !HERDR || !Bun.file(CORGI).size
      ? "Herdr and Corgi executables are required"
      : undefined,
  timeout: 120_000,
});
