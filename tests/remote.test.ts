import * as fs from "node:fs";
import { userInfo } from "node:os";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import * as runtime from "./runtime";
import { registerCase, run, quote, writeExecutable, deadline } from "./support";
import { Terminal } from "../src/pane/terminal";
import { TcpFault } from "./tcp_fault";
import { Connection } from "../src/rpc";
import * as cli from "../src/cli";
import type { Surface } from "../src/pane/surface";

const b64 = (value: string | Buffer) => Buffer.from(value).toString("base64");
const clipboardPacket = (status: string, rest: string) => `\x1b]5522;type=read:status=${status}${rest}\x1b\\`;

/** Real OpenSSH, a temporary host key and known_hosts, and two isolated daemons. */
class Remote extends runtime.Runtime {
  remote: runtime.Runtime | null = null;
  sshd: ReturnType<typeof Bun.spawn> | null = null;
  sshlog: Promise<string> = Promise.resolve("");
  sshconfig = "";
  hostkey = "";
  emulator: Terminal | null = null;
  terminal: Bun.Terminal | null = null;
  ui: ReturnType<typeof Bun.spawn> | null = null;
  network: TcpFault | null = null;
  async setUp() {
    await super.setUp();
    this.remote = new runtime.Runtime();
    await this.remote.setUp();
    const dir = this.temp.name;
    for (const name of ["host", "client"])
      await run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", join(dir, name)]);
    const reserve = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = reserve.port;
    reserve.stop(true);
    const sshd_config = join(dir, "sshd_config");
    fs.writeFileSync(
      sshd_config,
      `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${dir}/host\nPidFile ${dir}/sshd.pid\nAuthorizedKeysFile ${dir}/client.pub\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nStrictModes no\nAllowUsers ${userInfo().username}\nLogLevel ERROR\n`,
    );
    this.sshd = Bun.spawn([Bun.which("sshd")!, "-D", "-e", "-f", sshd_config], {
      env: this.env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    this.sshlog = new Response(this.sshd.stderr).text();
    await this.until(async () => {
      if (this.sshd!.exitCode !== null) throw Error(await this.sshlog);
      return new Promise<boolean>(resolve => {
        const socket = createConnection({ host: "127.0.0.1", port: port! });
        socket.once("error", () => resolve(false));
        socket.once("connect", () => {
          socket.destroy();
          resolve(true);
        });
      });
    });
    this.network = new TcpFault(port!);
    await this.network.start();
    this.hostkey = `[127.0.0.1]:${this.network.port} ${fs.readFileSync(join(dir, "host.pub"), "utf8")}`;
    fs.writeFileSync(join(dir, "known_hosts"), this.hostkey);
    this.sshconfig = join(dir, "ssh_config");
    fs.writeFileSync(
      this.sshconfig,
      `Host corgi-test-host\n HostName 127.0.0.1\n Port ${this.network.port}\n User ${userInfo().username}\n IdentityFile ${dir}/client\n IdentitiesOnly yes\n UserKnownHostsFile ${dir}/known_hosts\n`,
    );
    const ssh = Bun.which("ssh")!;
    writeExecutable(join(dir, "bin/ssh"), `#!/bin/sh\nexec ${quote(ssh)} -F ${quote(this.sshconfig)} "$@"\n`);
    this.env.PATH = join(dir, "bin") + ":" + this.env.PATH;
    const remote_exe = writeExecutable(
      join(dir, "remote-corgi"),
      `#!/bin/sh\nexport CORGI_SOCKET=${quote(this.remote.path)}\nexport HOME=${quote(this.remote.temp.name)}\nexport CORGI_APP_EXE=${quote(runtime.EXE)}\nexec ${quote(runtime.EXE)} "$@"\n`,
    );
    await this.cli(["machine", "add", "work", "corgi-test-host", "--executable", remote_exe]);
    await this.command("workspace.edit", { target: 1, name: "LOCAL_WORKSPACE" });
    await this.remote.command("workspace.edit", { target: 1, name: "REMOTE_WORKSPACE" });
  }
  async test_cold_remote_listing_allows_ssh_authentication_on_a_slow_link() {
    // A new state directory gives this CLI its own SSH master namespace.
    const state = join(this.temp.name, "cold-state"),
      connections = this.network!.accepted;
    fs.cpSync(this.env.XDG_STATE_HOME!, state, { recursive: true });
    this.network!.latency_ms = 800;
    const result = await run([runtime.EXE, "list", "--all-machines"], {
      env: { ...this.env, XDG_STATE_HOME: state },
      timeout: 40000,
    });
    this.assertEqual(this.network!.accepted, connections + 1);
    const remote = JSON.parse(result.stdout).machines.find(
      (machine: { machine: string }) => machine.machine === "work",
    );
    this.assertTrue(remote.ok);
    this.assertTrue(
      remote.result.workspaces.some((workspace: { name: string }) => workspace.name === "REMOTE_WORKSPACE"),
    );
  }
  async test_one_second_one_way_latency_stays_online_and_delivers_typing() {
    await this.command("pane.create", { workspace: 1, command: "cat" });
    await this.remote!.command("pane.create", { workspace: 1, command: "cat" });
    this.network!.cut();
    this.network!.latency_ms = 1000;
    await this.startViewer();
    await this.online(undefined, 60);
    const accepted = this.network!.accepted;
    for (const marker of ["SLOW_ONE", "SLOW_TWO", "SLOW_THREE"]) {
      this.terminal!.write(marker + "\r");
      await this.until(() => {
        this.assertNotIn("Ctrl+R retry", this.text());
        return this.text().includes(marker);
      }, 15);
      await this.remote!.until(
        async () => (await this.remote!.command("pane.read", { target: 1 })).text.includes(marker),
        15,
      );
    }
    this.assertEqual(this.network!.accepted, accepted);
    await this.until(
      () =>
        this.text()
          .split("\n")
          .some(row => row.includes("▾  work") && row.includes("▂▄▆█")),
      10,
    );
  }
  async test_raising_latency_then_reconnecting_keeps_local_navigation_responsive() {
    await this.command("pane.create", { workspace: 1, command: "cat" });
    await this.remote!.command("pane.create", { workspace: 1, command: "cat" });
    await this.startViewer();
    await this.online();
    await this.sendRemote("FAST_BEFORE_LATENCY");
    const accepted = this.network!.accepted;
    this.network!.latency_ms = 1000;
    for (const marker of ["SLOW_TRANSITION_ONE", "SLOW_TRANSITION_TWO", "SLOW_TRANSITION_THREE"]) {
      this.terminal!.write(marker + "\r");
      await this.until(() => {
        this.assertNotIn("Ctrl+R retry", this.text());
        return this.text().includes(marker);
      }, 15);
    }
    this.assertEqual(this.network!.accepted, accepted);
    this.network!.cut();
    this.clickWorkspace("LOCAL");
    await this.online("local", 1);
    this.clickWorkspace("REMOTE");
    await this.until(() => this.network!.accepted > accepted, 3);
    await this.online(undefined, 60);
    await this.sendRemote("SLOW_AFTER_RECONNECT");
  }
  async test_workspaces_reorder_across_machines_while_remote_is_stalled() {
    await this.command("workspace.create", { name: "SECOND_LOCAL", cwd: this.temp.name });
    await this.remote!.command("pane.create", { workspace: 1, command: "cat" });
    await this.startViewer("work", 100, 50);
    await this.online();
    await this.until(() => this.text().includes("SECOND_LOCAL"));
    this.network!.set("blackhole");
    await this.until(() => this.text().includes("Connection stalled"), 6);
    const rows = () => this.text().split("\n");
    const from = rows().findIndex(row => row.includes("REMOTE_WORKSPACE")) + 1;
    const to = rows().findIndex(row => row.includes("SECOND_LOCAL")) + 1;
    this.terminal!.write(`\x1b[<0;5;${from}M\x1b[<32;5;${to}M\x1b`);
    await this.until(() => rows().findIndex(row => row.includes("REMOTE_WORKSPACE")) === from - 1, 1);
    this.terminal!.write(`\x1b[<0;5;${to}m`);
    this.terminal!.write(`\x1b[<0;5;${from}M\x1b[<32;5;${to}M\x1b[<0;5;${to}m`);
    const ordered = () => {
      const text = this.text();
      return (
        text.indexOf("LOCAL_WORKSPACE") < text.indexOf("REMOTE_WORKSPACE") &&
        text.indexOf("REMOTE_WORKSPACE") < text.indexOf("SECOND_LOCAL")
      );
    };
    await this.until(ordered, 1);
    this.assertEqual(rows().filter(row => row.includes("▾  local")).length, 2);
    this.assertEqual(rows().filter(row => row.includes("▾  work")).length, 1);
    this.clickWorkspace("LOCAL");
    await this.online("local", 1);
    this.network!.set("healthy");
    this.clickWorkspace("REMOTE");
    await this.online();
    this.assertTrue(ordered());
    await this.sendRemote("REORDERED_REMOTE");
    const instance = (await this.remote!.rpc({ op: "hello", protocol: 1 })).instance;
    await this.remote!.run_cli("shutdown");
    await this.remote!.until(() => !fs.existsSync(this.remote!.path));
    await this.remote!.run_cli("start");
    this.assertNotEqual((await this.remote!.rpc({ op: "hello", protocol: 1 })).instance, instance);
    await this.remote!.command("workspace.edit", { target: 1, name: "REMOTE_RESTARTED" });
    await this.until(() => this.text().includes("REMOTE_RESTARTED") && !this.text().includes("Ctrl+R retry"), 12);
    this.assertTrue(this.text().indexOf("LOCAL_WORKSPACE") < this.text().indexOf("REMOTE_RESTARTED"));
    this.assertTrue(this.text().indexOf("REMOTE_RESTARTED") < this.text().indexOf("SECOND_LOCAL"));
  }
  async test_setup_installs_the_canonical_binary_over_real_ssh_and_preserves_shells() {
    await this.remote!.command("pane.create", { workspace: 1, command: "cat" });
    const before = await this.remote!.rpc({ op: "session.snapshot" });
    this.assertTrue(before.panes.length > 0);
    await this.cli(["machine", "remove", "work"]);
    const ssh = Bun.which("ssh")!;
    const prefix = `echo 'Welcome to this host'; export HOME=${quote(this.remote!.temp.name)}; export CORGI_SOCKET=${quote(this.remote!.path)}; `;
    writeExecutable(
      join(this.temp.name, "bin/ssh"),
      `#!${process.execPath}\nconst args = process.argv.slice(2); args[args.length - 1] = ${JSON.stringify(prefix)} + args.at(-1); const p = Bun.spawn([${JSON.stringify(ssh)}, "-F", ${JSON.stringify(this.sshconfig)}, ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit" }); process.exit(await p.exited);\n`,
    );
    const destination = join(this.remote!.temp.name, ".local/bin/corgi");
    await this.cli(["machine", "add", "work", "corgi-test-host", "--executable", destination]);
    this.assertEqual(
      createHash("sha256").update(fs.readFileSync(destination)).digest("hex"),
      createHash("sha256").update(fs.readFileSync(runtime.EXE)).digest("hex"),
    );
    const after = await this.remote!.rpc({ op: "session.snapshot" });
    this.assertEqual(
      after.panes.map((p: { pid: number }) => p.pid).join(","),
      before.panes.map((p: { pid: number }) => p.pid).join(","),
    );
    const listed = await this.cli(["machine", "list"]);
    this.assertEqual(
      listed.machines.find((p: { name: string }) => p.name === "work").executable,
      fs.realpathSync(destination),
    );
    // The shells survived a handoff to the installed binary, not the absence of one.
    this.assertEqual((await this.remote!.rpc({ op: "hello", protocol: 1 })).executable, fs.realpathSync(destination));
  }
  async developmentBinary(name: string, delta = true, source = name) {
    const info = JSON.parse((await run([runtime.EXE, "__remote-info"], { env: this.env })).stdout);
    const native = dirname(dirname(info.bridge));
    const file = join(this.temp.name, name);
    const config = fs
      .readFileSync(join(runtime.ROOT, "src/build_config.ts"), "utf8")
      .replace('"bun-port"', JSON.stringify("a".repeat(40) + "-dirty"))
      .replace(
        'export const sourceHash = ""',
        `export const sourceHash = "${createHash("sha256").update(source).digest("hex")}"`,
      );
    const result = await Bun.build({
      entrypoints: ["src/main.ts", "src/providers/codex/files_worker.ts", "src/trackers/resources_worker.ts"].map(p =>
        join(runtime.ROOT, p),
      ),
      target: "bun",
      compile: { outfile: file },
      plugins: [
        {
          name: "dev-deployment-fixture",
          setup(build) {
            // These real compiled variants share the test binary's already extracted native code.
            build.onLoad({ filter: /\/native_paths\.ts$/ }, () => ({
              contents: `export const nativeRoot = ${JSON.stringify(native)};`,
              loader: "ts",
            }));
            build.onLoad({ filter: /\/build_config\.ts$/ }, () => ({ contents: config, loader: "ts" }));
            if (!delta)
              build.onLoad({ filter: /\/machine_build\.ts$/ }, () => ({
                contents: fs
                  .readFileSync(join(runtime.ROOT, "src/machine_build.ts"), "utf8")
                  .replace('delta_transfer: "rsync-zstd-v1",', 'delta_transfer: "",'),
                loader: "ts",
              }));
          },
        },
      ],
    });
    this.assertTrue(result.success, result.logs);
    return file;
  }
  async test_dev_deploy_negotiates_delta_and_full_upload_and_preserves_live_shells() {
    await this.test_setup_installs_the_canonical_binary_over_real_ssh_and_preserves_shells();
    const destination = join(this.remote!.temp.name, ".local/bin/corgi");
    const before = await this.remote!.rpc({ op: "session.snapshot" });
    const a = await this.developmentBinary("dev-a", false),
      b = await this.developmentBinary("dev-b");
    fs.writeFileSync(join(this.temp.name, "build.ts"), "// Same-platform fixture: no cross build needed.\n");
    const env = { ...this.env, CORGI_DEV_ROOT: this.temp.name, CORGI_DEV_BUN: process.execPath };
    const deploy = (file: string) => run([file, "machine", "deploy", "work"], { env, timeout: 60000 });
    const viewer = JSON.parse((await run([a, "__update-info"], { env })).stdout);
    const expectedRevision = JSON.stringify([viewer.version, viewer.commit, viewer.source_hash]);
    for (const args of [
      ["__machine-sync", "work", "corgi-test-host", this.remote!.path, expectedRevision],
      ["__machine-install", destination, "", "", expectedRevision],
    ]) {
      const stale = await run([b, ...args], { env, check: false });
      this.assertNotEqual(stale.code, 0);
      this.assertIn("Development build changed", stale.stderr);
    }
    // The explicit host-key check opens one fresh connection. Both upload paths reuse the control master.
    const connections = this.network!.accepted;
    const wrapper = join(this.temp.name, "bin/ssh");
    const commands = join(this.temp.name, "setup-commands");
    const original = fs
      .readFileSync(wrapper, "utf8")
      .replace(
        "const p = Bun.spawn(",
        `(await import("node:fs")).appendFileSync(${JSON.stringify(commands)}, JSON.stringify(args.at(-1)) + "\\n"); const p = Bun.spawn(`,
      );
    fs.writeFileSync(wrapper, original);
    const expectCommands = (updated: boolean) => {
      const lines = fs
        .readFileSync(commands, "utf8")
        .trimEnd()
        .split("\n")
        .map(line => JSON.parse(line));
      this.assertEqual(lines.length, updated ? 2 : 1);
      this.assertIn("corgi-setup-v1", lines[0]);
      if (updated) this.assertIn("__machine-install-session", lines[1]);
      this.assertFalse(fs.readdirSync(this.remote!.temp.name).some(name => name.startsWith(".corgi-setup.")));
      fs.writeFileSync(commands, "");
    };
    const first = await deploy(a);
    expectCommands(true);
    this.assertEqual(this.network!.accepted, connections + 1);
    this.assertIn("Preparing delta", first.stderr);
    this.assertRegex(first.stderr, /Uploading 100% [\d.]+ [KM]?i?B\/s/);
    // A second local build replaces the path after setup hashes it, before the full upload starts.
    const sending = join(this.temp.name, "full-upload");
    const replacement = sending + ".next";
    fs.copyFileSync(b, sending);
    fs.copyFileSync(a, replacement);
    fs.writeFileSync(
      wrapper,
      original.replace(
        "const p = Bun.spawn(",
        `if (args.at(-1).includes("mktemp -d")) (await import("node:fs")).renameSync(${JSON.stringify(replacement)}, ${JSON.stringify(sending)}); const p = Bun.spawn(`,
      ),
    );
    const full = await deploy(sending);
    expectCommands(true);
    fs.writeFileSync(wrapper, original);
    this.assertTrue(fs.readFileSync(sending).equals(fs.readFileSync(a)));
    this.assertTrue(fs.readFileSync(destination).equals(fs.readFileSync(b)));
    this.assertEqual(this.network!.accepted, connections + 2);
    this.assertRegex(full.stderr, /Uploading 100% [\d.]+ [KM]?i?B\/s/);
    this.assertNotIn("Preparing delta", full.stderr);
    const delta = await deploy(a);
    for (const stage of ["Preparing delta", "Uploading 100%", "Uploaded", "Installing…", "Verifying…"])
      this.assertIn(stage, delta.stderr);
    expectCommands(true);
    this.assertEqual(JSON.parse(delta.stdout).ok, true);
    const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    this.assertEqual(hash(destination), hash(a));
    this.assertIn("builds match", (await deploy(a)).stderr);
    expectCommands(false);
    // A failed staged checksum must leave the last verified executable and its daemon intact.
    fs.writeFileSync(
      wrapper,
      original.replace(
        "const p = Bun.spawn(",
        'args[args.length - 1] = args.at(-1).replace("checksum() {", "checksum() { echo invalid; return; "); const p = Bun.spawn(',
      ),
    );
    const failed = await run([b, "machine", "deploy", "work"], { env, check: false, timeout: 60000 });
    fs.writeFileSync(wrapper, original);
    this.assertNotEqual(failed.code, 0);
    expectCommands(true);
    this.assertEqual(hash(destination), hash(a));
    this.assertEqual((await this.remote!.rpc({ op: "hello", protocol: 1 })).build_id, hash(a));
    const after = await this.remote!.rpc({ op: "session.snapshot" });
    this.assertEqual(
      after.panes.map((p: { pid: number }) => p.pid),
      before.panes.map((p: { pid: number }) => p.pid),
    );
    this.assertNotEqual(after.server_pid, before.server_pid);
    // Another writer changes the installation after the receipt was recorded.
    fs.copyFileSync(runtime.EXE, destination + ".other");
    fs.renameSync(destination + ".other", destination);
    const status = await run([b, "machine", "status", "work"], { env });
    this.assertEqual(JSON.parse(status.stdout).status, "reachable");
    this.assertNotIn("Checking…", status.stderr);
    const inventory = await run([b, "list", "--all-machines"], { env });
    this.assertTrue(JSON.parse(inventory.stdout).machines.some((m: { machine: string }) => m.machine === "work"));
    this.assertNotIn("Checking…", inventory.stderr);
    this.assertEqual(hash(destination), hash(runtime.EXE));
    const next = JSON.parse((await run([b, "__update-info"], { env })).stdout);
    const revision = JSON.stringify([next.version, next.commit, next.source_hash]);
    const sync = () =>
      run([b, "__machine-sync", "work", "corgi-test-host", this.remote!.path, revision], {
        env: { ...env, CORGI_MACHINE_SYNC: "1" },
        timeout: 60000,
      });
    fs.writeFileSync(commands, "");
    await sync();
    expectCommands(true);
    this.assertEqual(hash(destination), hash(b));
    await sync();
    expectCommands(false);
  }
  async test_dev_reconnect_uses_its_authenticated_master_for_the_whole_update() {
    await this.test_setup_installs_the_canonical_binary_over_real_ssh_and_preserves_shells();
    const file = await this.developmentBinary("reconnect");
    fs.writeFileSync(join(this.temp.name, "build.ts"), "// Same-platform fixture.\n");
    const state = join(this.temp.name, "reconnect-state");
    fs.cpSync(this.env.XDG_STATE_HOME!, state, { recursive: true });
    // Only the foreground login can authenticate. Batch SSH must use its open master.
    const ssh = join(this.temp.name, "bin/ssh");
    fs.writeFileSync(
      ssh,
      fs
        .readFileSync(ssh, "utf8")
        .replace(
          "const args = process.argv.slice(2);",
          'const args = process.argv.slice(2); if (args.includes("BatchMode=yes")) args.unshift("-o", "PubkeyAuthentication=no");',
        ),
    );
    const before = this.network!.accepted;
    const env = { ...this.env, XDG_STATE_HOME: state, CORGI_DEV_ROOT: this.temp.name, CORGI_DEV_BUN: process.execPath };
    const result = await run([file, "machine", "reconnect", "work"], { env, timeout: 60000 });
    this.assertEqual(JSON.parse(result.stdout).status, "reachable");
    this.assertIn("Welcome to this host", result.stderr);
    this.assertIn("Preparing delta", result.stderr);
    const command = [file, "--machine", "work", "ping"];
    await run(command, { env, timeout: 60000 });
    this.assertEqual(this.network!.accepted, before + 1);
    const cold = join(this.temp.name, "command-state");
    fs.cpSync(state, cold, { recursive: true });
    await run(command, { env: { ...env, XDG_STATE_HOME: cold }, timeout: 60000 });
    this.assertEqual(this.network!.accepted, before + 2);
  }
  async test_dev_connections_repair_stale_receipts_and_replace_another_checkouts_binary() {
    await this.test_setup_installs_the_canonical_binary_over_real_ssh_and_preserves_shells();
    const root = this.temp.name;
    fs.writeFileSync(join(root, "build.ts"), "// Same-platform fixture.\n");
    const env = { ...this.env, CORGI_DEV_ROOT: root, CORGI_DEV_BUN: process.execPath };
    const local = await this.developmentBinary("receipt");
    const foreign = await this.developmentBinary("foreign", false, "receipt");
    const command = (args: string[]) => run([local, ...args], { env, timeout: 60000 });
    const ping = ["--machine", "work", "ping"];
    await command(ping);
    const info = JSON.parse((await command(["__update-info"])).stdout);
    const old = createHash("sha256").update(fs.readFileSync(runtime.EXE)).digest("hex");
    const receipts = join(root, "dist/dev-deploy");
    const receipt = join(
      receipts,
      fs.readdirSync(receipts).find(f => /^[a-f0-9]{64}\.json$/.test(f))!,
    );
    const recorded = () => JSON.parse(fs.readFileSync(receipt, "utf8"));
    const pid = (await this.remote!.rpc({ op: "hello", protocol: 1 })).server_pid;
    fs.writeFileSync(receipt, JSON.stringify({ ...recorded(), hash: old }));
    const repaired = await command(ping);
    this.assertNotIn("Uploading", repaired.stderr);
    this.assertEqual(recorded().hash, info.build_id);
    this.assertEqual((await this.remote!.rpc({ op: "hello", protocol: 1 })).server_pid, pid);
    // A helper with the same source can finish work started under a different Git label.
    await command([
      "__machine-sync",
      "work",
      "corgi-test-host",
      this.remote!.path,
      JSON.stringify([info.version, "other-commit", info.source_hash]),
    ]);
    const destination = join(this.remote!.temp.name, ".local/bin/corgi");
    // A second checkout has the same source label and a different compiled binary.
    const otherCheckout = join(root, "other-checkout");
    fs.mkdirSync(otherCheckout);
    fs.copyFileSync(join(root, "build.ts"), join(otherCheckout, "build.ts"));
    await run([foreign, ...ping], { env: { ...env, CORGI_DEV_ROOT: otherCheckout }, timeout: 60000 });
    this.assertTrue(fs.readFileSync(destination).equals(fs.readFileSync(foreign)));
    const replaced = await command(ping);
    this.assertIn("Uploading", replaced.stderr);
    this.assertTrue(fs.readFileSync(destination).equals(fs.readFileSync(local)));
    this.assertEqual((await this.remote!.rpc({ op: "hello", protocol: 1 })).build_id, info.build_id);
    this.assertEqual(recorded().hash, info.build_id);
    // A different local binary in the same checkout also invalidates a verified match.
    await run([foreign, ...ping], { env, timeout: 60000 });
    this.assertTrue(fs.readFileSync(destination).equals(fs.readFileSync(foreign)));
    // Re-adding explicitly chooses this checkout and records the new install before attaching.
    await command(["machine", "remove", "work"]);
    fs.writeFileSync(receipt, "incomplete receipt");
    await command(["machine", "add", "work", "corgi-test-host", "--executable", destination]);
    this.assertEqual(recorded().hash, info.build_id);
  }
  async test_dev_connections_activate_the_installed_build_when_a_different_daemon_owns_the_socket() {
    await this.test_setup_installs_the_canonical_binary_over_real_ssh_and_preserves_shells();
    const local = await this.developmentBinary("installed");
    fs.writeFileSync(join(this.temp.name, "build.ts"), "// Same-platform fixture.\n");
    Object.assign(this.env, { CORGI_DEV_ROOT: this.temp.name, CORGI_DEV_BUN: process.execPath });
    const destination = join(this.remote!.temp.name, ".local/bin/corgi");
    const hello = () => this.remote!.rpc({ op: "hello", protocol: 1 });
    const panes = async () =>
      (await this.remote!.rpc({ op: "session.snapshot" })).panes.map((p: { pid: number }) => p.pid);
    const command = () => run([local, "--machine", "work", "ping"], { env: this.env, timeout: 60000 });
    await command();
    const expected = (await hello()).build_id;
    const shells = await panes();
    const stamp = fs.statSync(destination, { bigint: true }).ctimeNs;
    await this.remote!.rpc({ op: "server.reload", executable: runtime.EXE });
    this.assertNotEqual((await hello()).build_id, expected);
    const result = await command();
    this.assertNotIn("Uploading", result.stderr);
    this.assertEqual((await hello()).build_id, expected);
    await this.remote!.rpc({ op: "server.reload", executable: runtime.EXE });
    await this.startViewer("work", 110, 36, undefined, local);
    await this.until(async () => (await hello()).build_id === expected, 30);
    await this.online();
    this.assertEqual(await panes(), shells);
    this.assertEqual(fs.statSync(destination, { bigint: true }).ctimeNs, stamp);
  }
  async test_dev_connections_update_automatically_and_show_progress_without_blocking_local_input() {
    await this.command("pane.create", { workspace: 1, command: "cat" });
    await this.test_setup_installs_the_canonical_binary_over_real_ssh_and_preserves_shells();
    const destination = join(this.remote!.temp.name, ".local/bin/corgi");
    const before = await this.remote!.rpc({ op: "session.snapshot" });
    const a = await this.developmentBinary("auto-a"),
      b = await this.developmentBinary("auto-b");
    fs.writeFileSync(join(this.temp.name, "build.ts"), "// Same-platform fixture.\n");
    Object.assign(this.env, { CORGI_DEV_ROOT: this.temp.name, CORGI_DEV_BUN: process.execPath });
    const command = () => run([a, "--machine", "work", "ping"], { env: this.env, timeout: 60000 });
    const first = await command();
    this.assertIn("Preparing delta", first.stderr);
    const pid = (await this.remote!.rpc({ op: "hello", protocol: 1 })).server_pid;
    this.assertNotIn("Uploading", (await command()).stderr);
    this.assertEqual((await this.remote!.rpc({ op: "hello", protocol: 1 })).server_pid, pid);
    this.network!.cut();
    this.network!.bytes_per_second = 128 * 1024;
    this.network!.latency_ms = 60;
    const shown = new Set<string>();
    await this.startViewer(
      "work",
      110,
      36,
      () => {
        for (const stage of ["Preparing delta", "Uploading", "Installing…", "Verifying…"])
          if (this.text().includes(stage)) shown.add(stage);
        if (/work[^\n]*(?:Uploading|↑) +\d+% [\d.]+ [KM]?i?B\/s/.test(this.text())) shown.add("rate");
      },
      b,
    );
    await this.until(() => shown.has("Preparing delta") || shown.has("rate"), 30);
    this.clickWorkspace("LOCAL");
    this.terminal!.write("LOCAL_DURING_UPDATE\r");
    await this.until(() => this.text().includes("LOCAL_DURING_UPDATE"), 1);
    await this.until(
      async () => (await this.command("pane.read", { target: 1 })).text.includes("LOCAL_DURING_UPDATE"),
      2,
    );
    const expected = createHash("sha256").update(fs.readFileSync(b)).digest("hex");
    await this.until(async () => (await this.remote!.rpc({ op: "hello", protocol: 1 })).build_id === expected, 30);
    await this.until(() => this.text().includes("REMOTE_WORKSPACE"), 15);
    this.clickWorkspace("REMOTE");
    await this.sendRemote("REMOTE_AFTER_AUTO_UPDATE");
    await this.until(() => this.text().includes("REMOTE_AFTER_AUTO_UPDATE"), 3);
    const after = await this.remote!.rpc({ op: "session.snapshot" });
    this.assertEqual(
      after.panes.map((p: { pid: number }) => p.pid),
      before.panes.map((p: { pid: number }) => p.pid),
    );
    this.assertEqual(createHash("sha256").update(fs.readFileSync(destination)).digest("hex"), expected);
    this.assertTrue(shown.has("rate"));
    this.terminal!.write("\x02q");
    await deadline(this.ui!.exited, 2000);
    this.terminal!.close();
    this.emulator!.destroy();
    const marker = join(this.temp.name, "redundant-setup");
    const ssh = join(this.temp.name, "bin/ssh");
    fs.writeFileSync(
      ssh,
      fs
        .readFileSync(ssh, "utf8")
        .replace(
          "const p = Bun.spawn(",
          `if (args.at(-1).includes("corgi-setup-v1")) await Bun.write(${JSON.stringify(marker)}, ""); const p = Bun.spawn(`,
        ),
    );
    this.network!.bytes_per_second = this.network!.latency_ms = 0;
    await this.startViewer("work", 110, 36, undefined, b);
    await this.online();
    await this.sendRemote("REMOTE_REATTACHED");
    await Bun.sleep(1600);
    this.assertFalse(fs.existsSync(marker), "A verified reattach ran machine setup again");
  }
  async test_dev_launcher_connects_during_a_cross_build_and_quits_with_the_build_blocked() {
    await this.test_setup_installs_the_canonical_binary_over_real_ssh_and_preserves_shells();
    const root = this.temp.name;
    fs.mkdirSync(join(root, "scripts"), { recursive: true });
    fs.mkdirSync(join(root, "dist"), { recursive: true });
    fs.copyFileSync(join(runtime.ROOT, "go.ts"), join(root, "go.ts"));
    fs.copyFileSync(join(runtime.ROOT, "scripts/stop-other-daemons.ts"), join(root, "scripts/stop-other-daemons.ts"));
    fs.copyFileSync(await this.developmentBinary("launcher"), join(root, "dist/corgi"));
    // Only the setup probe sees a different CPU. The live SSH daemon still runs its real build.
    const wrapper = join(root, "bin/ssh");
    const probe = join(root, "setup-probe");
    const arch = process.arch === "arm64" ? "x86_64" : "aarch64";
    fs.writeFileSync(
      wrapper,
      fs
        .readFileSync(wrapper, "utf8")
        .replace(
          "const p = Bun.spawn(",
          `if (args.at(-1).includes("corgi-setup-v1")) await Bun.write(${JSON.stringify(probe)}, ""); args[args.length - 1] = args.at(-1).replace("uname -m", "echo ${arch}"); const p = Bun.spawn(`,
        ),
    );
    const target = process.platform + (arch === "aarch64" ? "-arm64" : "-x64");
    const started = join(root, "compiler-started"),
      stopped = join(root, "compiler-stopped");
    const compiler = `trap 'touch "${stopped}"; exit' TERM; touch "${started}"; sleep 30`;
    fs.writeFileSync(
      join(root, "build.ts"),
      `
      if (process.argv.includes("--target")) {
        process.send("Compiling native code with Zig");
        await Bun.spawn(["sh", "-c", ${JSON.stringify(compiler)}], { stdio: ["ignore", "inherit", "inherit"] }).exited;
      }
    `,
    );
    fs.writeFileSync(
      join(this.env.XDG_STATE_HOME!, "corgi/viewer.json"),
      JSON.stringify({ onboarding_complete: true, sidebar_width: 44 }),
    );
    const launcher = [process.execPath, join(root, "go.ts"), "--no-kill"];
    const existing = await this.remote!.rpc({ op: "hello", protocol: 1 });
    await this.startViewer("work", 110, 36, undefined, [...launcher, "--no-remote-update"]);
    await this.online();
    await this.sendRemote("REMOTE_WITH_UPDATES_DISABLED");
    await Bun.sleep(1600);
    this.terminal!.write("\x02q");
    this.assertEqual(await deadline(this.ui!.exited, 2000), 0);
    this.terminal!.close();
    this.emulator!.destroy();
    await run([...launcher, "--no-remote-update", "--machine", "work", "ping"], { env: this.env });
    this.assertFalse(fs.existsSync(probe));
    await run([...launcher, "--no-remote-update", "machine", "check", "work"], { env: this.env });
    const conflicting = await run([...launcher, "--no-remote-update", "--deploy", "work"], {
      env: this.env,
      check: false,
    });
    this.assertNotEqual(conflicting.code, 0);
    this.assertIn("--no-remote-update", conflicting.stderr);
    this.assertFalse(fs.existsSync(started));
    const afterSkip = await this.remote!.rpc({ op: "hello", protocol: 1 });
    this.assertEqual(afterSkip.build_id, existing.build_id);
    this.assertEqual(afterSkip.server_pid, existing.server_pid);
    await this.startViewer("work", 110, 36, undefined, launcher);
    await this.until(() => fs.existsSync(started), 15);
    await this.online();
    await this.until(() => new RegExp(`work[^\\n]*Building ${target}… +[1-9]\\d*s`).test(this.text()), 4);
    await this.sendRemote("REMOTE_DURING_BUILD");
    this.terminal!.write("\x02q");
    this.assertEqual(await deadline(this.ui!.exited, 2000, "go.ts waited for the cross-build"), 0);
    await this.until(() => fs.existsSync(stopped), 2);
  }
  async test_cancel_during_automatic_install_finishes_the_receipt_and_allows_reconnection() {
    await this.test_setup_installs_the_canonical_binary_over_real_ssh_and_preserves_shells();
    const a = await this.developmentBinary("cancel-a"),
      b = await this.developmentBinary("cancel-b");
    fs.writeFileSync(join(this.temp.name, "build.ts"), "// Same-platform fixture.\n");
    const env = { ...this.env, CORGI_DEV_ROOT: this.temp.name, CORGI_DEV_BUN: process.execPath };
    await run([a, "--machine", "work", "ping"], { env, timeout: 60000 });
    const wrapper = join(this.temp.name, "bin/ssh"),
      marker = join(this.temp.name, "install-started"),
      release = join(this.temp.name, "allow-install");
    fs.writeFileSync(
      wrapper,
      fs
        .readFileSync(wrapper, "utf8")
        .replace(
          "const p = Bun.spawn(",
          `if (args.at(-1).includes("__machine-install-session")) args[args.length-1] = args.at(-1).replace("chmod 700", ${JSON.stringify(`touch ${quote(marker)}; while [ ! -f ${quote(release)} ]; do sleep 0.03; done; chmod 700`)}); const p = Bun.spawn(`,
        ),
    );
    Object.assign(this.env, env);
    await this.startViewer("work", 110, 36, undefined, b);
    let check: ReturnType<typeof run>;
    try {
      await this.until(() => fs.existsSync(marker), 30);
      check = run([b, "machine", "check", "work"], { env, check: false, timeout: 60000 });
      await this.online();
      this.terminal!.write("\x02q");
      this.assertEqual(await deadline(this.ui!.exited, 2000, "viewer waited for the atomic install"), 0);
    } finally {
      fs.writeFileSync(release, "");
    }
    const checked = await check;
    this.assertEqual(checked.code, 0, checked.stderr);
    this.assertNotIn("Uploading", checked.stderr);
    const receipts = join(this.temp.name, "dist/dev-deploy");
    const receipt = fs.readdirSync(receipts).find(name => /^[a-f0-9]{64}\.json$/.test(name))!;
    const expected = createHash("sha256").update(fs.readFileSync(b)).digest("hex");
    await this.until(() => JSON.parse(fs.readFileSync(join(receipts, receipt), "utf8")).hash === expected, 30);
    const result = await run([b, "--machine", "work", "ping"], { env, timeout: 60000 });
    this.assertNotIn("Uploading", result.stderr);
    const destination = join(this.remote!.temp.name, ".local/bin/corgi");
    this.assertEqual(createHash("sha256").update(fs.readFileSync(destination)).digest("hex"), expected);
  }
  async tearDown() {
    try {
      if (this.ui?.exitCode === null) {
        this.ui.kill();
        await deadline(this.ui.exited, 5000);
      }
      this.terminal?.close();
      this.emulator?.destroy();
      await this.network?.close();
      this.sshd?.kill();
      if (this.sshd) await this.sshd.exited;
      if (this.remote) await this.remote.tearDown();
    } finally {
      await super.tearDown();
    }
  }
  async cli(args: string[], input?: string) {
    const command = args[0] === "--machine" ? args.slice(2) : args;
    if (cli.handles(command) && !command.includes("--all-machines")) args = [...args, "--json"];
    const result = await run([runtime.EXE, ...args], { env: this.env, input, timeout: 20_000 });
    return JSON.parse(result.stdout);
  }
  text() {
    return this.emulator!.text();
  }
  async startViewer(
    selected = "work",
    cols = 100,
    rows = 30,
    onData: (data: Uint8Array) => void = () => {},
    executable: string | string[] = runtime.EXE,
  ) {
    this.emulator = new Terminal(cols, rows);
    this.terminal = new Bun.Terminal({
      cols,
      rows,
      data: (_tty, data) => {
        this.emulator!.feed(data);
        onData(data);
      },
    });
    const command = typeof executable === "string" ? [executable] : executable;
    this.ui = Bun.spawn([...command, ...(selected === "local" ? ["--no-update"] : ["--machine", selected])], {
      env: this.env,
      cwd: this.temp.name,
      terminal: this.terminal,
    });
  }
  async online(name = "work", timeout = 8) {
    // A machine says it's behind only after a second; until then it looks
    // caught up. While it says so, its panes drop typing.
    const settled = performance.now() + 1300;
    const shown = () =>
      this.text().includes(`▌${name === "local" ? "LOCAL" : "REMOTE"}_WORKSPACE`) && !this.text().includes(" ⟳ ");
    try {
      await this.until(shown, timeout);
      if (performance.now() < settled) {
        await Bun.sleep(settled - performance.now());
        await this.until(shown, timeout);
      }
    } catch (error) {
      throw Error(`Expected ${name} online:\n${this.text()}`, { cause: error });
    }
  }
  async sendRemote(marker: string) {
    this.terminal!.write(marker + "\r");
    await this.remote!.until(
      async () => (await this.remote!.command("pane.read", { target: 1 })).text.includes(marker),
      5,
    );
  }
  async withholdReply() {
    this.network!.set("replies");
    // Produce a frame instead of waiting for an idle heartbeat to arrive.
    await this.remote!.command("pane.input", { target: 1, data: "\r" });
    await this.until(() => this.network!.withheld > 0);
  }
  click(x: number, y: number) {
    this.terminal!.write(`\x1b[<0;${x + 1};${y + 1}M\x1b[<0;${x + 1};${y + 1}m`);
  }
  clickWorkspace(name: "LOCAL" | "REMOTE" | "SLOW") {
    const y = this.text()
      .split("\n")
      .findIndex(line => line.includes(`${name}_WORKSPACE`));
    this.assertTrue(y >= 0, this.text());
    this.click(3, y);
  }
  async test_typing_latency_matches_ssh_without_waiting_for_poll_or_acknowledgement() {
    const program =
      "import os,tty; tty.setraw(0); os.write(1,b'READY\\r\\n'); exec('while True:\\n b=os.read(0,1)\\n os.write(1,b.upper())')";
    const command = "python3 -u -c " + quote(program);
    await this.remote!.command("pane.create", { workspace: 1, command });
    this.network!.latency_ms = 60;
    const ssh = Bun.spawn([Bun.which("ssh")!, "-F", this.sshconfig, "-tt", "corgi-test-host", command], {
      env: this.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    let output = "";
    const reader = (async () => {
      for await (const bytes of ssh.stdout) output += Buffer.from(bytes).toString();
    })();
    try {
      await this.until(() => output.includes("READY"), 10);
      await this.startViewer();
      await this.online(undefined, 20);
      await this.until(() => this.text().includes("READY"));
      const plain: number[] = [],
        corgi: number[] = [];
      let expected = "";
      for (const key of "vabcdefghijklmnopqrstuwxyz") {
        expected += key.toUpperCase();
        let started = performance.now();
        ssh.stdin.write(key);
        ssh.stdin.flush();
        while (!output.includes(expected)) {
          this.assertLess(performance.now() - started, 3000);
          await Bun.sleep(2);
        }
        plain.push(performance.now() - started);
        started = performance.now();
        this.terminal!.write(key);
        // Pane output, not the Corgi sidebar or echoed local input.
        while (
          !this.text()
            .split("\n")
            .some(row => row.slice(28).includes(expected))
        ) {
          this.assertLess(performance.now() - started, 3000);
          await Bun.sleep(2);
        }
        corgi.push(performance.now() - started);
        await Bun.sleep(31 + plain.length * 3);
      }
      const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
      console.log(
        "Typing echo at 120ms RTT",
        JSON.stringify({ ssh: plain.map(Math.round), corgi: corgi.map(Math.round) }),
      );
      this.assertLess(median(corgi), median(plain) + 15);
    } finally {
      ssh.kill();
      await ssh.exited;
      await reader;
    }
  }
  async test_reopening_retains_ghost_workspace_cards_while_local_input_starts() {
    await this.command("pane.create", { workspace: 1, command: "cat" });
    await this.remote!.command("pane.create", { workspace: 1, command: "cat" });
    await this.startViewer();
    await this.online();
    await this.until(() => this.text().includes("REMOTE_WORKSPACE"));
    await Bun.sleep(1200);
    this.ui!.kill();
    await this.ui!.exited;
    this.terminal!.close();
    this.emulator!.destroy();
    this.network!.set("blackhole");
    await this.startViewer("local");
    await this.online("local", 4);
    this.assertIn("REMOTE_WORKSPACE", this.text());
    const remoteRow = this.text()
      .split("\n")
      .findIndex(row => row.includes("REMOTE_WORKSPACE"));
    const status = () => this.text().split("\n")[remoteRow].slice(0, 28);
    // It says so once connecting has taken a second.
    await this.until(
      () =>
        this.text()
          .split("\n")
          .some(row => row.includes("▾  work") && row.includes("connecting")),
      2,
    );
    const first = status();
    const style = () => this.emulator!.surface(0).surface.lines[remoteRow];
    const first_style = style();
    await this.until(() => style() !== first_style, 1);
    this.assertEqual(status(), first);
    this.terminal!.write("LOCAL_DURING_REOPEN\r");
    await this.until(
      async () => (await this.command("pane.read", { target: 1 })).text.includes("LOCAL_DURING_REOPEN"),
      2,
    );
    this.network!.cut();
    this.network!.set("healthy");
    await this.until(
      () =>
        this.text()
          .split("\n")
          .some(row => row.includes("▾  work") && row.includes("▂▄▆█")),
      12,
    );
    this.assertEqual(status(), first);
    this.assertEqual(
      this.text()
        .split("\n")
        .findIndex(row => row.includes("REMOTE_WORKSPACE")),
      remoteRow,
    );
  }
  async test_resource_hover_follows_workspace_ownership_without_selecting_it() {
    await this.command("pane.create", { workspace: 1, command: "cat" });
    await this.remote!.command("pane.create", { workspace: 1, command: "cat" });
    const localPane = (await this.session()).panes[0];
    const remotePane = (await this.remote!.session()).panes[0];
    await this.startViewer("local", 140, 40);
    await this.online("local");
    await this.until(() => this.text().includes("REMOTE_WORKSPACE"));
    const hover = async (name: "LOCAL" | "REMOTE") => {
      this.terminal!.write("\x1b[<35;2;2M");
      await this.until(() => !this.text().includes("TOP PROCESSES"));
      const y =
        this.text()
          .split("\n")
          .findIndex(row => row.includes(`${name}_WORKSPACE`)) + 2;
      // CPU labels shorten with the sidebar width.
      await this.until(() => /\bC(PU)? \d+%/.test(this.text().split("\n")[y]));
      this.terminal!.write(`\x1b[<35;5;${y + 1}M`);
      await this.until(() => this.emulator!.surface(0).surface.lines[y].includes(`38;2;${runtime.PALETTE.text}`));
      await this.until(() => this.text().includes("TOP PROCESSES"));
      const pid = name === "LOCAL" ? localPane.pid : remotePane.pid;
      await this.until(() => new RegExp(`\\b${pid}\\b`).test(this.text()));
    };
    await hover("LOCAL");
    await hover("REMOTE");
    this.assertIn("▌LOCAL_WORKSPACE", this.text());
    const untouched = (await this.remote!.session()).panes[0];
    this.assertEqual(untouched.cols, remotePane.cols);
    this.assertEqual(untouched.rows, remotePane.rows);
    this.clickWorkspace("REMOTE");
    await this.online();
    await hover("REMOTE");
    await hover("LOCAL");
    this.assertIn("▌REMOTE_WORKSPACE", this.text());
    // Opening and closing the filter must not leave pointer input captured.
    this.terminal!.write("\x1d");
    await this.until(() => this.text().includes("All workspaces"));
    this.terminal!.write("\x1d");
    await this.until(() => !this.text().includes("All workspaces"));
    await this.online();
    await hover("REMOTE");
  }
  async test_resource_readings_keep_updating_on_both_machines_across_workspace_switches() {
    await this.command("pane.create", { workspace: 1, command: "cat" });
    await this.remote!.command("pane.create", { workspace: 1, command: "cat" });
    // A different viewer has disabled resources on the unselected machine.
    const hidden = new Connection(this.remote!.path);
    try {
      await hidden.call("hello");
      await hidden.call("viewer.open", { onboarding: true });
      await hidden.call("viewer.sync", { interests: [], resources: false, watched: false });
      await this.remote!.until(async () => (await this.remote!.session()).resources.sampled_at === 0);
      const remote_pane = (await this.remote!.session()).panes[0];
      fs.writeFileSync(
        join(this.env.XDG_STATE_HOME!, "corgi/viewer.json"),
        JSON.stringify({ onboarding_complete: true, sidebar_width: 44 }),
      );
      await this.startViewer("local");
      await this.online("local");
      const readings = () => {
        const rows = this.text().split("\n");
        return ["LOCAL", "REMOTE"].map(name => {
          const y = rows.findIndex(row => row.includes(`${name}_WORKSPACE`));
          return y < 0 ? "" : rows[y + 2].slice(0, 44);
        });
      };
      await this.until(() => readings().every(row => /CPU \d+%\s+Memory \d+M/.test(row)), 12);
      // Telemetry alone must not attach to or resize the remote terminal.
      this.assertEqual((await this.remote!.session()).panes[0].cols, remote_pane.cols);
      this.assertEqual((await this.remote!.session()).panes[0].rows, remote_pane.rows);
      for (const selected of ["LOCAL", "REMOTE", "LOCAL"] as const) {
        this.clickWorkspace(selected);
        const previous = [0, 0];
        const samples = [0, 0];
        await this.until(async () => {
          for (const row of readings()) this.assertRegex(row, /CPU \d+%\s+Memory \d+M/);
          const snapshots = await Promise.all([this.session(), this.remote!.session()]);
          snapshots.forEach((snapshot, index) => {
            const resources = snapshot.resources;
            this.assertGreater(resources.sampled_at, 0);
            this.assertIsNotNone(resources.workspaces.find((work: any) => work.id === 1)?.cpu);
            if (resources.sampled_at !== previous[index]) samples[index]++;
            previous[index] = resources.sampled_at;
          });
          return samples.every(count => count >= 3);
        }, 10);
      }
    } finally {
      hidden.close();
    }
  }
  async test_workspace_selection_and_tabs_are_immediate_before_slow_attachment() {
    await this.command("pane.create", { workspace: 1, command: "cat" });
    const target = (
      await this.remote!.command("workspace.create", { name: "SLOW_WORKSPACE", cwd: this.remote!.temp.name })
    ).workspace;
    const pane = await this.remote!.command("pane.create", { workspace: target, command: "cat" });
    await this.remote!.command("tab.rename", { target: pane.tab, name: "PREFETCHED_TAB" });
    await this.startViewer("local");
    await this.online("local");
    await this.until(() => this.text().includes("SLOW"));
    this.network!.latency_ms = 800;
    for (let i = 0; i < 3; i++) {
      this.clickWorkspace("SLOW");
      await this.until(() => this.text().includes("▌SLOW_WORKSPACE") && this.text().includes("PREFETCHED_TAB"), 0.5);
      if (i < 2) {
        this.clickWorkspace("LOCAL");
        await this.until(() => this.text().includes("▌LOCAL_WORKSPACE"), 0.5);
      }
    }
    this.assertIn("Loading pane…", this.text());
    // Still behind a second later, it says so over the pane; only behind, it
    // offers no keys, which stay the pane's.
    await this.until(() => this.text().includes("⟳ work: "), 3);
    this.assertFalse(this.text().includes("Ctrl+R retry"));
    await this.until(() => {
      this.assertIn("▌SLOW_WORKSPACE", this.text());
      return !this.text().includes("⟳ work: ");
    }, 25);
    this.assertIn("PREFETCHED_TAB", this.text());
  }
  async test_all_workspaces_default_inline_dropdown_and_cross_machine_mouse_and_keyboard_navigation() {
    await this.command("pane.create", { workspace: 1, command: "cat" });
    await this.remote!.command("pane.create", { workspace: 1, command: "cat" });
    await this.startViewer("local");
    await this.online("local");
    await this.until(() => this.text().includes("REMOTE_WORKSPACE"));
    this.assertIn("all ▾", this.text().split("\n")[0]);
    this.clickWorkspace("REMOTE");
    await this.online();
    await this.sendRemote("MOUSE_REMOTE");
    this.assertNotIn("MOUSE_REMOTE", (await this.command("pane.read", { target: 1 })).text);
    this.clickWorkspace("LOCAL");
    await this.online("local");
    // The ordinary workspace keyboard cursor crosses machine ownership too.
    this.terminal!.write("\x02w\x1b[B\rDROP_AFTER_SWITCH\r");
    await this.online();
    await this.sendRemote("KEYBOARD_REMOTE");
    this.assertNotIn("DROP_AFTER_SWITCH", (await this.command("pane.read", { target: 1 })).text);
    this.assertNotIn("DROP_AFTER_SWITCH", (await this.remote!.command("pane.read", { target: 1 })).text);
    const x = this.text().split("\n")[0].indexOf("all ▾");
    this.click(x, 0);
    await this.until(() => this.text().includes("All workspaces"));
    await this.until(() => /local\s+● online/.test(this.text()) && /work\s+(?:● |▂▄▆█ )online/.test(this.text()));
    this.assertIn("MOUSE_REMOTE", this.text());
    this.terminal!.write("l\r");
    await this.until(() => this.text().includes("local ▾"));
    this.assertIn("MOUSE_REMOTE", this.text());
    this.clickWorkspace("LOCAL");
    await this.online("local");
    this.assertIn("local ▾", this.text().split("\n")[0]);
    this.assertNotIn("REMOTE_WORKSPACE", this.text());
    this.terminal!.write("\x1da\r");
    await this.until(() => this.text().includes("all ▾") && this.text().includes("REMOTE_WORKSPACE"));
  }
  async test_machine_collapse_and_authentication_diagnostics_keep_local_input_usable() {
    const sshPath = join(this.temp.name, "bin/ssh");
    const original = fs.readFileSync(sshPath, "utf8");
    const before = (await this.remote!.rpc({ op: "hello", protocol: 1 })).server_pid;
    this.assertEqual((await this.cli(["machine", "status", "work"])).status, "reachable");
    writeExecutable(sshPath, "#!/bin/sh\nprintf '%s\\n' 'Permission denied (publickey).' >&2\nexit 255\n");
    await this.command("pane.create", { workspace: 1, command: "cat" });
    await this.startViewer("local");
    await this.online("local");
    await this.until(() => this.text().includes("! auth"));
    let lines = this.text().split("\n");
    let y = lines.findIndex(line => line.includes("! auth"));
    this.click(lines[y].indexOf("! auth"), y);
    await this.until(() => this.text().includes("corgi machine reconnect work"));
    this.assertIn("Permission denied (publickey).", this.text());
    this.terminal!.write("\x1b");
    await this.until(() => !this.text().includes("corgi machine reconnect work"));
    writeExecutable(sshPath, original);
    this.assertEqual((await this.cli(["machine", "reconnect", "work"])).status, "reachable");
    this.assertEqual((await this.remote!.rpc({ op: "hello", protocol: 1 })).server_pid, before);
    this.terminal!.write("\x1dw\x12\x1b");
    await this.until(() => this.text().includes("REMOTE_WORKSPACE"));
    lines = this.text().split("\n");
    y = lines.findIndex(line => line.includes("▾  work"));
    this.assertTrue(y >= 0);
    this.click(2, y);
    await this.until(() => this.text().includes("▸  work") && !this.text().includes("REMOTE_WORKSPACE"));
    this.terminal!.write("LOCAL_WHILE_COLLAPSED\r");
    await this.until(async () =>
      (await this.command("pane.read", { target: 1 })).text.includes("LOCAL_WHILE_COLLAPSED"),
    );
    this.click(2, y);
    await this.until(() => this.text().includes("REMOTE_WORKSPACE"));
    this.assertIn("▌LOCAL_WORKSPACE", this.text());
  }
  async test_review_reads_the_remote_checkout_over_the_data_connection() {
    const repo = join(this.remote!.temp.name, "remote-repo"),
      git = (...args: string[]) =>
        run(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { env: this.env });
    fs.mkdirSync(repo);
    await git("init", "-q", "-b", "main");
    fs.writeFileSync(join(repo, "remote_file.txt"), "before\n");
    await git("add", ".");
    await git("commit", "-qm", "base");
    fs.writeFileSync(join(repo, "remote_file.txt"), "REMOTE_ONLY_CHANGE\n");
    await this.remote!.command("pane.create", { workspace: 1, cwd: repo, command: "cat" });
    const preferences = join(this.env.XDG_STATE_HOME!, "corgi/viewer.json");
    fs.writeFileSync(preferences, JSON.stringify({ onboarding_complete: true }));
    await this.startViewer("work", 150, 30);
    await this.online();
    // The viewer shows the remote machine, so that daemon carries the action.
    await this.remote!.rpc({ op: "action", name: "review" });
    // The panel lists the remote file and shows its diff, read by the remote daemon.
    await this.until(() => this.text().includes("remote_file.txt") && this.text().includes("REMOTE_ONLY_CHANGE"), 15);
    this.assertIn("1 file", this.text());
  }
  async test_new_workspace_browses_and_makes_folders_on_the_remote_machine() {
    // Both daemons share this disk; `~` is each one's own home. The dialog
    // starts in another folder, so the home's folders show only through `~`.
    const home = fs.realpathSync(this.remote!.temp.name),
      start = join(home, "start");
    fs.mkdirSync(start);
    fs.mkdirSync(join(home, "REMOTE_HOME_FOLDER"));
    fs.mkdirSync(join(this.temp.name, "LOCAL_HOME_FOLDER"));
    const preferences = join(this.env.XDG_STATE_HOME!, "corgi/viewer.json");
    fs.writeFileSync(preferences, JSON.stringify({ onboarding_complete: true }));
    const cwds = async () =>
      (await this.remote!.rpc({ op: "session.list" })).result.workspaces.map((w: { cwd: string }) => w.cwd);
    await this.remote!.command("pane.create", { workspace: 1, cwd: start, command: "cat" });
    await this.startViewer("work", 120, 36);
    await this.online();
    await this.remote!.rpc({ op: "action", name: "new-workspace" });
    await this.until(() => this.text().includes("New workspace"));
    // The folder field, emptied, lists the remote machine's home.
    this.terminal!.write("\t" + "\x7f".repeat(300) + "~/");
    await this.until(() => this.text().includes("REMOTE_HOME_FOLDER"), 10);
    this.assertFalse(this.text().includes("LOCAL_HOME_FOLDER"));
    this.terminal!.write("made/deeper");
    await this.until(() => this.text().includes("Create made/deeper"), 10);
    this.terminal!.write("\r");
    await this.remote!.until(async () => (await cwds()).includes(join(home, "made/deeper")), 10);
    this.assertFalse(fs.existsSync(join(this.temp.name, "made")));
    await this.until(() => this.text().includes("▌deeper"));
    // Escape while a slow link makes the folder cancels the workspace.
    await this.remote!.rpc({ op: "action", name: "new-workspace" });
    await this.until(() => this.text().includes("New workspace"));
    this.terminal!.write("\t" + "\x7f".repeat(300) + "~/cancelled");
    await this.until(() => this.text().includes("Create cancelled"), 10);
    this.network!.latency_ms = 800;
    this.terminal!.write("\r\x1b[27u");
    await this.until(() => !this.text().includes("New workspace"), 5);
    await this.remote!.until(() => fs.existsSync(join(home, "cancelled")), 10);
    // Long enough for the folder's reply and a create to cross the slow link.
    await Bun.sleep(3000);
    this.assertFalse((await cwds()).includes(join(home, "cancelled")));
  }
  async test_all_agents_lists_both_machines_and_clicking_a_remote_agent_focuses_it_there() {
    const mark = async (runtime: runtime.Runtime, name: string) => {
      const pane = (await runtime.command("pane.create", { workspace: 1, command: "cat" })).pane;
      await runtime.command("pane.rename", { target: pane, name });
      const event = { hook_event_name: "SessionStart", session_id: name };
      await runtime.rpc({ op: "hook", pane, provider: "claude", seq: 1, event });
      return pane;
    };
    await mark(this, "LOCAL_AGENT");
    const agent = await mark(this.remote!, "REMOTE_AGENT");
    // Focus starts elsewhere on the remote machine.
    const other = (await this.remote!.command("pane.create", { workspace: 1, command: "cat" })).pane;
    const preferences = join(this.env.XDG_STATE_HOME!, "corgi/viewer.json");
    fs.writeFileSync(preferences, JSON.stringify({ onboarding_complete: true, agents: "all" }));
    await this.startViewer("local");
    await this.online("local");
    await this.until(() => this.text().includes("REMOTE_AGENT") && this.text().includes("LOCAL_AGENT"));
    const rows = this.text().split("\n");
    // Each machine's groups name it.
    this.assertTrue(
      rows.some(line => /▾ LOCAL_WORK\S*\s+local ━/.test(line)),
      this.text(),
    );
    this.assertTrue(
      rows.some(line => /▾ REMOTE_WORK\S*\s+work ━/.test(line)),
      this.text(),
    );
    this.click(
      5,
      rows.findIndex(line => line.includes("REMOTE_AGENT")),
    );
    await this.online();
    this.terminal!.write("FOCUSED_REMOTE_AGENT\r");
    const read = (pane: number) => this.remote!.command("pane.read", { target: pane });
    await this.remote!.until(async () => (await read(agent)).text.includes("FOCUSED_REMOTE_AGENT"));
    this.assertNotIn("FOCUSED_REMOTE_AGENT", (await read(other)).text);
  }
  async test_local_starts_and_remains_usable_during_the_initial_remote_handshake() {
    await this.run_cli("shutdown");
    await this.until(() => !fs.existsSync(this.path));
    this.network!.set("blackhole");
    await this.startViewer();
    await this.until(() => this.text().includes("LOCAL_WORKSPACE"), 5);
    this.assertIn("all ▾", this.text().split("\n")[0]);
    this.clickWorkspace("LOCAL");
    await this.online("local");
    await this.command("pane.create", { workspace: 1, command: "cat" });
    // Creating and typing into a local pane doesn't wait for SSH to time out.
    this.terminal!.write("LOCAL_DURING_HANDSHAKE\r");
    await this.until(
      async () => (await this.command("pane.read", { target: 1 })).text.includes("LOCAL_DURING_HANDSHAKE"),
      3,
    );
    this.network!.cut();
    this.network!.set("healthy");
    await this.until(
      () =>
        this.text()
          .split("\n")
          .some(row => row.includes("▾  work") && row.includes("▂▄▆█")),
      12,
    );
    this.network!.set("blackhole");
    await this.until(
      () =>
        this.text()
          .split("\n")
          .some(row => row.includes("▾  work") && row.includes("stalled")),
      6,
    );
    this.assertIn("REMOTE_WORKSPACE", this.text());
    this.assertNotIn("Ctrl+R retry", this.text());
    this.terminal!.write("LOCAL_DURING_OUTAGE\r");
    await this.until(
      async () => (await this.command("pane.read", { target: 1 })).text.includes("LOCAL_DURING_OUTAGE"),
      3,
    );
  }
  async test_cli_routes_paths_input_and_context_to_the_selected_machine() {
    const local = await this.command("pane.create", { workspace: 1, command: "cat" });
    const remote = (
      await this.cli([
        "--machine",
        "work",
        "tab",
        "new",
        "--workspace",
        "1",
        "--command",
        "cat",
        "--cwd",
        this.remote!.temp.name,
      ])
    ).result;
    this.assertEqual(local.pane, remote.pane);
    await this.cli(["--machine", "work", "pane", "send", String(remote.pane), "--stdin", "--enter"], "REMOTE_ONLY");
    await this.remote!.until(async () =>
      (await this.cli(["--machine", "work", "pane", "read", String(remote.pane)])).result.text.includes("REMOTE_ONLY"),
    );
    const local_text = await this.command("pane.read", { target: local.pane });
    this.assertFalse(local_text.text.includes("REMOTE_ONLY"));
    const list = await this.cli(["list", "--all-machines"]);
    this.assertEqual(
      list.machines.map((m: any) => m.machine),
      ["local", "work"],
    );
    this.assertTrue(list.machines.every((m: any) => m.ok));
    // A default machine doesn't narrow the list of every machine.
    const defaulted = await run([runtime.EXE, "list", "--all-machines"], {
      env: { ...this.env, CORGI_MACHINE: "work" },
    });
    this.assertEqual(
      JSON.parse(defaulted.stdout).machines.map((m: any) => m.machine),
      ["local", "work"],
    );
    const caller = await run([runtime.EXE, "--machine", "work", "current", "--json"], {
      env: { ...this.env, CORGI_PANE: String(local.pane) },
      check: false,
    });
    this.assertNotEqual(caller.code, 0);
    this.assertEqual(JSON.parse(caller.stderr).err, "NoCallerPane");
    await this.cli(["machine", "remove", "work"]);
    this.assertEqual((await this.remote!.session()).panes.length, 1);
  }
  async test_pinned_host_keys_and_image_uploads() {
    const hello = await this.remote!.rpc({ op: "hello", protocol: 1 });
    const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const uploaded = await run([runtime.EXE, "__remote-image", this.remote!.path, hello.instance, "image/png"], {
      env: this.env,
      input: image,
    });
    const records = uploaded.stdout
      .trim()
      .split("\n")
      .map(line => JSON.parse(line));
    this.assertEqual(records.slice(0, -1), [{ received: 0 }, { received: image.length }]);
    this.assertEqual(fs.readFileSync(records.at(-1).path).toString("hex"), image.toString("hex"));
    const stale = await run([runtime.EXE, "__remote-image", this.remote!.path, "old-daemon", "image/png"], {
      env: this.env,
      input: image,
      check: false,
    });
    this.assertNotEqual(stale.code, 0);
    fs.writeFileSync(
      join(this.temp.name, "known_hosts"),
      this.hostkey.replace(
        fs.readFileSync(join(this.temp.name, "host.pub"), "utf8"),
        fs.readFileSync(join(this.temp.name, "client.pub"), "utf8"),
      ),
    );
    const check = await run([runtime.EXE, "machine", "check", "work"], {
      env: this.env,
      check: false,
      timeout: 20_000,
    });
    this.assertNotEqual(check.code, 0);
    this.assertTrue(check.stderr.includes("HOST IDENTIFICATION HAS CHANGED"), check.stderr);
  }
  async test_native_stdio_separates_pane_ssh_and_shares_control_with_cli_without_socket_forwarding() {
    await this.remote!.command("pane.create", { workspace: 1, command: "cat" });
    const catalog = await this.cli(["machine", "list"]);
    const profile = catalog.machines.find((machine: { name: string }) => machine.name === "work");
    this.assertTrue(profile.bridge.endsWith("/bin/corgi-remote-bridge"));
    const wrapper = join(this.temp.name, "bin/ssh");
    const log = join(this.temp.name, "ssh-invocations");
    fs.writeFileSync(
      wrapper,
      fs
        .readFileSync(wrapper, "utf8")
        .replace(
          "#!/bin/sh\n",
          `#!/bin/sh\nfor arg in "$@"; do [ "$arg" = -L ] && exit 99; done\nprintf '%s\\n' "$*" >> ${quote(log)}\n`,
        ),
    );
    const connections = this.network!.accepted;
    await this.startViewer();
    await this.online();
    this.assertIn("corgi-remote-bridge", fs.readFileSync(log, "utf8"));
    this.assertNotIn("__remote-info", fs.readFileSync(log, "utf8"));
    // The control lane reuses the master warmed by machine setup. Pane data
    // gets its own TCP transport, which subsequent CLI calls must not use.
    this.assertEqual(this.network!.accepted, connections + 1);
    await this.cli(["--machine", "work", "ping"]);
    this.assertEqual(this.network!.accepted, connections + 1);
    this.terminal!.write("\x02q");
    await deadline(this.ui!.exited, 1500);
    // Detaching a channel must leave the shared master usable by other callers.
    await this.cli(["--machine", "work", "ping"]);
    this.assertEqual(this.network!.accepted, connections + 1);
  }
  async imageClipboard() {
    let output = "";
    await this.startViewer("work", 100, 30, data => (output += Buffer.from(data).toString()));
    await this.until(() => output.includes("\x1b[?5522$p"));
    this.terminal!.write("\x1b[?5522;2$y");
    await this.until(() => output.includes("type=read:id=corgi-probe;"));
    this.terminal!.write(clipboardPacket("OK", ":id=corgi-probe") + clipboardPacket("DONE", ":id=corgi-probe"));
    await this.until(() => output.includes("\x1b[?5522h"));
    await this.online();
    return async (label: string, bytes: Buffer) => {
      const offset = output.length;
      const pw = b64(label);
      this.terminal!.write(
        clipboardPacket("OK", `:pw=${pw}`) +
          clipboardPacket("DATA", `:pw=${pw}:mime=Lg==;${b64("image/png")}`) +
          clipboardPacket("DONE", `:pw=${pw}`),
      );
      await this.until(() => output.slice(offset).includes(`type=read:id=corgi:pw=${pw}:`));
      this.terminal!.write(clipboardPacket("OK", ":id=corgi"));
      for (let offset = 0; offset < bytes.length; offset += 8192) {
        this.terminal!.write(
          clipboardPacket("DATA", `:id=corgi:mime=${b64("image/png")};${b64(bytes.subarray(offset, offset + 8192))}`),
        );
        await Bun.sleep(1);
      }
      this.terminal!.write(clipboardPacket("DONE", ":id=corgi"));
      return join(
        dirname(this.remote!.path),
        "paste",
        createHash("sha256").update(bytes).digest("hex").slice(0, 32) + ".png",
      );
    };
  }
  delayImageUploads() {
    const executable = join(this.temp.name, "bin/ssh");
    const started = join(this.temp.name, "image-upload-started");
    fs.writeFileSync(
      executable,
      fs
        .readFileSync(executable, "utf8")
        .replace("#!/bin/sh\n", `#!/bin/sh\ncase "$*" in *__remote-image*) touch ${quote(started)}; sleep 2;; esac\n`),
    );
    return started;
  }
  async test_slow_image_paste_keeps_the_viewer_live_and_delivers_remote_bytes() {
    const received = join(this.remote!.temp.name, "image-input");
    await this.remote!.command("pane.create", {
      workspace: 1,
      command: `stty raw -echo; printf PASTE_READY; tee ${quote(received)}`,
    });
    const started = this.delayImageUploads();
    const paste = await this.imageClipboard();
    await this.until(() => this.text().includes("PASTE_READY"));
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 42]);
    const saved = await paste("slow-upload", png);
    await this.until(() => fs.existsSync(started));
    await this.until(() => this.text().includes("Preparing…"));
    // A healthy stream must remain usable past the one-second stall threshold.
    await Bun.sleep(1200);
    this.assertNotIn("Ctrl+R retry", this.text());
    this.terminal!.write("LIVE");
    await this.until(() => this.text().includes("LIVE"), 0.5);
    await this.until(() => fs.existsSync(received) && fs.readFileSync(received, "utf8").includes(saved), 8);
    this.assertEqual(fs.readFileSync(received, "utf8"), "LIVE" + saved);
    this.assertEqual(fs.readFileSync(saved), png);
    this.assertNotIn("StaleConnection", this.text());
  }
  async test_image_upload_progress_follows_the_caret_until_remote_delivery() {
    const received = join(this.remote!.temp.name, "image-input");
    await this.remote!.command("pane.create", {
      workspace: 1,
      command: `stty raw -echo; printf '\\033[12;6HPASTE_READY'; tee ${quote(received)}`,
    });
    const paste = await this.imageClipboard();
    await this.until(() => this.text().includes("PASTE_READY"));
    this.network!.bytes_per_second = 256 * 1024;
    // Random, as a real image's bytes are: SSH compression makes one repeated byte arrive at once.
    const png = randomBytes(1024 * 1024);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    const saved = await paste("progress", png);
    const samples: number[] = [];
    const bar = () => {
      const screen = this.emulator!.surface(0).surface;
      const y = screen.lines.findIndex(line => /↑ [▰▱]+\s+\d+%/.test(Bun.stripANSI(line)));
      if (y < 0) return null;
      const row = Bun.stripANSI(screen.lines[y]);
      const percent = Number(row.match(/↑ [▰▱]+\s+(\d+)%/)![1]);
      samples.push(percent);
      this.assertEqual(y, screen.cursor!.y - 1);
      this.assertNotIn("Ctrl+R retry", this.text());
      return { x: row.indexOf("↑"), y, percent };
    };
    try {
      await this.until(() => {
        const shown = bar();
        return shown && shown.percent > 0 && shown.percent < 100;
      }, 10);
    } catch (error) {
      throw Error(`No intermediate upload progress (${samples}):\n${this.text()}`, { cause: error });
    }
    this.terminal!.write("MOVED");
    await this.until(() => this.text().includes("PASTE_READYMOVED"));
    const moved = bar()!;
    this.assertTrue(moved !== null, this.text());
    this.assertEqual(moved.x, this.emulator!.surface(0).surface.cursor!.x);
    if (process.env.CORGI_PROGRESS_CAPTURE)
      await Bun.write(process.env.CORGI_PROGRESS_CAPTURE, JSON.stringify(this.emulator!.surface(0).surface));
    // Wrap while the file is still in flight; the bar follows the next row.
    const wrap = "x".repeat(65);
    this.terminal!.write(wrap);
    await this.until(() => {
      const shown = bar();
      return shown && shown.y > moved.y;
    });
    await this.until(() => {
      bar();
      return this.text().includes("✓ Uploaded");
    }, 10);
    this.assertTrue(
      samples.some(n => n > 0 && n < 100),
      JSON.stringify(samples),
    );
    this.assertTrue(
      samples.every((n, i) => i === 0 || n >= samples[i - 1]),
      JSON.stringify(samples),
    );
    await this.until(() => fs.readFileSync(received, "utf8") === "MOVED" + wrap + saved);
    this.assertEqual(fs.readFileSync(saved), png);
    await this.until(() => !this.text().includes("✓ Uploaded"));
    console.log(`image upload receiver progress: ${[...new Set(samples)].join(", ")}%`);
  }
  async test_image_paste_cancels_on_switch_or_disconnect_and_the_next_paste_works() {
    const received = join(this.remote!.temp.name, "image-input");
    const local = join(this.temp.name, "local-input");
    await this.command("pane.create", {
      workspace: 1,
      command: `stty raw -echo; tee ${quote(local)}`,
    });
    await this.remote!.command("pane.create", {
      workspace: 1,
      command: `stty raw -echo; printf PASTE_READY; tee ${quote(received)}`,
    });
    const started = this.delayImageUploads();
    const paste = await this.imageClipboard();
    await this.until(() => this.text().includes("PASTE_READY"));
    for (const interruption of ["switch", "disconnect"]) {
      fs.rmSync(started, { force: true });
      const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from(interruption)]);
      const saved = await paste(interruption, png);
      await this.until(() => fs.existsSync(started));
      if (interruption === "switch") {
        this.clickWorkspace("LOCAL");
        await this.online("local");
        this.terminal!.write("LOCAL_LIVE");
        await this.until(() => this.text().includes("LOCAL_LIVE"));
      } else {
        const connections = this.network!.accepted;
        this.network!.cut();
        await this.until(() => this.network!.accepted > connections);
        await this.online();
      }
      await Bun.sleep(2500);
      this.assertNotIn("Preparing…", this.text());
      this.assertNotIn("▱", this.text());
      this.assertEqual(fs.readFileSync(received, "utf8"), "");
      this.assertEqual(fs.readFileSync(local, "utf8"), "LOCAL_LIVE");
      this.assertFalse(fs.existsSync(saved), "The canceled upload should not continue in the background");
      if (interruption === "switch") {
        this.clickWorkspace("REMOTE");
        await this.online();
      }
    }
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 43]);
    const saved = await paste("after-cancellation", png);
    await this.until(() => fs.readFileSync(received, "utf8") === saved, 8);
    this.assertEqual(fs.readFileSync(saved), png);
  }
  async test_slow_image_paste_relays_to_the_remote_program() {
    const received = join(this.remote!.temp.name, "relayed-image");
    const program = writeExecutable(
      join(this.remote!.temp.name, "paste-events"),
      `process.stdin.setRawMode(true);
process.stdout.write("\\x1b[?5522hRELAY_READY");
let input = "", asked = false;
process.stdin.on("data", chunk => {
  input += chunk.toString("latin1");
  const event = input.match(/status=OK:pw=([^\\x1b]+)\\x1b\\\\[\\s\\S]*status=DONE/);
  if (!asked && event) {
    asked = true;
    input = "";
    process.stdout.write("\\x1b]5522;type=read:pw=" + event[1] + ":name=YXBw;aW1hZ2UvcG5n\\x1b\\\\");
  } else if (asked && input.includes("status=DONE")) {
    const chunks = [...input.matchAll(/status=DATA[^;]*;([A-Za-z0-9+/=]+)/g)];
    require("fs").writeFileSync(${JSON.stringify(received)}, Buffer.concat(chunks.map(m => Buffer.from(m[1], "base64"))));
    process.stdout.write("RELAYED");
  }
});
`,
    );
    await this.remote!.command("pane.create", { workspace: 1, command: quote(program) });
    this.delayImageUploads();
    const paste = await this.imageClipboard();
    await this.until(() => this.text().includes("RELAY_READY"));
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 44]);
    const saved = await paste("relay", png);
    await this.until(() => fs.existsSync(received) && fs.readFileSync(received).equals(png), 8);
    this.assertEqual(fs.readFileSync(saved), png);
    await this.until(() => this.text().includes("RELAYED"));
    this.assertNotIn("StaleConnection", this.text());
  }
  async test_workspace_filters_keep_local_interaction_live_while_a_host_is_down() {
    await this.command("pane.create", { workspace: 1, command: "cat" });
    await this.remote!.command("pane.create", { workspace: 1, command: "cat" });
    this.emulator = new Terminal(100, 30);
    this.terminal = new Bun.Terminal({ cols: 100, rows: 30, data: (_tty, data) => this.emulator!.feed(data) });
    this.ui = Bun.spawn([runtime.EXE, "--no-update"], { env: this.env, cwd: this.temp.name, terminal: this.terminal });
    const screen = () => this.emulator!.text();
    await this.until(() => screen().includes("▌LOCAL_WORKSPACE"), 8);
    await this.until(() => screen().includes("all ▾"), 8);
    this.terminal.write("\x1d");
    await this.until(() => screen().includes("All workspaces"), 5);
    await this.until(() => /local\s+● online/.test(screen()) && /work\s+(?:● |▂▄▆█ )online/.test(screen()), 5);
    this.terminal.write("w\r");
    await this.until(() => screen().includes("work ▾") && !screen().includes("All workspaces"));
    this.clickWorkspace("REMOTE");
    await this.until(() => screen().includes("▌REMOTE_WORKSPACE") && !screen().includes("Ctrl+R retry"), 8);
    this.terminal.write("FROM_REMOTE_VIEW\r");
    await this.remote!.until(
      async () => (await this.remote!.command("pane.read", { target: 1 })).text.includes("FROM_REMOTE_VIEW"),
      8,
    );
    this.assertFalse((await this.command("pane.read", { target: 1 })).text.includes("FROM_REMOTE_VIEW"));
    // Stall one daemon with a request in flight; switching must not wait for its response.
    const pid = (await this.remote!.rpc({ op: "hello", protocol: 1 })).server_pid;
    process.kill(pid, "SIGSTOP");
    try {
      this.terminal.write("\x1d");
      await this.until(() => screen().includes("All workspaces"), 2);
      this.terminal.write("l\r");
      await this.until(() => screen().includes("local ▾") && !screen().includes("All workspaces"));
      this.clickWorkspace("LOCAL");
      await this.until(() => screen().includes("▌LOCAL_WORKSPACE") && !screen().includes("Ctrl+R retry"), 5);
      this.terminal.write("FROM_LOCAL_VIEW\r");
      await this.until(
        async () => (await this.command("pane.read", { target: 1 })).text.includes("FROM_LOCAL_VIEW"),
        5,
      );
      this.terminal.write("\x1d");
      await this.until(() => screen().includes("All workspaces"), 2);
      this.terminal.write("w\r");
      await this.until(() => screen().includes("work ▾") && !screen().includes("All workspaces"));
      this.clickWorkspace("REMOTE");
      // While the notice says it can't be reached, the pane drops typing.
      await this.until(() => screen().includes("Ctrl+R retry"), 12);
      this.terminal.write("TYPED_WHILE_OFFLINE\r\x1d");
      await this.until(() => screen().includes("All workspaces"), 2);
      this.terminal.write("\x1d");
    } finally {
      process.kill(pid, "SIGCONT");
    }
    this.assertFalse((await this.remote!.command("pane.read", { target: 1 })).text.includes("FROM_LOCAL_VIEW"));
    await this.until(() => screen().includes("▌REMOTE_WORKSPACE") && !screen().includes("Ctrl+R retry"), 12);
    this.terminal.write("AFTER_RECONNECT\r");
    await this.remote!.until(
      async () => (await this.remote!.command("pane.read", { target: 1 })).text.includes("AFTER_RECONNECT"),
      5,
    );
    // Held, it would have gone ahead of the line typed after the outage.
    this.assertNotIn("TYPED_WHILE_OFFLINE", (await this.remote!.command("pane.read", { target: 1 })).text);
  }
  async test_shared_master_and_failed_recovery_handshake_keep_navigation_responsive() {
    await this.command("pane.create", { workspace: 1, command: "stty -echo; cat" });
    await this.remote!.command("pane.create", { workspace: 1, command: "stty -echo; cat" });
    await this.startViewer();
    await this.online();
    await this.sendRemote("BEFORE_MASTER_STALL");
    const shared = this.network!.accepted;
    await this.cli(["--machine", "work", "ping"]);
    await this.cli(["--machine", "work", "ping"]);
    this.assertEqual(this.network!.accepted, shared, "ordinary commands should reuse the viewer's Corgi master");
    this.network!.strandNext(1);
    this.network!.strand();
    await this.until(() => this.text().includes("Connection stalled"), 6);
    this.terminal!.write("DROPPED_DURING_MASTER_STALL\r");
    await this.until(() => this.network!.accepted > shared, 8);
    // The first fresh TCP connection cannot finish SSH either. Local work still responds.
    for (let round = 0; round < 3; round++) {
      const started = performance.now();
      this.terminal!.write("\x1d");
      await this.until(() => this.text().includes("All workspaces"), 1);
      this.terminal!.write("\x1d");
      await this.until(() => !this.text().includes("All workspaces"), 1);
      this.clickWorkspace("LOCAL");
      await this.online("local", 1);
      this.terminal!.write(`LOCAL_WHILE_RECOVERY_HANGS_${round}\r`);
      await this.until(
        async () =>
          (await this.command("pane.read", { target: 1 })).text.includes(`LOCAL_WHILE_RECOVERY_HANGS_${round}`),
        1,
      );
      this.assertLess(performance.now() - started, 2000);
      this.clickWorkspace("REMOTE");
      await Bun.sleep(100);
    }
    await this.until(() => this.network!.accepted > shared + 1, 20);
    await this.online(undefined, 20);
    await this.sendRemote("AFTER_FAILED_RECOVERY");
    // Strand the replacement as well: recovery cannot rely on the original master returning.
    const replacement = this.network!.accepted;
    this.network!.strand();
    await this.until(() => this.text().includes("Connection stalled"), 6);
    await this.until(() => this.network!.accepted > replacement, 8);
    await this.online(undefined, 8);
    await this.sendRemote("AFTER_SECOND_MASTER_STALL");
    const output = (await this.remote!.command("pane.read", { target: 1 })).text;
    for (const marker of ["BEFORE_MASTER_STALL", "AFTER_FAILED_RECOVERY", "AFTER_SECOND_MASTER_STALL"])
      this.assertEqual(output.split(marker).length - 1, 1);
    this.assertNotIn("DROPPED_DURING_MASTER_STALL", output);
  }
  async test_a_pane_exit_with_a_live_stream_keeps_the_machine_usable() {
    await this.remote!.command("pane.create", {
      workspace: 1,
      command: "stty -echo; read -r line; printf 'FINAL_OUTPUT\\n'",
    });
    await this.startViewer();
    await this.online();
    this.terminal!.write("EXIT_NOW\r");
    await this.remote!.until(async () => (await this.remote!.session()).panes.length === 0);
    const { pane } = await this.remote!.command("pane.create", {
      workspace: 1,
      command: "printf 'AFTER_EXIT_READY\\n'; cat",
    });
    await this.until(() => this.text().includes("AFTER_EXIT_READY"));
    this.terminal!.write("AFTER_EXIT_INPUT\r");
    await this.remote!.until(async () =>
      (await this.remote!.command("pane.read", { target: pane })).text.includes("AFTER_EXIT_INPUT"),
    );
    await this.until(() => this.text().includes("AFTER_EXIT_INPUT"));
  }
  async test_remote_reload_rebuilds_the_stream_without_replacing_its_panes() {
    // On a slow link, typing after the reload waits for the same viewer.
    this.network!.latency_ms = 120;
    await this.remote!.command("pane.create", { workspace: 1, command: "stty -echo; cat" });
    await this.startViewer();
    await this.online();
    await this.sendRemote("BEFORE_RELOAD");
    await this.until(() => this.text().includes("BEFORE_RELOAD"));
    const before = (await this.remote!.session()).panes.map((pane: { pid: number }) => pane.pid);
    await this.remote!.rpc({ op: "server.reload", executable: runtime.EXE });
    await this.sendRemote("AFTER_RELOAD");
    await this.until(() => this.text().includes("AFTER_RELOAD"));
    this.assertEqual(
      (await this.remote!.session()).panes.map((pane: { pid: number }) => pane.pid),
      before,
    );
    this.assertEqual((await this.remote!.command("pane.read", { target: 1 })).text.split("AFTER_RELOAD").length - 1, 1);
  }
  async test_typing_while_a_reload_shows_its_notice_is_dropped_not_replayed() {
    await this.remote!.command("pane.create", { workspace: 1, command: "stty -echo; cat" });
    // Over a slow link, the same viewer comes back a while after the notice shows.
    this.network!.cut();
    this.network!.latency_ms = 1000;
    await this.startViewer();
    await this.online(undefined, 60);
    await this.sendRemote("BEFORE_RELOAD");
    await this.remote!.rpc({ op: "server.reload", executable: runtime.EXE });
    await this.until(() => this.text().includes("Reconnecting"), 10);
    this.terminal!.write("DROPPED_DURING_RELOAD\r");
    await this.online(undefined, 60);
    await this.sendRemote("AFTER_RELOAD");
    this.assertNotIn("DROPPED_DURING_RELOAD", (await this.remote!.command("pane.read", { target: 1 })).text);
  }
  async test_short_network_hiccup_shows_stall_drops_input_and_recovers_on_the_same_connection() {
    await this.remote!.command("pane.create", { workspace: 1, command: "stty -echo; printf '\\n\\n\\n'; cat" });
    await this.startViewer();
    await this.online();
    await this.sendRemote("BEFORE_HICCUP");
    await this.until(() => this.text().includes("BEFORE_HICCUP"));
    const connections = this.network!.accepted;
    await this.withholdReply();
    this.terminal!.write("SENT_WITH_REPLY_BLOCKED\r");
    // Input no longer waits for the outstanding screen/command response.
    await this.remote!.until(async () =>
      (await this.remote!.command("pane.read", { target: 1 })).text.includes("SENT_WITH_REPLY_BLOCKED"),
    );
    const started = performance.now();
    await this.until(() => this.text().includes("Connection stalled"), 6);
    this.assertTrue(performance.now() - started < 6000);
    // A stall offers no retry: the link may yet recover.
    this.assertNotIn("Ctrl+R retry", this.text());
    this.assertIn("BEFORE_HICCUP", this.text());
    this.terminal!.write("DROPPED_DURING_HICCUP\r\x1d");
    await this.until(() => this.text().includes("All workspaces"), 1);
    this.network!.set("healthy");
    this.terminal!.write("\x1d");
    await this.online();
    await this.sendRemote("AFTER_HICCUP");
    this.assertEqual(this.network!.accepted, connections);
    const text = (await this.remote!.command("pane.read", { target: 1 })).text;
    this.assertEqual(text.split("SENT_WITH_REPLY_BLOCKED").length - 1, 1);
    this.assertNotIn("DROPPED_DURING_HICCUP", text);
  }
  async test_spotty_connection_repeatedly_recovers_without_freezing_navigation_or_duplicating_input() {
    await this.command("pane.create", { workspace: 1, command: "stty -echo; cat" });
    await this.remote!.command("pane.create", { workspace: 1, command: "stty -echo; cat" });
    // Apply the rate limit to the viewer's new transport, not setup's shared master.
    this.network!.cut();
    this.network!.latency_ms = 80;
    this.network!.bytes_per_second = 128 * 1024;
    await this.startViewer();
    await this.online(undefined, 12);
    const timings: { fault: string; navigation_ms: number; recovery_ms: number }[] = [];
    const markers: string[] = [],
      dropped: string[] = [];
    for (const [index, fault] of ["replies", "blackhole", "strand", "cut", "blackhole"].entries()) {
      const before = `BEFORE_FAULT_${index}`;
      markers.push(before);
      await this.sendRemote(before);
      const started = performance.now();
      switch (fault) {
        case "replies":
          this.network!.set("replies");
          break;
        case "blackhole":
          this.network!.set("blackhole");
          break;
        case "strand":
          this.network!.strand();
          break;
        case "cut":
          this.network!.cut();
          break;
      }
      if (fault !== "cut") {
        await this.until(() => this.text().includes("Connection stalled"), 6);
        this.assertNotIn("Ctrl+R retry", this.text());
        const typed = `DROPPED_WHILE_STALLED_${index}`;
        dropped.push(typed);
        this.terminal!.write(typed + "\r");
      }
      const navigation = performance.now();
      this.terminal!.write("\x1d");
      await this.until(() => this.text().includes("All workspaces"), 1);
      const navigation_ms = performance.now() - navigation;
      this.terminal!.write("\x1d");
      await this.until(() => !this.text().includes("All workspaces"), 1);
      // Explicitly exercise local work while the selected remote cannot answer.
      this.clickWorkspace("LOCAL");
      await this.online("local", 1);
      const local = `LOCAL_DURING_FAULT_${index}`;
      this.terminal!.write(local + "\r");
      await this.until(async () => (await this.command("pane.read", { target: 1 })).text.includes(local), 1);
      if (fault === "replies" || fault === "blackhole") this.network!.set("healthy");
      this.clickWorkspace("REMOTE");
      await this.online(undefined, 12);
      timings.push({
        fault,
        navigation_ms: Math.round(navigation_ms),
        recovery_ms: Math.round(performance.now() - started),
      });
      const after = `AFTER_FAULT_${index}`;
      markers.push(after);
      await this.sendRemote(after);
    }
    const text = (await this.remote!.command("pane.read", { target: 1 })).text;
    for (const marker of markers) this.assertEqual(text.split(marker).length - 1, 1);
    for (const marker of dropped) this.assertNotIn(marker, text);
    console.error("Spotty SSH at 160ms RTT / 128KiB/s:", JSON.stringify(timings));
  }
  async test_typing_whose_reply_a_cut_connection_lost_lands_once_after_the_link_resumes() {
    await this.remote!.command("pane.create", { workspace: 1, command: "stty -echo; cat" });
    await this.startViewer();
    await this.online();
    await this.sendRemote("BEFORE_CUT");
    const connections = this.network!.accepted;
    await this.withholdReply();
    this.terminal!.write("ONCE_ACROSS_THE_CUT\r");
    // The daemon has the input and ran it; only its reply is held back.
    await this.remote!.until(async () =>
      (await this.remote!.command("pane.read", { target: 1 })).text.includes("ONCE_ACROSS_THE_CUT"),
    );
    this.network!.cut();
    this.network!.set("healthy");
    await this.until(() => this.network!.accepted > connections, 5);
    await this.online(undefined, 12);
    await this.sendRemote("AFTER_RESUME");
    const text = (await this.remote!.command("pane.read", { target: 1 })).text;
    this.assertEqual(text.split("ONCE_ACROSS_THE_CUT").length - 1, 1);
    this.assertNotIn("Connection lost", this.text());
  }
  async test_typing_a_cut_connection_never_delivered_lands_after_the_link_resumes() {
    await this.remote!.command("pane.create", { workspace: 1, command: "stty -echo; cat" });
    await this.startViewer();
    await this.online();
    await this.sendRemote("BEFORE_BLACKHOLE");
    const connections = this.network!.accepted;
    this.network!.set("blackhole");
    // Typed before the stall shows, so the viewer sends it into the void.
    this.terminal!.write("LANDS_AFTER_RESUME\r");
    // The learned stall budget can reach 30 s; the notice waits another second.
    await this.until(() => this.text().includes("Connection stalled"), 35).catch(error => {
      throw new Error(`Expected the remote to stall:\n${this.text()}`, { cause: error });
    });
    this.assertNotIn("LANDS_AFTER_RESUME", (await this.remote!.command("pane.read", { target: 1 })).text);
    this.network!.cut();
    this.network!.set("healthy");
    await this.until(() => this.network!.accepted > connections, 5);
    await this.online(undefined, 12);
    await this.remote!.until(async () =>
      (await this.remote!.command("pane.read", { target: 1 })).text.includes("LANDS_AFTER_RESUME"),
    );
    await this.sendRemote("AFTER_RESUME");
    const text = (await this.remote!.command("pane.read", { target: 1 })).text;
    this.assertEqual(text.split("LANDS_AFTER_RESUME").length - 1, 1);
  }
  async test_a_hung_reconnect_is_raced_without_waiting_for_the_ssh_timeout() {
    await this.remote!.command("pane.create", { workspace: 1, command: "stty -echo; cat" });
    await this.startViewer();
    await this.online();
    await this.sendRemote("BEFORE_HUNG_RECONNECT");
    const pid = (await this.remote!.session()).panes[0].pid;
    const connections = this.network!.accepted;
    this.network!.strandNext(1);
    this.network!.cut();
    await this.until(() => this.network!.accepted > connections, 5);
    const started = performance.now();
    // Both reconnect lanes open immediately; the next connection is the spare.
    await this.until(() => this.network!.accepted > connections + 2, 12);
    await this.online(undefined, 5);
    this.assertLess(performance.now() - started, 14000);
    await this.sendRemote("AFTER_HUNG_RECONNECT");
    this.assertEqual((await this.remote!.session()).panes[0].pid, pid);
    const output = (await this.remote!.command("pane.read", { target: 1 })).text;
    this.assertEqual(output.split("AFTER_HUNG_RECONNECT").length - 1, 1);
  }
  async test_a_network_change_is_raced_without_waiting_for_the_timeout_and_typing_lands_once() {
    await this.remote!.command("pane.create", { workspace: 1, command: "stty -echo; cat" });
    await this.startViewer();
    await this.online();
    await this.sendRemote("BEFORE_CHANGE");
    const connections = this.network!.accepted;
    const started = performance.now();
    this.network!.strand();
    // Typed before the stall shows: it goes into the dead connection.
    this.terminal!.write("RACED_THROUGH\r");
    await this.until(() => this.network!.accepted > connections, 10);
    await this.online(undefined, 8);
    // Quicker than the old connection's twelve-second minimum request timeout.
    this.assertLess(performance.now() - started, 11500);
    await this.remote!.until(async () =>
      (await this.remote!.command("pane.read", { target: 1 })).text.includes("RACED_THROUGH"),
    );
    await this.sendRemote("AFTER_CHANGE");
    const text = (await this.remote!.command("pane.read", { target: 1 })).text;
    this.assertEqual(text.split("RACED_THROUGH").length - 1, 1);
  }
  async test_blackhole_times_out_and_reconnects_automatically_dropping_input_typed_while_stalled() {
    await this.remote!.command("pane.create", { workspace: 1, command: "stty -echo; cat" });
    const pid = (await this.remote!.rpc({ op: "hello", protocol: 1 })).server_pid;
    await this.startViewer();
    await this.online();
    const connections = this.network!.accepted;
    this.network!.set("blackhole");
    await this.until(() => this.text().includes("Connection stalled"), 6);
    this.terminal!.write("DROPPED_DURING_BLACKHOLE\r");
    // A second connection is tried beside the silent one, and again once it times out.
    await this.until(() => this.network!.accepted > connections, 12);
    this.network!.set("healthy");
    await this.online(undefined, 12);
    await this.sendRemote("AUTOMATICALLY_RECOVERED");
    const text = (await this.remote!.command("pane.read", { target: 1 })).text;
    this.assertNotIn("DROPPED_DURING_BLACKHOLE", text);
    this.assertEqual((await this.remote!.rpc({ op: "hello", protocol: 1 })).server_pid, pid);
  }
  async test_pause_and_retry_abort_an_inflight_request_and_a_hung_ssh_handshake_immediately() {
    await this.remote!.command("pane.create", { workspace: 1, command: "cat" });
    await this.startViewer();
    await this.online();
    this.network!.set("blackhole");
    await this.until(() => this.text().includes("Connection stalled"), 6);
    // Stalled, the machine still has its keys; the dropdown retries and pauses.
    const dropdown = async (keys: string) => {
      this.terminal!.write("\x1d");
      await this.until(() => this.text().includes("All workspaces"), 1);
      this.terminal!.write("w" + keys + "\x1b");
      // Closed before anything else is typed, so the Escape isn't read as Alt.
      await this.until(() => !this.text().includes("All workspaces"), 1);
    };
    const stalled = this.network!.accepted;
    await dropdown("\x12");
    await this.until(() => this.network!.accepted > stalled, 2);
    await dropdown("\x18");
    await this.until(() => this.text().includes("Paused · automatic retries stopped"), 1);
    // Paused, it can't be reached: the notice takes them.
    const connections = this.network!.accepted;
    this.terminal!.write("\x12");
    await this.until(() => this.network!.accepted > connections, 2);
    await this.until(() => this.text().includes("Reconnecting"), 1);
    const attempt = this.network!.accepted;
    await dropdown("\x12");
    await this.until(() => this.network!.accepted > attempt, 2);
    await dropdown("\x18");
    await this.until(() => this.text().includes("Paused · automatic retries stopped"), 1);
    const paused = this.network!.accepted;
    this.network!.set("healthy");
    // The automatic retry interval is real time; a paused endpoint must remain idle past it.
    await Bun.sleep(1500);
    this.assertEqual(this.network!.accepted, paused);
    this.assertIn("Paused", this.text());
    this.terminal!.write("\x12");
    await this.online();
    await this.sendRemote("AFTER_MANUAL_RETRY");
  }
  async test_dropdown_retry_bypasses_backoff_and_repeated_disconnects_do_not_mix_generations() {
    await this.remote!.command("pane.create", { workspace: 1, command: "cat" });
    await this.startViewer();
    await this.online();
    for (let i = 0; i < 3; i++) {
      const connections = this.network!.accepted;
      this.network!.cut();
      // The first retry goes at once.
      await this.until(() => this.network!.accepted > connections, 3);
      this.terminal!.write("\x1d");
      await this.until(() => this.text().includes("All workspaces"), 1);
      this.terminal!.write("w\x12\x1b");
      await this.online();
      await this.sendRemote(`RECOVERY_${i}`);
    }
    this.network!.set("blackhole");
    await this.until(() => this.text().includes("Connection stalled"), 6);
    // The prefix still detaches while stalled.
    this.terminal!.write("\x02d");
    await deadline(this.ui!.exited, 1500);
    this.assertEqual(this.ui!.exitCode, 0);
    this.assertEqual((await this.remote!.session()).panes.length, 1);
  }
  async test_restarted_daemon_uses_fresh_surfaces_and_does_not_replay_into_reused_pane_ids() {
    await this.remote!.command("pane.create", { workspace: 1, command: "cat" });
    await this.startViewer();
    await this.online();
    await this.sendRemote("OLD_DAEMON_FRAME");
    await this.until(() => this.text().includes("OLD_DAEMON_FRAME"));
    const instance = (await this.remote!.rpc({ op: "hello", protocol: 1 })).instance;
    this.network!.set("blackhole");
    // Restart isolation also holds when startup has raised the adaptive stall budget to 30 s.
    await this.until(() => this.text().includes("Connection stalled"), 35);
    this.terminal!.write("OLD_DAEMON_INPUT\r");
    await this.remote!.run_cli("shutdown");
    await this.remote!.until(() => !fs.existsSync(this.remote!.path));
    // A fresh daemon with no checkpoint can reuse IDs; only erase this disposable runtime's recovery.
    fs.rmSync(join(this.remote!.env.XDG_STATE_HOME!, "corgi/recovery"), { recursive: true, force: true });
    await this.remote!.run_cli("start");
    const pane = await this.remote!.command("pane.create", { workspace: 1, command: "cat" });
    this.assertEqual(pane.pane, 1);
    await this.remote!.command("workspace.edit", { target: 1, name: "REMOTE_WORKSPACE" });
    this.assertNotEqual((await this.remote!.rpc({ op: "hello", protocol: 1 })).instance, instance);
    this.network!.cut();
    this.network!.set("healthy");
    await this.online(undefined, 12);
    await this.sendRemote("NEW_DAEMON_FRAME");
    this.assertNotIn("OLD_DAEMON_FRAME", this.text());
    this.assertNotIn("OLD_DAEMON_INPUT", (await this.remote!.command("pane.read", { target: 1 })).text);
  }
  async test_paste_started_before_an_outage_finishes_after_it() {
    await this.remote!.command("pane.create", { workspace: 1, command: "stty raw -echo; cat" });
    await this.startViewer();
    await this.online();
    this.terminal!.write("\x1b[200~PASTE_START");
    await this.remote!.until(async () =>
      (await this.remote!.command("pane.read", { target: 1 })).text.includes("PASTE_START"),
    );
    const connections = this.network!.accepted;
    this.network!.cut();
    await this.until(() => this.network!.accepted > connections, 3);
    await this.online(undefined, 12);
    // Even shortcut bytes in the paste remain data until its end marker.
    this.terminal!.write("PASTE_TAIL_LANDS\x1d\x03\x12\x1b[201~");
    await this.sendRemote("AFTER_PASTE");
    const text = (await this.remote!.command("pane.read", { target: 1 })).text;
    this.assertEqual(text.split("PASTE_TAIL_LANDS").length - 1, 1);
    this.assertFalse(this.text().includes("All workspaces"));
  }
}
registerCase("SSH machines", Remote, {
  timeout: 60_000,
  skip: !Bun.which("sshd") || !Bun.which("ssh-keygen") ? "OpenSSH server tools are required" : false,
});
