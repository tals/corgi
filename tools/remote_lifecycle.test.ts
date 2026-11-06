import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Sandbox } from "./sandbox";
import { world } from "./sandboxes/remote";

test("remote shutdown waits for supervisor cleanup even when its status request fails", async () => {
  const sandbox = new Sandbox(`remote-shutdown-${process.pid}`, world, join(import.meta.dir, ".."), process.execPath);
  mkdirSync(sandbox.dir, { recursive: true });
  const control = join(sandbox.dir, "network.sock");
  const server = createServer(client => client.destroy());
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(control, resolve));
    timer = setTimeout(() => server.close(), 100);
    await world.shutdown!(sandbox);
    expect(existsSync(control)).toBe(false);
  } finally {
    clearTimeout(timer);
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(sandbox.dir, { recursive: true, force: true });
  }
});
