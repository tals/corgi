import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as setup from "./machine_setup";
import * as current_release from "./current_release";

test("development ancestry uses the Corgi checkout instead of the caller's repository", async () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-ancestry-"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString().trim();
  };
  try {
    git("init", "-q");
    git("config", "user.name", "Corgi Test");
    git("config", "user.email", "test@example.invalid");
    git("config", "commit.gpgsign", "false");
    git("commit", "--allow-empty", "-qm", "older");
    const older = git("rev-parse", "HEAD");
    git("commit", "--allow-empty", "-qm", "newer");
    const newer = git("rev-parse", "HEAD");
    expect(await setup.ancestor(older, newer, root)).toBe(true);
    expect(await setup.ancestor(newer, older, root)).toBe(false);
    expect(await setup.ancestor("f".repeat(40), newer, root)).toBe(false);
    expect(await setup.ancestor(older, newer, join(root, "missing"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the setup probe reads native binary headers without shell warnings", async () => {
  const executable = Bun.which("true")!;
  // Bash 4.4+ warns when a command substitution receives a NUL byte.
  const child = Bun.spawn(["bash", "-c", setup.probe(executable)], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code).toBe(0);
  expect(out).toContain("\n" + executable + "\n");
  expect(err).toBe("");
});

test("the setup probe follows a managed launcher to its current release", async () => {
  const root = mkdtempSync(join(tmpdir(), "corgi probe-"));
  try {
    const executable = join(root, "releases/1.0.0/corgi");
    mkdirSync(join(root, "releases/1.0.0"), { recursive: true });
    writeFileSync(executable, "#!/bin/sh\nprintf '%s\\n' '{\"version\":\"1.0.0\"}'\n", { mode: 0o700 });
    writeFileSync(join(root, "current"), "1.0.0\n");
    const launcher = current_release.path(executable);
    expect(await setup.run(["sh", "-c", setup.probe(launcher)])).toContain(
      "\n" + executable + '\n{"version":"1.0.0"}\n',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a copy takes as long as it keeps moving, and stops once it doesn't", async () => {
  // Slower in all than its limit, but never that long without a byte.
  const moving = "for i in 1 2 3 4 5 6; do echo x; sleep 0.1; done";
  expect((await setup.run(["sh", "-c", moving], undefined, { idle: 400 })).trim().split("\n")).toHaveLength(6);
  await expect(setup.run(["sh", "-c", moving], undefined, { total: 300 })).rejects.toThrow("MachineSetupTimedOut");
  // An end that stops taking input, as a hung disk does.
  await expect(
    setup.run(["sh", "-c", "exec sleep 5"], new Blob([new Uint8Array(4 << 20)]), { idle: 300 }),
  ).rejects.toThrow("MachineSetupTimedOut");
  // One that takes it all finishes.
  expect(await setup.run(["sh", "-c", "wc -c"], new Blob([new Uint8Array(4 << 20)]), { idle: 2000 })).toContain(
    String(4 << 20),
  );
});
