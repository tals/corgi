import { test, expect } from "bun:test";
import { basename, join } from "node:path";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  renameSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  processArgs,
  processPath,
  processJob,
  processTree,
  PathSearch,
  shellQuote,
  shellEscape,
  SocketPath,
  env,
} from "./os";

test("a process's own arguments, executable and environment are readable", () => {
  const buf = Buffer.alloc(1024 * 1024),
    bare = processArgs(process.pid, buf)!;
  expect(bare.argc).toBeGreaterThan(0);
  expect(bare.complete).toBe(true);
  expect(bare.exe).toBe("");
  expect(bare.env_len).toBe(0);
  const full = processArgs(process.pid, buf, { env: true })!;
  expect(full.complete).toBe(true);
  expect(full.exe.length).toBeGreaterThan(0);
  expect(basename(full.exe)).toBe(basename(full.args()[0]));
  expect(full.environ()).toContain(`HOME=${env("HOME")}`);
  const used = bare
      .args()
      .reduce((n, arg) => n + Buffer.byteLength(arg) + 1, 0),
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
  expect(shellQuote("/tmp/a'b$(echo bad)/corgi")).toBe(
    "'/tmp/a'\\''b$(echo bad)/corgi'",
  );
  expect(shellEscape(["tig", "a b", "a'b", "a\\b", "$(touch nope)", ""])).toBe(
    "tig a\\ b a\\'b a\\\\b \\$\\(touch\\ nope\\) ''",
  );
  expect(shellEscape(["tig", "bad\rcommand"])).toBeNull();
  expect(shellEscape(["tig", Buffer.from([98, 97, 100, 255, 99])])).toBeNull();
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

import { run } from "./subprocess";
import { exec } from "./os";
test("exec replaces the process and reports failed lookups with the source error", async () => {
  expect(() => exec(["/missing/corgi-exec-test"])).toThrow("ExecFailed");
  const script = `import {exec} from ${JSON.stringify(new URL("./os.ts", import.meta.url).pathname)};exec(['/bin/sh','-c','printf replaced; exit 7']);console.log('not reached');`;
  const out = await run([process.execPath, "-e", script], { timeout_ms: 5000 });
  expect(out.stdout.toString()).toBe("replaced");
  expect(out.term).toEqual({ exited: 7 });
});
