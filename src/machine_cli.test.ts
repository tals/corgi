import { expect, spyOn, test } from "bun:test";
import * as machineCli from "./machine_cli";

test("a remote command takes the local CLI's --json and --viewer", async () => {
  const calls: unknown[][] = [];
  const conn = {
    call: async (...args: unknown[]) => {
      calls.push(args);
      return { ok: true };
    },
    rawRequest: async () => ({}),
  } as never;
  const written = spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    await machineCli.run("/tmp/corgi.sock", ["ping", "--json"], conn);
    await machineCli.run("/tmp/corgi.sock", ["action", "next", "--viewer", "3"], conn);
    await machineCli.run("/tmp/corgi.sock", ["action", "tab", "2", "--json"], conn);
    await expect(machineCli.run("/tmp/corgi.sock", ["action", "next", "--viewer", "x"], conn)).rejects.toThrow("Usage");
    expect(calls).toEqual([
      ["ping"],
      ["action", { name: "next", value: "", viewer: 3 }],
      ["action", { name: "tab", value: "2" }],
    ]);
  } finally {
    written.mockRestore();
  }
});
