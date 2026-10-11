// Copies of the test binary play two releases in isolated runtimes; no host
// installation is touched. A test build at releases/<v>/corgi is release <v>.
import { beforeAll, afterAll, beforeEach, afterEach, test, expect } from "bun:test";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { EXE, Pty, deadline } from "./support";
import { installer } from "../scripts/release.ts";
import { Scope } from "../scripts/process_scope";
const base = await mkdtemp(join(tmpdir(), "corgi-updates-"));
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
const binaries = new Map<string, Uint8Array>();
const manifests = new Map<string, string>();
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    requests++;
    if (unavailable) return new Response("unavailable", { status: 503 });
    const path = new URL(req.url).pathname;
    if (path === "/channels/stable.json") {
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
    if (path.endsWith("/corgi")) {
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
async function rpc(value: unknown) {
  return JSON.parse((await cli(["rpc", JSON.stringify(value)])).out);
}
async function waitFor(fn: () => Promise<boolean>) {
  for (let i = 0; i < 150; i++) {
    if (await fn()) return;
    await Bun.sleep(100);
  }
  throw new Error("Timed out");
}
beforeAll(async () => {
  const current = await readFile(EXE);
  for (const v of ["1.0.0", "1.0.1"]) {
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
      targets: { "macos-aarch64": target, "linux-x86_64": target },
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
    await cli(["update", "auto", "off"], false);
    await cli(["shutdown"], false);
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
  const session = await rpc({ op: "session.snapshot", protocol: 1 });
  await rpc({
    op: "session.command",
    protocol: 1,
    command: { "pane.create": { workspace: session.workspaces[0].id, cwd: home, command: "exec /bin/sh" } },
  });
  const before = await rpc({ op: "session.snapshot", protocol: 1 });
  const pane = before.panes[0].id;
  await rpc({
    op: "session.command",
    protocol: 1,
    command: { "pane.input": { target: pane, data: "printf 'BEFORE_UPDATE\\n'\r" } },
  });
  await waitFor(async () =>
    (
      await rpc({ op: "session.command", protocol: 1, command: { "pane.read": { target: pane, view: "screen" } } })
    ).result.text.includes("BEFORE_UPDATE"),
  );
  await cli(["update"]);
  const after = await rpc({ op: "session.snapshot", protocol: 1 });
  expect(after.server_pid).not.toBe(before.server_pid);
  expect(after.panes[0].pid).toBe(before.panes[0].pid);
  await rpc({
    op: "session.command",
    protocol: 1,
    command: { "pane.input": { target: pane, data: "printf 'AFTER_UPDATE\\n'\r" } },
  });
  await waitFor(async () =>
    (
      await rpc({ op: "session.command", protocol: 1, command: { "pane.read": { target: pane, view: "screen" } } })
    ).result.text.includes("AFTER_UPDATE"),
  );
  expect(await readFile(join(root, "current"), "utf8")).toBe("1.0.1");
  await cli(["update", "rollback"]);
  expect(await readFile(join(root, "current"), "utf8")).toBe("1.0.0");
  expect(await readFile(join(root, "suppressed"), "utf8")).toBe("1.0.1");
  expect((await rpc({ op: "session.snapshot", protocol: 1 })).panes[0].pid).toBe(before.panes[0].pid);
}, 30_000);
test("background download stages without activating, next start works offline", async () => {
  await cli(["start"]);
  const old = await rpc({ op: "hello", protocol: 1 });
  await cli(["update", "auto", "on"]);
  await waitFor(
    async () =>
      (await Bun.file(join(root, "staged"))
        .text()
        .catch(() => "")) === "1.0.1",
  );
  expect(await readFile(join(root, "current"), "utf8")).toBe("1.0.0");
  expect((await rpc({ op: "hello", protocol: 1 })).server_pid).toBe(old.server_pid);
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
  const before = await rpc({ op: "hello", protocol: 1 });
  invalid = true;
  expect((await cli(["update"], false)).code).not.toBe(0);
  invalid = false;
  corrupt = true;
  expect((await cli(["update"], false)).code).not.toBe(0);
  expect(await readFile(join(root, "current"), "utf8")).toBe("1.0.0");
  expect((await rpc({ op: "hello", protocol: 1 })).server_pid).toBe(before.server_pid);
  expect(await Bun.file(join(root, "staged")).exists()).toBe(false);
}, 30_000);
test("incompatible update defers noninteractively and keeps running executable", async () => {
  await cli(["start"]);
  const before = await rpc({ op: "hello", protocol: 1 });
  badAbi = true;
  const result = await cli(["update"], false);
  expect(result.code).not.toBe(0);
  expect(result.err).toContain("UpdateDeferred");
  expect((await rpc({ op: "hello", protocol: 1 })).server_pid).toBe(before.server_pid);
  expect(await readFile(join(root, "current"), "utf8")).toBe("1.0.0");
}, 30_000);
test("help and ordinary RPC never check the network; auto off prevents activation", async () => {
  await cli(["update", "--download-only"]);
  requests = 0;
  await cli(["--help"]);
  await cli(["--version"]);
  await cli(["start"]);
  await rpc({ op: "hello", protocol: 1 });
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
  expect((await rpc({ op: "hello", protocol: 1 })).release_version).toBe("1.0.1");
}, 30_000);
test("interactive Escape skips once per runtime without stopping processes", async () => {
  await cli(["start"]);
  const before = await rpc({ op: "hello", protocol: 1 });
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
  expect((await rpc({ op: "hello", protocol: 1 })).server_pid).toBe(before.server_pid);
  expect((await cli(["start"])).err).not.toContain("Enter / Esc");
  expect(await readFile(join(root, "current"), "utf8")).toBe("1.0.0");
}, 30_000);
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
    const info = JSON.parse((await exec([bin, "rpc", JSON.stringify({ op: "hello", protocol: 1 })], secondEnv)).out);
    expect(info.release_version).toBe("1.0.1");
  } finally {
    await exec([bin, "shutdown"], secondEnv, false);
  }
}, 30_000);
