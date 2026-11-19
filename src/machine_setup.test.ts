import { expect, test } from "bun:test";
import * as setup from "./machine_setup";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

test("cancelling automatic setup stops an outstanding command", async () => {
  const controller = new AbortController();
  const pending = setup.run(["sh", "-c", "exec sleep 30"], undefined, { total: 60000 }, undefined, controller.signal);
  controller.abort(Error("Paused"));
  await expect(pending).rejects.toThrow("Paused");
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

test("delta subprocess verifies the basis, removes failed candidates and stops stalled peers", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corgi-transfer-"));
  const before = Buffer.from("basis that repeats; ".repeat(10000));
  const after = Buffer.concat([before.subarray(1234), Buffer.from("changed"), before.subarray(0, 1234)]);
  const sha = (bytes: Buffer) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const basis = path.join(dir, "basis"),
    newer = path.join(dir, "newer"),
    candidate = path.join(dir, "candidate");
  fs.writeFileSync(basis, before);
  fs.writeFileSync(newer, after);
  const command = (oldHash = sha(before), newHash = sha(after)) => [
    process.execPath,
    path.join(import.meta.dir, "fixtures/machine_receive.ts"),
    basis,
    candidate,
    oldHash,
    newHash,
  ];
  try {
    const phases: string[] = [];
    const result = await setup.sendDelta(command(), newer, sha(after), stage => phases.push(stage));
    expect(fs.readFileSync(candidate)).toEqual(after);
    expect(result.sent_bytes).toBeLessThan(after.length / 2);
    expect(phases).toContain("signature");
    expect(phases).toContain("upload");
    fs.unlinkSync(candidate);
    // A destination may never be silently replaced, even by another valid transfer.
    fs.writeFileSync(candidate, "already exists");
    await expect(setup.sendDelta(command(), newer, sha(after), () => {})).rejects.toThrow();
    expect(fs.readFileSync(candidate, "utf8")).toBe("already exists");
    fs.unlinkSync(candidate);
    await expect(setup.sendDelta(command("0".repeat(64)), newer, sha(after), () => {})).rejects.toThrow();
    expect(fs.existsSync(candidate)).toBe(false);
    await expect(
      setup.sendDelta(command(sha(before), "0".repeat(64)), newer, "0".repeat(64), () => {}),
    ).rejects.toThrow();
    expect(fs.existsSync(candidate)).toBe(false);
    await expect(setup.sendDelta(["sh", "-c", "exec sleep 5"], newer, sha(after), () => {}, 100)).rejects.toThrow(
      "MachineSetupTimedOut",
    );
    // A truncated stream leaves no executable behind.
    const child = Bun.spawn(command(), { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    child.stdin.write(Buffer.from([0, 0, 0]));
    child.stdin.end();
    expect(await child.exited).not.toBe(0);
    expect(fs.existsSync(candidate)).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
