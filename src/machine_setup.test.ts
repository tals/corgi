import { expect, test } from "bun:test";
import * as setup from "./machine_setup";

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
