import { test, expect, spyOn } from "bun:test";
import { basename, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  processArgs,
  processCwd,
  processPath,
  processJob,
  processTree,
  PathSearch,
  shellQuote,
  shellEscape,
  SocketPath,
  env,
  loginShell,
  privateDirectory,
} from "./os";
import { n } from "./native_ffi";
import * as log from "./log";

test("the login shell comes from the account database, not SHELL", () => {
  const account =
    process.platform === "darwin"
      ? Bun.spawnSync(["dscl", ".", "-read", `/Users/${env("USER")}`, "UserShell"])
          .stdout.toString()
          .replace(/^UserShell:\s*/, "")
      : Bun.spawnSync(["getent", "passwd", String(process.getuid!())])
          .stdout.toString()
          .split(":")[6];
  expect(loginShell()).toBe(account.trim());
});
test.if(process.platform === "darwin")("a blank directory from macOS is unknown, and warned about once", () => {
  const probe = spyOn(n, "probe_process_cwd").mockReturnValue(0),
    stderr = spyOn(process.stderr, "write").mockReturnValue(true);
  log.configure("serve", {});
  try {
    expect(processCwd(process.pid)).toBeNull();
    expect(processCwd(process.pid)).toBeNull();
    const lines = stderr.mock.calls.map(call => String(call[0]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith("warn(process.cwd): ");
    expect(JSON.parse(lines[0].slice(lines[0].indexOf("{")))).toMatchObject({ pid: process.pid, alive: true });
  } finally {
    log.configure("");
    stderr.mockRestore();
    probe.mockRestore();
  }
});
test.if(process.platform === "darwin")(
  "a directory too long for macOS to report is unknown, and warned about",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "corgi-deep-")),
      part = "d".repeat(100),
      // One `cd` can't take a path this long.
      child = Bun.spawn(
        [
          "/bin/sh",
          "-c",
          `cd ${root} && for i in 1 2 3 4 5 6 7 8 9 10 11 12; do mkdir ${part} && cd ${part} || exit 1; done; echo ready; sleep 30`,
        ],
        { stdout: "pipe" },
      ),
      stderr = spyOn(process.stderr, "write").mockReturnValue(true);
    log.configure("serve", {});
    try {
      await child.stdout.getReader().read();
      expect(processCwd(child.pid)).toBeNull();
      const lines = stderr.mock.calls.map(call => String(call[0]));
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0].slice(lines[0].indexOf("{")))).toMatchObject({
        pid: child.pid,
        alive: true,
        message: "a process's directory is too long for macOS to report",
      });
    } finally {
      log.configure("");
      stderr.mockRestore();
      child.kill();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
test("a process's own arguments, executable and environment are readable", () => {
  const buf = Buffer.alloc(1024 * 1024),
    bare = processArgs(process.pid, buf)!;
  expect(bare.args().length).toBeGreaterThan(0);
  expect(bare.complete).toBe(true);
  expect(bare.exe).toBe("");
  expect(bare.environ()).toHaveLength(0);
  const full = processArgs(process.pid, buf, { env: true })!;
  expect(full.complete).toBe(true);
  expect(full.exe.length).toBeGreaterThan(0);
  expect(basename(full.exe)).toBe(basename(full.args()[0]));
  expect(full.environ()).toContain(`HOME=${env("HOME")}`);
  const used = bare.args().reduce((n, arg) => n + Buffer.byteLength(arg) + 1, 0),
    cut = processArgs(process.pid, buf.subarray(0, used - 1));
  if (process.platform === "darwin") expect(cut).toBeNull();
  else expect(cut!.complete).toBe(false);
});
test("a process's parent and executable are readable", () => {
  expect(processJob(process.pid)!.ppid).toBe(process.ppid);
  expect(processPath(process.pid)).toBe(process.execPath);
});
test("a process tree lists the roots and their descendants, not the host", async () => {
  const child = Bun.spawn(["/bin/sh", "-c", "sleep 30 & echo $!; wait"], { stdout: "pipe" });
  let grandchild = 0;
  try {
    const reader = child.stdout.getReader();
    grandchild = Number(new TextDecoder().decode((await reader.read()).value).trim());
    const tree = processTree([child.pid]);
    if (tree === null) return; // No CONFIG_PROC_CHILDREN, or not Linux: callers scan the host.
    expect(tree.sort()).toEqual([child.pid, grandchild].sort());
    expect(processTree([-1])).toEqual([]);
  } finally {
    if (grandchild > 0) process.kill(grandchild, "SIGKILL");
    child.kill("SIGKILL");
  }
});
test("PATH search takes absolute entries only", () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-path-"));
  try {
    mkdirSync(join(root, "tool"));
    writeFileSync(join(root, "plain"), "", { mode: 0o644 });
    for (const dir of ["a", "b"]) {
      mkdirSync(join(root, dir));
      writeFileSync(join(root, dir, "tool"), "", { mode: 0o755 });
    }
    const list = `::relative:${root}:${root}/a:${root}/b`,
      s = PathSearch.init(list, "tool");
    expect(s.next()).toBe(`${root}/a/tool`);
    expect(s.next()).toBe(`${root}/b/tool`);
    expect(s.next()).toBeNull();
    expect(PathSearch.init(list, "plain").next()).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("shell quoting protects arguments containing shell syntax", () => {
  expect(shellQuote("/tmp/a'b$(echo bad)/corgi")).toBe("'/tmp/a'\\''b$(echo bad)/corgi'");
  expect(shellEscape(["tig", "a b", "a'b", "a\\b", "$(touch nope)", ""])).toBe(
    "tig a\\ b a\\'b a\\\\b \\$\\(touch\\ nope\\) ''",
  );
  expect(shellEscape(["tig", "bad\rcommand"])).toBeNull();
  expect(shellEscape(["tig", Buffer.from([98, 97, 100, 255, 99])])).toBeNull();
});
test("a private directory's created ancestors can hold private files too", () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-private-"));
  try {
    privateDirectory(join(root, "remote/workspaces"));
    expect(() => privateDirectory(join(root, "remote"))).not.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release leaves a successor's socket in place", () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-socket-")),
    path = join(root, "socket");
  try {
    writeFileSync(path, "");
    const claimed = SocketPath.claim(path);
    renameSync(path, path + ".old");
    writeFileSync(path, "");
    claimed.release();
    expect(existsSync(path)).toBe(true);
    SocketPath.claim(path).release();
    expect(existsSync(path)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
