import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Catalog, refresh_ms } from "./catalog";
import { adapter } from "../providers";
import * as discovery from "../discovery";
import * as accounts from "../accounts";
import type { InferenceModel } from "../providers/adapter";

let restoreCheck: () => void;
beforeEach(() => {
  const check = spyOn(discovery, "check").mockResolvedValue();
  restoreCheck = () => check.mockRestore();
});
afterEach(() => restoreCheck());

const model: InferenceModel = {
  id: "custom/model",
  name: "Model",
  subscription: false,
  input_cost: 1,
  output_cost: 2,
};

test("model picker requests share discovery, cache results, and retain them during refresh failures", async () => {
  const installed = spyOn(discovery, "installed").mockImplementation(p => p === "pi"),
    known = spyOn(accounts, "known").mockReturnValue([]);
  let finish!: (models: InferenceModel[]) => void;
  const pending = new Promise<InferenceModel[]>(resolve => (finish = resolve));
  const read = spyOn(adapter("pi").inference, "models").mockReturnValue(pending);
  const catalog = new Catalog();
  try {
    expect(read).not.toHaveBeenCalled();
    const first = catalog.refresh();
    expect(catalog.loading).toBe(true);
    expect(catalog.refresh()).toBe(first);
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1);
    finish([model]);
    await first;
    expect(catalog.loading).toBe(false);
    expect(catalog.available.map(m => m.model)).toEqual([model.id]);
    await catalog.refresh();
    expect(read).toHaveBeenCalledTimes(1);

    catalog.next = 0;
    let fail!: (error: Error) => void;
    read.mockReturnValue(new Promise((_, reject) => (fail = reject)));
    const refresh = catalog.refresh();
    expect(catalog.loading).toBe(true);
    expect(catalog.available.map(m => m.model)).toEqual([model.id]);
    fail(Error("ModelsUnavailable"));
    await refresh;
    expect(catalog.loading).toBe(false);
    expect(catalog.available.map(m => m.model)).toEqual([model.id]);
    await catalog.refresh();
    expect(read).toHaveBeenCalledTimes(2);
  } finally {
    finish([]);
    catalog.close();
    read.mockRestore();
    known.mockRestore();
    installed.mockRestore();
  }
});

test("all callers share a three-minute throttle which account additions and removals invalidate", async () => {
  const installed = spyOn(discovery, "installed").mockImplementation(p => p === "opencode2"),
    known = spyOn(accounts, "known").mockReturnValue([]),
    read = spyOn(adapter("opencode2").inference, "models").mockResolvedValue([model]),
    now = spyOn(Date, "now").mockReturnValue(1000000),
    catalog = new Catalog();
  try {
    await catalog.refresh();
    expect(catalog.next).toBe(1000000 + refresh_ms);
    for (let i = 0; i < 4; i++) await catalog.refresh();
    expect(read).toHaveBeenCalledTimes(1);
    now.mockReturnValue(1000000 + refresh_ms - 1);
    await catalog.refresh();
    expect(read).toHaveBeenCalledTimes(1);
    now.mockReturnValue(1000000 + refresh_ms);
    await catalog.refresh();
    expect(read).toHaveBeenCalledTimes(2);
    known.mockReturnValue([{ provider: "pi", dir: "/pi/work", name: "Work", managed: false }]);
    await catalog.refresh();
    expect(read).toHaveBeenCalledTimes(3);
    known.mockReturnValue([]);
    await catalog.refresh();
    expect(read).toHaveBeenCalledTimes(4);
    await catalog.refresh();
    expect(read).toHaveBeenCalledTimes(4);
  } finally {
    catalog.close();
    read.mockRestore();
    known.mockRestore();
    installed.mockRestore();
    now.mockRestore();
  }
});

test("an account removed during discovery never publishes stale models and schedules a fresh read", async () => {
  const work: accounts.Known = { provider: "pi", dir: "/pi/work", name: "Work", managed: false },
    installed = spyOn(discovery, "installed").mockImplementation(p => p === "pi"),
    known = spyOn(accounts, "known").mockReturnValue([work]),
    pending = Promise.withResolvers<InferenceModel[]>(),
    read = spyOn(adapter("pi").inference, "models").mockImplementation(async account =>
      account ? pending.promise : [model],
    ),
    catalog = new Catalog();
  try {
    const first = catalog.refresh();
    // The default account finishes first; the work account is still being read.
    await Promise.resolve();
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(2);
    known.mockReturnValue([]);
    expect(catalog.refresh()).toBe(first);
    pending.resolve([{ ...model, name: "Removed account's model" }]);
    await first;
    expect(read).toHaveBeenCalledTimes(3);
    expect(catalog.available.map(m => m.account)).toEqual([""]);
    expect(catalog.available[0].name).toBe("Model");
    expect(catalog.next).toBeGreaterThan(Date.now());
    await catalog.refresh();
    expect(read).toHaveBeenCalledTimes(3);
  } finally {
    pending.resolve([]);
    catalog.close();
    read.mockRestore();
    known.mockRestore();
    installed.mockRestore();
  }
});

test("catalog identities preserve the named account as searchable context", async () => {
  const installed = spyOn(discovery, "installed").mockImplementation(p => p === "pi"),
    known = spyOn(accounts, "known").mockReturnValue([
      { provider: "pi", dir: "/pi/work", name: "Work", managed: false },
    ]),
    read = spyOn(adapter("pi").inference, "models").mockResolvedValue([
      { ...model, user: "user@example.com", plan: "Pro 500" },
    ]),
    catalog = new Catalog();
  try {
    await catalog.refresh();
    expect(catalog.available.find(m => m.account === "")?.account_name).toBe("user@example.com");
    expect(catalog.available.find(m => m.account === "/pi/work")?.account_name).toBe("user@example.com · Work");
    expect(catalog.available.every(m => m.plan === "Pro 500")).toBe(true);
  } finally {
    catalog.close();
    read.mockRestore();
    known.mockRestore();
    installed.mockRestore();
  }
});
