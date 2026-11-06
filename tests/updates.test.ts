// Copies of the test binary play four releases in isolated runtimes; no host
// installation is touched. A test build at releases/<v>/corgi is release <v>.
import { beforeAll, afterAll, beforeEach, afterEach, test, expect } from "bun:test";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm, symlink } from "node:fs/promises";
import { closeSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { EXE, Lines, Pty, deadline, versioned } from "./support";
import { running } from "./runtime";
import { installer, manifests as releaseManifests } from "../scripts/publish.ts";
import { Scope } from "../scripts/process_scope";
import { flock } from "../src/native_bridge";
import * as updates from "../src/updates";
let base: string;
const keys = generateKeyPairSync("ed25519");
const publicKey = Buffer.from(keys.publicKey.export({ type: "spki", format: "der" }))
  .subarray(-32)
  .toString("hex");
let latest = "1.0.1",
  invalid = false,
  corrupt = false,
  unavailable = false,
  badAbi = false;
let requests = 0;
let beforeDownload: (() => Promise<void>) | null = null;
const binaries = new Map<string, Uint8Array>();
const manifests = new Map<string, string>();
// The manifest a release serves this platform, chosen as the updater does (every Mac is
// macos-aarch64); CORGI_OLD_EXE may predate the others' targets.
const host =
    process.platform === "darwin" ? "macos-aarch64" : process.arch === "arm64" ? "linux-aarch64" : "linux-x86_64",
  feed = releaseManifests.find(m => (m.targets as readonly string[]).includes(host))!;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    requests++;
    if (unavailable) return new Response("unavailable", { status: 503 });
    const path = new URL(req.url).pathname;
    if (path === `/${feed.channel}`) {
      const envelope = JSON.parse(manifests.get(latest)!);
      if (badAbi) {
        const payload = JSON.parse(envelope.payload);
        payload.update_abi = "incompatible";
        envelope.payload = JSON.stringify(payload);
        envelope.signature = sign(null, Buffer.from(envelope.payload), keys.privateKey).toString("hex");
      }
      if (invalid) envelope.signature = "00".repeat(64);
      return Response.json(envelope);
    }
    const v = path.split("/")[2];
    // A release's own manifest, which a plugin's pin names.
    if (path === `/releases/${v}/${feed.name}` && manifests.has(v)) return new Response(manifests.get(v)!);
    if (path.endsWith("/corgi")) {
      await beforeDownload?.();
      const binary = binaries.get(v);
      return new Response(corrupt ? new Uint8Array([0, 1]) : binary && new Uint8Array(binary));
    }
    return new Response("missing", { status: 404 });
  },
});
const url = `http://127.0.0.1:${server.port}`;
const feedEnv = { CORGI_TEST_UPDATE_URL: url, CORGI_TEST_UPDATE_KEY: publicKey };
const fixture = (v: string) => join(base, "releases", v, "corgi");
let home: string, root: string, bin: string, env: Record<string, string>, socket: string;
let scope: Scope;
async function exec(argv: string[], extraEnv = env, ok = true) {
  const p = Bun.spawn(argv, { env: extraEnv, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (ok && code) throw new Error(`${argv.join(" ")}: ${code}\n${out}\n${err}`);
  return { out, err, code };
}
async function cli(args: string[], ok = true) {
  return exec([bin, ...args], env, ok);
}
async function rpc(value: { op: string; [field: string]: unknown }) {
  return JSON.parse((await cli(["rpc", JSON.stringify(versioned(value))])).out);
}
async function waitFor(fn: () => Promise<boolean>) {
  for (let i = 0; i < 150; i++) {
    if (await fn()) return;
    await Bun.sleep(100);
  }
  throw new Error("Timed out");
}
beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "corgi-updates-"));
  const current = await readFile(EXE);
  for (const v of ["1.0.0", "1.0.1", "1.0.2", "1.0.3"]) {
    const binary = v === "1.0.0" && process.env.CORGI_OLD_EXE ? await readFile(process.env.CORGI_OLD_EXE) : current;
    await mkdir(dirname(fixture(v)), { recursive: true });
    await writeFile(fixture(v), binary, { mode: 0o755 });
    binaries.set(v, binary);
    const info = JSON.parse(
      (await exec([fixture(v), "__update-info"], { ...process.env, ...feedEnv } as Record<string, string>)).out,
    );
    if (info.version !== v || !info.test_mode)
      throw new Error(`${EXE} is not a -Dtest-build binary; set CORGI_TEST_BIN (see tests/README.md)`);
    const target = { url: `${url}/releases/${v}/corgi`, sha256: sha(binary), size: binary.length };
    const payload = JSON.stringify({
      schema_version: 1,
      commit: info.commit,
      version: v,
      update_abi: info.update_abi,
      targets: Object.fromEntries(feed.targets.map(name => [name, target])),
    });
    manifests.set(
      v,
      JSON.stringify({ payload, signature: sign(null, Buffer.from(payload), keys.privateKey).toString("hex") }),
    );
  }
}, 30_000);
beforeEach(async () => {
  scope = await Scope.start();
  latest = "1.0.1";
  invalid = corrupt = unavailable = badAbi = false;
  requests = 0;
  beforeDownload = null;
  home = await mkdtemp("/tmp/cu-");
  root = join(home, "install");
  bin = join(home, "bin/corgi");
  socket = join(home, "runtime/control.sock");
  env = {
    ...scope.env,
    HOME: home,
    XDG_STATE_HOME: join(home, "state"),
    CODEX_HOME: join(home, ".codex"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CORGI_SOCKET: socket,
    SHELL: "/bin/sh",
    CORGI_PANE: "",
    ...feedEnv,
  } as Record<string, string>;
  delete env.CORGI_PANE;
  const manifest = join(home, "manifest.json");
  await writeFile(manifest, manifests.get("1.0.0")!);
  await exec([fixture("1.0.0"), "__install", root, manifest]);
  // The installer writes the launcher.
  const script = installer(url, "1.0.0", {
    "macos-aarch64": { sha256: "", size: 1 },
    "linux-x86_64": { sha256: "", size: 1 },
    "linux-aarch64": { sha256: "", size: 1 },
  });
  await exec(["/bin/sh", "-c", script.replace(/\nmain "\$@"\n$/, "\nwrite_launcher\n")], {
    ...env,
    CORGI_INSTALL_ROOT: root,
    CORGI_INSTALL_BIN: bin,
  });
  await cli(["update", "auto", "off"]);
}, 30_000);
afterEach(async () => {
  try {
    // A launcher whose installation a test deleted removes itself when run.
    for (const args of [["update", "auto", "off"], ["shutdown"]])
      if (await Bun.file(bin).exists()) await cli(args, false);
  } finally {
    await scope.assertClean();
  }
  await rm(home, { recursive: true, force: true });
}, 30_000);
afterAll(async () => {
  server.stop(true);
  await rm(base, { recursive: true, force: true });
});
test("explicit update preserves real pane PID and supports rollback", async () => {
  await cli(["start"]);
  const oldProtocol = (await rpc({ op: "hello", protocol: 1 })).protocol;
  const session = await rpc({ op: "session.snapshot", protocol: oldProtocol });
  await rpc({
    op: "session.command",
    protocol: oldProtocol,
    command: { "pane.create": { workspace: session.workspaces[0].id, cwd: home, command: "exec /bin/sh" } },
  });
  const before = await rpc({ op: "session.snapshot", protocol: oldProtocol });
  const pane = before.panes[0].id;
  await rpc({
    op: "session.command",
    protocol: oldProtocol,
    command: { "pane.input": { target: pane, data: "printf 'BEFORE_UPDATE\\n'\r" } },
  });
  await waitFor(async () =>
    (
      await rpc({
        op: "session.command",
        protocol: oldProtocol,
        command: { "pane.read": { target: pane, view: "screen" } },
      })
    ).result.text.includes("BEFORE_UPDATE"),
  );
  await cli(["update"]);
  const after = await rpc({ op: "session.snapshot" });
  expect(after.server_pid).not.toBe(before.server_pid);
  expect(after.panes[0].pid).toBe(before.panes[0].pid);
  await rpc({
    op: "session.command",
    command: { "pane.input": { target: pane, data: "printf 'AFTER_UPDATE\\n'\r" } },
  });
  await waitFor(async () =>
    (
      await rpc({ op: "session.command", command: { "pane.read": { target: pane, view: "screen" } } })
    ).result.text.includes("AFTER_UPDATE"),
  );
  expect(await readFile(join(root, "current"), "utf8")).toBe("1.0.1");
  await cli(["update", "rollback"]);
  expect(await readFile(join(root, "current"), "utf8")).toBe("1.0.0");
  expect(await readFile(join(root, "suppressed"), "utf8")).toBe("1.0.1");
  const rollbackProtocol = (await rpc({ op: "hello", protocol: 1 })).protocol;
  expect((await rpc({ op: "session.snapshot", protocol: rollbackProtocol })).panes[0].pid).toBe(before.panes[0].pid);
}, 30_000);
test("a newer download replaces the update waiting before it", async () => {
  await cli(["update", "--download-only"]);
  latest = "1.0.2";
  await cli(["update", "--download-only"]);
  expect(await readFile(join(root, "staged"), "utf8")).toBe("1.0.2");
  expect((await readdir(join(root, "releases"))).sort()).toEqual(["1.0.0", "1.0.2"]);
  // A stale feed doesn't take it back.
  latest = "1.0.1";
  await cli(["update", "--download-only"]);
  expect(await readFile(join(root, "staged"), "utf8")).toBe("1.0.2");
  expect((await readdir(join(root, "releases"))).sort()).toEqual(["1.0.0", "1.0.2"]);
}, 30_000);
test("an installer staging a newer release during a download keeps its update", async () => {
  latest = "1.0.2";
  beforeDownload = async () => {
    const manifest = join(home, "newer-manifest.json");
    await writeFile(manifest, manifests.get("1.0.3")!);
    await exec([fixture("1.0.3"), "__install", root, manifest]);
  };
  await cli(["update", "--download-only"]);
  expect(await readFile(join(root, "staged"), "utf8")).toBe("1.0.3");
  expect((await readdir(join(root, "releases"))).sort()).toEqual(["1.0.0", "1.0.3"]);
}, 30_000);
test("a newer activation can supersede a download without deleting files it is writing", async () => {
  latest = "1.0.2";
  beforeDownload = async () => {
    expect(await readdir(join(root, "releases"))).not.toContain("1.0.2");
    const manifest = join(home, "newer-manifest.json");
    await writeFile(manifest, manifests.get("1.0.3")!);
    await exec([fixture("1.0.3"), "__install", root, manifest]);
    await rm(join(root, "auto-off"));
    await cli(["start"]);
    await cli(["update", "auto", "off"]);
  };
  await cli(["update", "--download-only"]);
  expect(await readFile(join(root, "current"), "utf8")).toBe("1.0.3");
  expect((await readdir(join(root, "releases"))).sort()).toEqual(["1.0.0", "1.0.3"]);
  expect(await Bun.file(join(root, "staged")).exists()).toBe(false);
}, 30_000);
test("runtime registration and release cleanup share a guard", async () => {
  const manifest = join(home, "newer-manifest.json");
  await writeFile(manifest, manifests.get("1.0.2")!);
  await exec([fixture("1.0.2"), "__install", root, manifest]);
  await writeFile(join(root, "current"), "1.0.2");
  const exe = join(root, "releases/1.0.0/corgi"),
    guard = openSync(join(root, "releases.lock"), "a"),
    source = `
      import * as updates from ${JSON.stringify(join(import.meta.dir, "../src/updates.ts"))};
      const pending = updates.hold(${JSON.stringify(exe)});
      console.log("registering");
      await pending;
      console.log("held");
      await Bun.stdin.text();
    `;
  expect(flock(guard)).toBe(true);
  const runtime = Bun.spawn([process.execPath, "-e", source], {
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }),
    lines = new Lines(),
    output = (async () => {
      for await (const chunk of runtime.stdout) lines.feed(Buffer.from(chunk).toString());
      lines.end();
    })();
  try {
    expect(await lines.next()).toBe("registering");
    expect((await readdir(dirname(exe))).filter(name => name.startsWith("runtime-"))).toEqual([]);
    flock(guard, false);
    expect(await lines.next()).toBe("held");
    updates.prune(root);
    expect(await Bun.file(exe).exists()).toBe(true);
  } finally {
    closeSync(guard);
    runtime.stdin.end();
    await deadline(runtime.exited, 5000);
    await output;
  }
  updates.prune(root);
  expect(await Bun.file(exe).exists()).toBe(false);
  const missing = await exec([process.execPath, "-e", source], env, false);
  expect(missing.code).not.toBe(0);
  expect(missing.err).toContain("MissingInstalledVersion");
}, 30_000);
test("pane commands use their socket's release through the stable launcher", async () => {
  await cli(["update", "--download-only"]);
  await writeFile(join(root, "current"), "1.0.1");
  const target = join(root, "releases/1.0.0/corgi"),
    asked: unknown[] = [],
    daemon = createServer(peer => {
      peer.on("data", chunk => {
        asked.push(JSON.parse(chunk.toString()));
        // A retained runtime can speak an older protocol and reply without request ids.
        peer.write(JSON.stringify({ ok: true, protocol: 3, executable: target }) + "\n");
      });
    });
  await mkdir(dirname(socket), { recursive: true });
  await new Promise<void>(resolve => daemon.listen(socket, resolve));
  await writeFile(target, `#!/bin/sh\nprintf '%s\\n' "$CORGI_APP_EXE" "$@"\n`, { mode: 0o700 });
  try {
    const launcher = join(root, "bin/corgi");
    // Asking for hook snippets creates the same launcher that panes inherit.
    await cli(["hooks", "claude"]);
    const paneEnv = { ...env, CORGI_PANE: "1" };
    for (const args of [["list"], ["--no-agent", "list"], ["pane", "read", "--contains", "a b"]]) {
      const result = await exec([launcher, ...args], paneEnv);
      expect(result.out).toBe([target, ...args, ""].join("\n"));
    }
    expect(asked).toEqual([versioned({ op: "hello" }), versioned({ op: "hello" }), versioned({ op: "hello" })]);
  } finally {
    await new Promise<void>(resolve => daemon.close(() => resolve()));
  }
}, 30_000);
test("reload from a pane uses the selected executable as its default target", async () => {
  await cli(["start"]);
  await cli(["update", "--download-only"]);
  const target = join(root, "releases/1.0.1/corgi");
  await exec([target, "reload"], { ...env, CORGI_PANE: "1" });
  expect((await rpc({ op: "hello" })).executable).toBe(await realpath(target));
}, 30_000);
test("background download stages without activating, next start works offline", async () => {
  await cli(["start"]);
  const old = await rpc({ op: "hello" });
  await cli(["update", "auto", "on"]);
  await waitFor(
    async () =>
      (await Bun.file(join(root, "staged"))
        .text()
        .catch(() => "")) === "1.0.1",
  );
  expect(await readFile(join(root, "current"), "utf8")).toBe("1.0.0");
  expect((await rpc({ op: "hello" })).server_pid).toBe(old.server_pid);
  unavailable = true;
  await cli(["start"]);
  expect(await readFile(join(root, "current"), "utf8")).toBe("1.0.1");
}, 30_000);
test("installing over an older release stages it for the next start", async () => {
  const manifest = join(home, "manifest.json");
  await writeFile(manifest, manifests.get("1.0.1")!);
  await exec([fixture("1.0.1"), "__install", root, manifest]);
  expect(await readFile(join(root, "staged"), "utf8")).toBe("1.0.1");
  expect(await readFile(join(root, "current"), "utf8")).toBe("1.0.0");
  await writeFile(manifest, manifests.get("1.0.0")!);
  expect((await exec([fixture("1.0.0"), "__install", root, manifest], env, false)).err).toContain("AlreadyInstalled");
  await cli(["update", "auto", "on"]);
  unavailable = true;
  await cli(["start"]);
  expect(await readFile(join(root, "current"), "utf8")).toBe("1.0.1");
}, 30_000);
test("signature and checksum failures leave installation and runtime untouched", async () => {
  await cli(["start"]);
  const before = await rpc({ op: "hello" });
  invalid = true;
  expect((await cli(["update"], false)).code).not.toBe(0);
  invalid = false;
  corrupt = true;
  expect((await cli(["update"], false)).code).not.toBe(0);
  expect(await readFile(join(root, "current"), "utf8")).toBe("1.0.0");
  expect((await rpc({ op: "hello" })).server_pid).toBe(before.server_pid);
  expect(await Bun.file(join(root, "staged")).exists()).toBe(false);
}, 30_000);
test("incompatible update defers noninteractively and keeps running executable", async () => {
  await cli(["start"]);
  const before = await rpc({ op: "hello" });
  badAbi = true;
  const result = await cli(["update"], false);
  expect(result.code).not.toBe(0);
  expect(result.err).toContain("UpdateDeferred");
  expect((await rpc({ op: "hello" })).server_pid).toBe(before.server_pid);
  expect(await readFile(join(root, "current"), "utf8")).toBe("1.0.0");
}, 30_000);
test("help and ordinary RPC never check the network; auto off prevents activation", async () => {
  await cli(["update", "--download-only"]);
  requests = 0;
  await cli(["--help"]);
  await cli(["--version"]);
  await cli(["start"]);
  await rpc({ op: "hello" });
  expect(requests).toBe(0);
  expect(await readFile(join(root, "current"), "utf8")).toBe("1.0.0");
}, 30_000);
test("cold activation starts the staged runtime before changing the current pointer", async () => {
  await cli(["update", "--download-only"]);
  // Enabling automatic updates without a runtime does not require a network wait.
  await cli(["update", "auto", "on"]);
  unavailable = true;
  await cli(["start"]);
  expect(await readFile(join(root, "current"), "utf8")).toBe("1.0.1");
  expect((await rpc({ op: "hello" })).release_version).toBe("1.0.1");
}, 30_000);
test("interactive Escape skips once per runtime without stopping processes", async () => {
  await cli(["start"]);
  const before = await rpc({ op: "hello" });
  badAbi = true;
  await cli(["update", "--download-only"]);
  await cli(["update", "auto", "on"]);
  const terminal = await Pty.spawn([bin, "start"], { env });
  try {
    await terminal.waitFor("Enter / Esc", 10_000);
    terminal.write("\x1b");
    expect(await deadline(terminal.proc.exited, 3000, "Escape did not exit the update prompt")).toBe(0);
    expect(terminal.output).toContain("Restarting will stop ALL shells");
  } finally {
    await terminal.close();
  }
  expect((await rpc({ op: "hello" })).server_pid).toBe(before.server_pid);
  expect((await cli(["start"])).err).not.toContain("Enter / Esc");
  expect(await readFile(join(root, "current"), "utf8")).toBe("1.0.0");
}, 30_000);
test.skipIf(!!process.env.CORGI_OLD_EXE)(
  "a release that can't load the saved state is held back for an hour",
  async () => {
    await cli(["start"]);
    await cli(["shutdown"]);
    const saved = join(home, "state/corgi/recovery", `runtime-${Bun.hash.wyhash(socket, 0n).toString(16)}.json`),
      state = JSON.parse(await readFile(saved, "utf8"));
    state.next_workspace = 1;
    await writeFile(saved, JSON.stringify(state));
    await cli(["update", "--download-only"]);
    const result = await cli(["update"], false);
    expect(result.code).not.toBe(0);
    expect(result.err).toContain("UpdateCheckFailed");
    expect(await readFile(join(root, "current"), "utf8")).toBe("1.0.0");
    const failed = JSON.parse(await readFile(join(root, "check-failed"), "utf8"));
    expect(failed.version).toBe("1.0.1");
    // Within the hour a start doesn't try it again.
    await cli(["update", "auto", "on"]);
    unavailable = true;
    await cli(["start"], false);
    expect(await readFile(join(root, "current"), "utf8")).toBe("1.0.0");
    expect(JSON.parse(await readFile(join(root, "check-failed"), "utf8")).at).toBe(failed.at);
  },
  30_000,
);
test("deleting the installation sends the corgi off in viewers and stops the runtime", async () => {
  const terminal = await Pty.spawn([bin], { env });
  try {
    await terminal.waitFor("\x1b[?1049h", 15_000);
    await waitFor(async () => (await rpc({ op: "hello" })).server_pid > 0);
    // The notice goes to viewers already attached.
    await waitFor(async () => ((await rpc({ op: "viewer.list" })).viewers ?? []).length > 0);
    await rm(root, { recursive: true, force: true });
    await terminal.waitFor("Corgi was uninstalled.", 10_000);
    expect(await deadline(terminal.proc.exited, 10_000, "the viewer kept running")).toBe(0);
  } finally {
    await terminal.close();
  }
  const hello = await exec([fixture("1.0.1"), "rpc", JSON.stringify(versioned({ op: "hello" }))], env, false);
  expect(hello.code).not.toBe(0);
  // Saved sessions stay, as an uninstall keeps them.
  expect(
    await Bun.file(
      join(home, "state/corgi/recovery", `runtime-${Bun.hash.wyhash(socket, 0n).toString(16)}.json`),
    ).exists(),
  ).toBe(true);
}, 40_000);
test("removing the Omarchy plugin that installed Corgi uninstalls it, viewers and all", async () => {
  const plugin = join(home, "plugins", "corgi.computer"),
    script = join(plugin, "install.sh"),
    alias = join(home, "install-alias"),
    other = join(home, ".local/share/corgi"),
    otherBin = join(home, ".local/bin/corgi"),
    otherLauncher = `#!/bin/sh\nroot='${other}'\nexec "$root/releases/$v/corgi" "$@"\n`;
  await mkdir(plugin, { recursive: true });
  await writeFile(join(plugin, "manifest.json"), "{}");
  await mkdir(other, { recursive: true });
  await mkdir(dirname(otherBin), { recursive: true });
  await writeFile(join(other, "current"), "another-install");
  await writeFile(otherBin, otherLauncher);
  const body = installer(url, "1.0.0", {
    "macos-aarch64": { sha256: "", size: 1 },
    "linux-x86_64": { sha256: "", size: 1 },
    "linux-aarch64": { sha256: "", size: 1 },
  });
  await writeFile(script, body);
  // The executable resolves the alias, as macOS resolves /tmp to /private/tmp.
  await symlink(root, alias, "dir");
  // Only the install sees these overrides; the daemon starts without them.
  await exec(["/bin/sh", "-c", body.replace(/\nmain "\$@"\n$/, "\nwrite_launcher\nremember_plugin\n"), script], {
    ...env,
    CORGI_INSTALL_ROOT: alias,
    CORGI_INSTALL_BIN: bin,
    CORGI_INSTALL_PLUGIN: plugin,
  });
  expect((await cli(["update", "status"])).err).toContain(`Installed by the Omarchy plugin in ${plugin}`);
  const terminal = await Pty.spawn([bin], { env });
  try {
    await terminal.waitFor("\x1b[?1049h", 15_000);
    await waitFor(async () => ((await rpc({ op: "viewer.list" })).viewers ?? []).length > 0);
    // `omarchy plugin remove`.
    await rm(plugin, { recursive: true, force: true });
    await terminal.waitFor("Corgi was uninstalled.", 10_000);
    expect(await deadline(terminal.proc.exited, 10_000, "the viewer kept running")).toBe(0);
  } finally {
    await terminal.close();
  }
  // The saved installer removes its original paths, leaving the default install alone.
  await waitFor(async () => !(await Bun.file(join(root, "current")).exists()));
  expect(await Bun.file(bin).exists()).toBe(false);
  expect(await readFile(join(other, "current"), "utf8")).toBe("another-install");
  expect(await readFile(otherBin, "utf8")).toBe(otherLauncher);
  const hello = await exec([fixture("1.0.1"), "rpc", JSON.stringify(versioned({ op: "hello" }))], env, false);
  expect(hello.code).not.toBe(0);
}, 40_000);
test("a plugin removed while Corgi wasn't running leaves Corgi installed", async () => {
  await writeFile(join(root, "plugin"), join(home, "plugins", "corgi.computer") + "\n");
  await cli(["start"]);
  await waitFor(async () => !(await Bun.file(join(root, "plugin")).exists()));
  expect((await rpc({ op: "hello" })).server_pid).toBeGreaterThan(0);
  expect(await Bun.file(join(root, "current")).exists()).toBe(true);
}, 40_000);
test("two simultaneous starts activate once; a second runtime catches up later", async () => {
  await cli(["start"]);
  const secondEnv = { ...env, CORGI_SOCKET: join(home, "second/control.sock") };
  await exec([bin, "start"], secondEnv);
  try {
    await cli(["update", "--download-only"]);
    await cli(["update", "auto", "on"]);
    await Promise.all([cli(["start"]), cli(["start"])]);
    expect(await readFile(join(root, "current"), "utf8")).toBe("1.0.1");
    // The staged marker was consumed, but current still tells the older runtime
    // what it should adopt on its own next launch.
    await exec([bin, "start"], secondEnv);
    const info = JSON.parse((await exec([bin, "rpc", JSON.stringify(versioned({ op: "hello" }))], secondEnv)).out);
    expect(info.release_version).toBe("1.0.1");
  } finally {
    await exec([bin, "shutdown"], secondEnv, false);
  }
}, 30_000);
test("updates remove releases two behind, except one another runtime runs", async () => {
  const secondEnv = { ...env, CORGI_SOCKET: join(home, "second/control.sock") },
    installed = async () => (await readdir(join(root, "releases"))).sort(),
    hello = async (e: Record<string, string>) =>
      JSON.parse((await exec([bin, "rpc", JSON.stringify(versioned({ op: "hello" }))], e)).out);
  // Waits for the runtime it replaced to exit, letting go of its release.
  async function update(e: Record<string, string>, ...args: string[]) {
    const old = (await hello(e)).server_pid;
    await exec([bin, "update", ...args], e);
    await waitFor(async () => !running(old));
  }
  await cli(["start"]);
  await exec([bin, "start"], secondEnv);
  try {
    await update(env);
    await update(secondEnv);
    const session = await rpc({ op: "session.snapshot" });
    await rpc({
      op: "session.command",
      command: { "pane.create": { workspace: session.workspaces[0].id, cwd: home, command: "exec /bin/sh" } },
    });
    const pane = (await rpc({ op: "session.snapshot" })).panes[0].id;
    latest = "1.0.2";
    await update(env);
    expect(await installed()).toEqual(["1.0.1", "1.0.2"]);
    latest = "1.0.3";
    await update(env);
    expect(await installed()).toEqual(["1.0.1", "1.0.2", "1.0.3"]);
    const second = (await hello(secondEnv)).server_pid;
    await exec([bin, "shutdown"], secondEnv);
    await waitFor(async () => !running(second));
    await update(env, "rollback");
    expect(await installed()).toEqual(["1.0.2", "1.0.3"]);
    // The pane opened under 1.0.1 still finds the CLI, as do hooks. Corgi
    // resolves its own path, and macOS's /tmp is a link to /private/tmp.
    const launcher = join(await realpath(root), "bin/corgi");
    await rpc({
      op: "session.command",
      command: {
        "pane.input": {
          target: pane,
          data: `corgi --version >/dev/null && printf 'CLI_%s\\n' "$(command -v corgi)"\r`,
        },
      },
    });
    await waitFor(async () =>
      (
        await rpc({ op: "session.command", command: { "pane.read": { target: pane, view: "screen" } } })
      ).result.text.includes(`CLI_${launcher}`),
    );
    expect((await cli(["hooks", "claude"])).out).toContain(launcher);
  } finally {
    await exec([bin, "shutdown"], secondEnv, false);
  }
}, 120_000);

test("machine setup activates the canonical installation and preserves live shells", async () => {
  await cli(["start"]);
  const session = await rpc({ op: "session.snapshot" });
  await rpc({
    op: "session.command",
    command: { "pane.create": { workspace: session.workspaces[0].id, cwd: home, command: "exec /bin/sh" } },
  });
  const before = await rpc({ op: "session.snapshot" });
  const old = join(root, "releases/1.0.0/corgi");
  const expected = sha(await readFile(old));
  const manifest = join(home, "incoming.json");
  await writeFile(manifest, manifests.get("1.0.1")!);
  const result = await exec([fixture("1.0.1"), "__machine-install", old, expected, manifest]);
  expect(JSON.parse(result.out).executable).toBe(await realpath(join(root, "releases/1.0.1/corgi")));
  expect((await readFile(join(root, "current"), "utf8")).trim()).toBe("1.0.1");
  expect((await rpc({ op: "session.snapshot" })).panes[0].pid).toBe(before.panes[0].pid);
  expect((await rpc({ op: "hello" })).executable).toBe(await realpath(join(root, "releases/1.0.1/corgi")));
}, 30_000);

test("machine setup refuses an installation changed since discovery", async () => {
  const old = join(root, "releases/1.0.0/corgi");
  const manifest = join(home, "incoming.json");
  await writeFile(manifest, manifests.get("1.0.1")!);
  const result = await exec([fixture("1.0.1"), "__machine-install", old, "0".repeat(64), manifest], env, false);
  expect(result.code).not.toBe(0);
  expect(result.err).toContain("InstallationChanged");
  expect((await readFile(join(root, "current"), "utf8")).trim()).toBe("1.0.0");
});

test("machine setup bootstraps a single standalone command and refuses wrappers", async () => {
  const destination = join(home, "standalone/corgi");
  const result = await exec([EXE, "__machine-install", destination, "", ""]);
  expect(JSON.parse(result.out).executable).toBe(destination);
  expect(sha(await readFile(destination))).toBe(sha(await readFile(EXE)));
  await writeFile(destination, "#!/bin/sh\nexit 0\n");
  const refused = await exec([EXE, "__machine-install", destination, sha(await readFile(destination)), ""], env, false);
  expect(refused.err).toContain("CannotReplaceCorgiWrapper");
  expect(await readFile(destination, "utf8")).toBe("#!/bin/sh\nexit 0\n");
});
