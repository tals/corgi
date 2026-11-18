import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { State, Cache } from "./account_cache";
import { Info, Window, expired } from "./account";
import { Text } from "../providers/common";
import { scopedEnv } from "../fixtures/env";
const monthly = {
  used_minor: 59,
  limit_minor: 1000000,
  currency: "USD",
  exponent: 2,
  period_start: 1,
  reset_at: 90000,
};
test("partial account refresh retains usage until a fresh reading or sign-out", () => {
  const s = new State(),
    fresh = new Info();
  fresh.signed_in = true;
  fresh.account = new Text("user@example.com");
  fresh.limits = {
    windows: [new Window({ minutes: 300, used: 12, reset_at: 1700001000 }), null],
  };
  s.update(fresh, 1000);
  fresh.limits = "none";
  s.update(fresh, 1100);
  expect((s.display(1100).limits as any).windows[0].used).toBe(12);
  expect(s.info.usage_fetched_at).toBe(1000);
  const first = s.display(1100).limits;
  if (typeof first === "string") throw Error("ExpectedWindows");
  expect(first.windows[0]!.reset_at).toBe(1700001000);
  fresh.limits = { windows: [new Window({ minutes: 300, used: 14 }), null] };
  s.update(fresh, 1200);
  expect(s.info.usage_fetched_at).toBe(1200);
  const next = s.display(1200).limits;
  if (typeof next === "string") throw Error("ExpectedWindows");
  expect(next.windows[0]!.used).toBe(14);
  s.update(Object.assign(new Info(), { signed_in: false }), 1300);
  expect(s.info.limits).toBe("none");
});
test("locked account cache restores metadata and discards obsolete fetch state", async () => {
  const dir = mkdtempSync(tmpdir() + "/corgi-ts-cache-");
  using env = scopedEnv({ XDG_STATE_HOME: dir });
  try {
    const c = await Cache.open("claude", "user");
    c.state.info.account = new Text("user");
    c.state.info.spend = monthly;
    c.state.info.usage_fetched_at = 1700000000;
    Object.assign(c.state, { next_usage: 1700000100, next_profile: 1700000200, rate_limited: true });
    c.save();
    c.close();
    const next = await Cache.open("claude", "user");
    expect(next.state.info.account.text()).toBe("user");
    expect(next.state.info.spend).toEqual(monthly);
    expect(next.state).not.toHaveProperty("next_usage");
    expect(next.state).not.toHaveProperty("next_profile");
    expect(next.state).not.toHaveProperty("rate_limited");
    expect(next.state.display(1700000000).usage_error.text()).toBe("");
    next.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spend survives a failed refresh without becoming fresh and clears on disable or signout", () => {
  const state = new State();
  const fresh = Object.assign(new Info(), { signed_in: true, limits: "metered", spend: monthly });
  state.update(fresh, 1000);
  state.update(Object.assign(new Info(), { signed_in: true, usage_error: new Text("failed") }), 1100);
  expect(state.info.spend).toEqual(monthly);
  expect(state.info.usage_fetched_at).toBe(1000);
  expect(state.display(1600).usage_error.text()).toBe("failed");
  state.update(fresh, 1700);
  expect(state.display(2900).usage_error.text()).toBe("last success 20m+ ago");
  state.update(Object.assign(new Info(), { signed_in: true, limits: "metered" }), 1800);
  expect(state.info.spend).toBeNull();
  state.update(fresh, 1900);
  state.update(Object.assign(new Info(), { signed_in: false }), 2000);
  expect(state.info.spend).toBeNull();
});

test("usage age follows successful fetches and expires at twenty minutes", () => {
  const state = new State(),
    fresh = new Info();
  fresh.signed_in = true;
  fresh.limits = {
    windows: [null, new Window({ minutes: 10080, used: 48, reset_at: 90000 })],
  };
  state.update(fresh, 1000);
  state.update(Object.assign(new Info(), { signed_in: true }), 1500);
  const recent = state.display(2199);
  expect(typeof recent.limits === "object" && recent.limits.windows[1]?.used).toBe(48);
  expect(expired(recent.usage_fetched_at, 2199)).toBe(false);
  const old = state.display(2200);
  expect(typeof old.limits).toBe("object");
  expect(expired(old.usage_fetched_at, 2200)).toBe(true);
  expect(state.info.usage_fetched_at).toBe(1000);
  state.update(fresh, 2201);
  expect(expired(state.display(2201).usage_fetched_at, 2201)).toBe(false);
  state.info.usage_fetched_at = 0;
  expect(state.display(2201).usage_error.text()).toBe("fetch time unknown");
});
test("usage failures preserve recent readings and give stale readings a reason", () => {
  const state = new State(),
    fresh = new Info();
  fresh.signed_in = true;
  fresh.limits = { windows: [null, new Window({ minutes: 10080, used: 48 })] };
  state.update(fresh, 1000);
  state.failed("account read failed");
  expect(typeof state.display(1100).limits === "object" && (state.display(1100).limits as any).windows[1]?.used).toBe(
    48,
  );
  expect(state.display(1600).usage_error.text()).toBe("account read failed");
  state.update(fresh, 1601);
  expect(state.info.usage_error.len).toBe(0);
  expect(state.display(2801).usage_error.text()).toBe("last success 20m+ ago");
  const empty = new State();
  empty.failed("account read failed");
  expect(empty.display(1000).limits).toBe("none");
});
