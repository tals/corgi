import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Stats } from "./connection_stats";
import * as machine_path from "./machine_path";

test("this computer's daemon is started again once a connection finds nothing listening", async () => {
  const folder = mkdtempSync(join(tmpdir(), "corgi-path-test-"));
  let starts = 0;
  const factory = machine_path.local(
    join(folder, "control.sock"),
    async () => {
      starts++;
    },
    true,
  );
  const open = () => factory(false, false).open("control", new Stats(), {});
  try {
    // Running when the viewer opened: nothing to start yet.
    await expect(open()).rejects.toThrow();
    expect(starts).toBe(0);
    // That attempt found no daemon, so this one starts it first.
    await expect(open()).rejects.toThrow();
    expect(starts).toBe(1);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
