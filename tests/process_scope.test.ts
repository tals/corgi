import { test, expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Scope } from "../scripts/process_scope";
import { deadline, quote, tempDir, writeExecutable } from "./support";

function alive(pid: number) {
  const status = Bun.spawnSync(["ps", "-p", String(pid), "-o", "stat="], { stderr: "ignore" })
    .stdout.toString()
    .trim();
  return status !== "" && !status.startsWith("Z");
}
async function until(check: () => boolean) {
  const end = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() >= end) throw new Error("Process cleanup timed out");
    await Bun.sleep(30);
  }
}

test("scope cleanup detects detached descendants and leaves other scopes alone", async () => {
  const scope = await Scope.start(),
    other = await Scope.start();
  const unrelated = Bun.spawn([process.execPath, "-e", "await Bun.sleep(60000)"], {
    env: other.env,
    stdout: "ignore",
    stderr: "ignore",
  });
  let orphan = 0;
  try {
    const parent = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
      const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(60000)"], {
        detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore",
      });
      console.log(child.pid);
      child.unref();
    `,
      ],
      { env: scope.env, stdout: "pipe", stderr: "inherit" },
    );
    orphan = Number(await new Response(parent.stdout).text());
    expect(await parent.exited).toBe(0);
    expect(alive(orphan)).toBe(true);
    await expect(scope.assertClean()).rejects.toThrow("Leaked processes were reaped");
    expect(alive(orphan)).toBe(false);
    expect(alive(unrelated.pid)).toBe(true);
  } finally {
    await scope.close();
    await other.close();
    await unrelated.exited;
    if (orphan && alive(orphan)) process.kill(orphan, "SIGKILL");
  }
}, 20_000);

test("watchdog kills what it finds even when listing processes outlasts its budget", async () => {
  const temp = tempDir("corgi-scope-");
  // Only full listings are slow, as under heavy load.
  writeExecutable(
    join(temp.name, "ps"),
    `#!/bin/sh\ncase " $* " in *" -A "*) sleep 8.5;; esac\nexec ${quote(Bun.which("ps")!)} "$@"\n`,
  );
  const path = process.env.PATH;
  process.env.PATH = `${temp.name}:${path}`;
  let scope: Scope;
  try {
    scope = await Scope.start();
  } finally {
    process.env.PATH = path;
  }
  const child = Bun.spawn([process.execPath, "-e", "process.on('SIGTERM', () => {}); await Bun.sleep(60000)"], {
    env: scope.env,
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    await expect(scope.assertClean()).rejects.toThrow("Process scope watchdog failed");
    await until(() => !alive(child.pid));
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    temp.cleanup();
  }
}, 30_000);

for (const mode of ["exit", "SIGKILL"] as const)
  test(`watchdog cleans up an uncooperative process after its owner ${mode}`, async () => {
    const temp = tempDir("corgi-scope-");
    const ready = join(temp.name, "ready");
    const fixture = join(temp.name, "owner.ts");
    writeFileSync(
      fixture,
      `
      import { writeFileSync } from "node:fs";
      import { Scope } from ${JSON.stringify(join(import.meta.dir, "../scripts/process_scope.ts"))};
      const scope = await Scope.start();
      const child = Bun.spawn([process.execPath, "-e", "process.on('SIGTERM', () => {}); console.log('ready'); await Bun.sleep(60000)"], {
        env: scope.env, detached: true, stdout: "pipe", stderr: "ignore",
      });
      await child.stdout.getReader().read();
      writeFileSync(${JSON.stringify(ready)}, String(child.pid));
      ${mode === "exit" ? "process.exit(0);" : "await Bun.sleep(60000);"}
    `,
    );
    const owner = Bun.spawn([process.execPath, fixture], { stdout: "ignore", stderr: "inherit" });
    let child = 0;
    try {
      await until(() => existsSync(ready));
      child = Number(readFileSync(ready, "utf8"));
      if (mode === "SIGKILL") owner.kill("SIGKILL");
      await deadline(owner.exited, 3000);
      await until(() => !alive(child));
    } finally {
      owner.kill("SIGKILL");
      await owner.exited;
      if (child && alive(child)) process.kill(child, "SIGKILL");
      temp.cleanup();
    }
  }, 20_000);
