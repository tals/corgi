import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Lines, Pty, TestCase, deadline, run, tempDir } from "./support";

test("line reader keeps fragmented, coalesced and queued replies in order", async () => {
  const lines = new Lines();
  const first = lines.next();
  lines.feed('{"n":');
  lines.feed('1}\n{"n":2}\n{"n":');
  expect(await first).toBe('{"n":1}');
  expect(await lines.next()).toBe('{"n":2}');
  const third = lines.next();
  lines.feed("3}\n");
  lines.end();
  expect(await third).toBe('{"n":3}');
  await expect(lines.next()).rejects.toThrow("Stream ended");
});
test("a timed out line read does not consume the next reply", async () => {
  const lines = new Lines();
  await expect(lines.next(10)).rejects.toThrow("Timed out");
  lines.feed("reply\n");
  expect(await lines.next()).toBe("reply");
});
test("process output drains both pipes while passing input and preserving exit code", async () => {
  const result = await run(
    [
      process.execPath,
      "-e",
      "const input=await Bun.stdin.text();process.stdout.write(input+'x'.repeat(262144));process.stderr.write('y'.repeat(262144));process.exitCode=7",
    ],
    { input: "sentinel", check: false },
  );
  expect(result.code).toBe(7);
  expect(result.stdout).toBe("sentinel" + "x".repeat(262144));
  expect(result.stderr).toBe("y".repeat(262144));
});
test("process deadline terminates and reaps a hanging child", async () => {
  const start = performance.now();
  await expect(run([process.execPath, "-e", "await Bun.sleep(60000)"], { timeout: 50 })).rejects.toThrow("timed out");
  expect(performance.now() - start).toBeLessThan(3000);
});
test("assertion adapter catches empty collections and missing await", () => {
  const assertions = new TestCase();
  expect(() => assertions.assertTrue([])).toThrow();
  expect(() => assertions.assertTrue({})).toThrow();
  expect(() => assertions.assertFalse([1])).toThrow();
  expect(() => assertions.assertTrue(Promise.resolve(false))).toThrow("await");
  assertions.assertFalse([]);
  assertions.assertIn({ id: 1 }, [{ id: 1 }]);
});
test("PTY settings capture control characters beyond Bun flag words", async () => {
  const pty = new Pty();
  try {
    const before = await pty.settings();
    const flags = () => [
      pty.terminal.inputFlags,
      pty.terminal.outputFlags,
      pty.terminal.controlFlags,
      pty.terminal.localFlags,
    ];
    const beforeFlags = flags();
    expect(await deadline(pty.start(["/bin/stty", "erase", "^A"]).exited, 3000)).toBe(0);
    expect(await pty.settings()).not.toBe(before);
    expect(flags()).toEqual(beforeFlags);
    expect(await deadline(pty.start(["/bin/stty", before]).exited, 3000)).toBe(0);
    expect(await pty.settings()).toBe(before);
  } finally {
    await pty.close();
  }
});

for (const reply of ["", "\x1b]10;rgb:11/22/33\x1b\\", "\x1b]10;a\x1b\\\x1b]11;b\x1b\\\x1b]4;2;c\x1b\\"]) {
  test(`color probe records ${reply ? (reply.includes("]4;") ? "complete" : "partial") : "missing"} replies within its deadline`, async () => {
    const temp = tempDir("corgi-color-probe-");
    const result = join(temp.name, "colors.json");
    const pty = await Pty.spawn([process.execPath, join(import.meta.dir, "fixtures/color_probe.ts"), result]);
    try {
      await pty.waitFor("\x1b]4;2;?\x1b\\", 3000);
      if (reply) {
        pty.write(reply.slice(0, 5));
        pty.write(reply.slice(5));
      }
      await pty.waitFor(" COMPOSER ", 5000);
      expect(JSON.parse(readFileSync(result, "utf8"))).toBe(reply);
    } finally {
      await pty.close();
      temp.cleanup();
    }
  }, 10_000);
}
