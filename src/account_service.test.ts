import { expect, spyOn, test } from "bun:test";
import * as service from "./account_service";
import * as accounts from "./accounts";
import * as profiles from "./agent_profiles";
import * as signin from "./signin";
import * as lock from "./account_lock";
import { Runtime } from "./runtime";

const known = { provider: "claude" as const, dir: "/isolated/work", name: "work", managed: true };
test("daemon account removal excludes concurrent mutations, preserves failed logouts, and releases its lock", async () => {
  using runtime = new Runtime();
  const gate = Promise.withResolvers<void>();
  const find = spyOn(accounts, "find").mockReturnValue(known),
    owns = spyOn(accounts, "owns").mockReturnValue(true),
    unused = spyOn(profiles, "assertAccountUnused").mockImplementation(() => {}),
    logout = spyOn(signin, "signOut").mockReturnValue(gate.promise),
    remove = spyOn(accounts, "remove").mockResolvedValue(true);
  try {
    const pending = service.remove(runtime, "claude", known.dir);
    expect(() => lock.check("claude", known.dir)).toThrow("AccountInUse");
    await expect(service.remove(runtime, "claude", known.dir)).rejects.toThrow("AccountInUse");
    gate.reject(Error("LogoutFailed"));
    await expect(pending).rejects.toThrow("LogoutFailed");
    expect(remove).not.toHaveBeenCalled();
    expect(() => lock.check("claude", known.dir)).not.toThrow();
    logout.mockResolvedValue();
    expect(await service.remove(runtime, "claude", known.dir)).toBe(true);
    expect(remove).toHaveBeenCalledTimes(1);
  } finally {
    for (const mock of [find, owns, unused, logout, remove]) mock.mockRestore();
  }
});
test("releasing an old sign-in twice cannot unlock a newer account job", () => {
  const first = lock.take("claude", known.dir);
  first();
  const second = lock.take("claude", known.dir);
  try {
    first();
    expect(() => lock.check("claude", known.dir)).toThrow("AccountInUse");
  } finally {
    second();
  }
});
