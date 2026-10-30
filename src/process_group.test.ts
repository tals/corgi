import { expect, test } from "bun:test";
import { n } from "./native_ffi";
import { processGroup, processJob } from "./os";

test("process groups agree with process records and reject invalid PID values", () => {
  expect(processGroup(process.pid)).toBe(processJob(process.pid)?.pgid ?? null);
  expect(processGroup(process.pid)).toBe(n.probe_getpgrp());
  for (const pid of [-1, 0, 2147483647, process.pid + 2 ** 32, process.pid + 0.5, NaN])
    expect(processGroup(pid)).toBeNull();
});

test("process groups follow inherited and isolated children and forget exited processes", async () => {
  for (const detached of [false, true]) {
    const child = Bun.spawn(["/bin/sleep", "30"], {
      detached,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      expect(processGroup(child.pid)).toBe(processJob(child.pid)?.pgid ?? null);
      expect(processGroup(child.pid)).toBe(detached ? child.pid : processGroup(process.pid));
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
    expect(processGroup(child.pid)).toBeNull();
  }
});

test.skipIf(process.platform !== "linux")("a live PID's process group is read afresh after setpgid", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { dlopen } from 'bun:ffi';
     const { symbols } = dlopen('libc.so.6', { setpgid: { args: ['i32', 'i32'], returns: 'i32' } });
     const input = Bun.stdin.stream().getReader();
     process.stdout.write('ready\\n');
     await input.read();
     if (symbols.setpgid(0, 0)) throw Error('SetProcessGroup');
     process.stdout.write('changed\\n');
     await input.read();`,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "inherit" },
  );
  const reader = child.stdout.getReader();
  try {
    await reader.read();
    expect(processGroup(child.pid)).toBe(processGroup(process.pid));
    child.stdin.write("change\n");
    await reader.read();
    expect(processGroup(child.pid)).toBe(child.pid);
    expect(processGroup(child.pid)).toBe(processJob(child.pid)?.pgid ?? null);
  } finally {
    reader.releaseLock();
    child.kill("SIGKILL");
    await child.exited;
  }
});
