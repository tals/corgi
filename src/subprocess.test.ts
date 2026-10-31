import { test, expect } from "bun:test";
import { ChildProcess } from "node:child_process";
import { run, Quit } from "./subprocess";
const sh = (script: string, extra: any = {}) => run(["/bin/sh", "-c", script], { timeout_ms: 5000, ...extra });
/** Runs `body` while children never deliver "exit" to a listener, as when Bun
 * emits it inside spawn() (oven-sh/bun#45483); `reported` fakes the status
 * Bun has set by then. */
async function lostExit(reported: number | null, body: () => unknown) {
  const proto = ChildProcess.prototype as any,
    once = proto.once;
  proto.once = function (this: { exitCode: number | null }, event: string, listener: (...args: any[]) => void) {
    if (event !== "exit") return once.call(this, event, listener);
    if (reported !== null) this.exitCode = reported;
    return this;
  };
  try {
    await body();
  } finally {
    delete proto.once;
  }
}
test("exit codes and signals come back as terms", async () => {
  const done = await sh("printf done");
  expect(done.ok()).toBe(true);
  expect(done.stdout.toString()).toBe("done");
  expect((await sh("exit 3")).term).toEqual({ exited: 3 });
  expect((await sh("kill -9 $$")).term).toEqual({ signal: "KILL" });
});
test("exit, not the end of the output, ends a run", async () => {
  const begin = Date.now();
  const output = await sh("sleep 5 & printf done");
  expect(output.stdout.toString()).toBe("done");
  expect(Date.now() - begin).toBeLessThan(1000);
});
test("the deadline kills the whole group", async () => {
  await expect(sh("sleep 20 & wait", { timeout_ms: 30 })).rejects.toThrow("TimedOut");
});
test("an exit reported before the run listens still ends it", async () => {
  await lostExit(7, async () => expect((await sh("exit 7")).term).toEqual({ exited: 7 }));
});
test("the deadline ends a run whose exit never arrives", async () => {
  await lostExit(null, () => expect(sh("sleep 20", { timeout_ms: 30 })).rejects.toThrow("TimedOut"));
});
test("a child that exits leaves what it started running", async () => {
  const out = await sh("sleep 20 & printf %s $!");
  const pid = Number(out.stdout.toString());
  expect(() => process.kill(pid, 0)).not.toThrow();
  process.kill(pid, "SIGKILL");
});
test("a quit ends the run in flight and every later run", async () => {
  const quit = Quit.init(),
    pending = sh("sleep 10", { quit });
  setTimeout(() => quit.signal(), 20);
  await expect(pending).rejects.toThrow("Cancelled");
  await expect(sh("true", { quit })).rejects.toThrow("Cancelled");
});
test("stdout past the cap fails, stderr keeps its tail", async () => {
  await expect(sh("printf 123456789", { max_output: 5 })).rejects.toThrow("OutputTooLarge");
  const out = await sh("printf 123456789 >&2", { max_output: 5, stderr: true });
  expect(out.stderr.toString()).toBe("56789");
});
test("output written just before exit is kept, past a full pipe", async () => {
  const out = await sh("head -c 100000 /dev/zero", { max_output: 200000 });
  expect(out.stdout.length).toBe(100000);
});
test("input reaches the child", async () => {
  expect((await sh("cat", { input: "input" })).stdout.toString()).toBe("input");
});

import { readdirSync } from "node:fs";
test("failed launches release every allocated pipe and readiness loop", async () => {
  const dir = process.platform === "darwin" ? "/dev/fd" : "/proc/self/fd",
    before = readdirSync(dir).length;
  for (let i = 0; i < 8; i++) {
    await expect(run([], { timeout_ms: 100, stderr: true })).rejects.toThrow();
    await expect(
      run(["/missing/corgi-test-executable"], {
        timeout_ms: 100,
        stderr: true,
      }),
    ).rejects.toThrow("FileNotFound");
  }
  expect(readdirSync(dir).length).toBe(before);
});
test("cancellation during launch is observed before the child can run indefinitely", async () => {
  const quit = Quit.init();
  const config: any = { timeout_ms: 5000, quit };
  Object.defineProperty(config, "env", {
    get() {
      quit.signal();
      return process.env;
    },
  });
  await expect(run(["/bin/sh", "-c", "sleep 20"], config)).rejects.toThrow("Cancelled");
});
