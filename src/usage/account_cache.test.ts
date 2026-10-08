import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { State, response, nextAttempt, Cache } from "./account_cache";
import { Info, Window, expired } from "./account";
import { Text } from "../providers/common";
test("HTTP retry gate honors seconds and dates with a one-minute floor", () => {
  const now = 1700000000;
  expect(
    nextAttempt(response("HTTP/2 429\r\nRetry-After: 120\r\n\r\n{}", now), now),
  ).toBe(now + 120);
  expect(nextAttempt({ status: 429, retry_at: null, body: "" }, now)).toBe(
    now + 300,
  );
  expect(nextAttempt({ status: 429, retry_at: now + 1, body: "" }, now)).toBe(
    now + 60,
  );
  const r = response(
    "HTTP/1.1 200 Connection established\r\n\r\nHTTP/2 429\r\nretry-after: Tue, 14 Nov 2023 22:15:20 GMT\r\n\r\n{}",
    now,
  );
  expect(nextAttempt(r, now)).toBe(now + 120);
  expect(r.body).toBe("{}");
});
test("partial account refresh retains usage until a fresh reading or sign-out", () => {
  const s = new State(),
    fresh = new Info();
  fresh.signed_in = true;
  fresh.account = new Text("user@example.com");
  fresh.limits = {
    windows: [
      new Window({ minutes: 300, used: 12, reset_at: 1700001000 }),
      null,
    ],
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
test("locked public account cache persists and reconstructs metadata values", async () => {
  const dir = mkdtempSync(tmpdir() + "/corgi-ts-cache-"),
    prior = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = dir;
  try {
    const c = await Cache.open("claude", "user");
    c.state.info.account = new Text("user");
    c.state.next_usage = 1700000100;
    c.save();
    c.close();
    const next = await Cache.open("claude", "user");
    expect(next.state.next_usage).toBe(1700000100);
    expect(next.state.info.account.text()).toBe("user");
    next.close();
  } finally {
    if (prior === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("usage age follows successful fetches and expires at ten minutes", () => {
  const state = new State(),
    fresh = new Info();
  fresh.signed_in = true;
  fresh.limits = {
    windows: [null, new Window({ minutes: 10080, used: 48, reset_at: 90000 })],
  };
  state.update(fresh, 1000);
  state.rate_limited = true;
  state.next_usage = 2000;
  state.update(Object.assign(new Info(), { signed_in: true }), 1500);
  const recent = state.display(1599);
  expect(
    typeof recent.limits === "object" && recent.limits.windows[1]?.used,
  ).toBe(48);
  expect(expired(recent.usage_fetched_at, 1599)).toBe(false);
  const old = state.display(1600);
  expect(typeof old.limits).toBe("object");
  expect(expired(old.usage_fetched_at, 1600)).toBe(true);
  expect(state.info.usage_fetched_at).toBe(1000);
  state.update(fresh, 1601);
  expect(expired(state.display(1601).usage_fetched_at, 1601)).toBe(false);
  state.info.usage_fetched_at = 0;
  state.rate_limited = false;
  expect(state.display(1601).usage_error.text()).toBe("fetch time unknown");
});
test("usage failures preserve recent readings and give stale readings a reason", () => {
  const state = new State(),
    fresh = new Info();
  fresh.signed_in = true;
  fresh.limits = { windows: [null, new Window({ minutes: 10080, used: 48 })] };
  state.update(fresh, 1000);
  state.failedResponse(429);
  expect(
    typeof state.display(1100).limits === "object" &&
      (state.display(1100).limits as any).windows[1]?.used,
  ).toBe(48);
  expect(state.display(1600).usage_error.text()).toBe("server returned 429");
  state.failedResponse(503);
  expect(state.display(1600).usage_error.text()).toBe("server returned 503");
  state.failedResponse(0);
  expect(state.display(1600).usage_error.text()).toBe("request failed");
  state.update(fresh, 1601);
  expect(state.info.usage_error.len).toBe(0);
  expect(state.display(2201).usage_error.text()).toBe("last success 10m+ ago");
  const empty = new State();
  empty.failedResponse(429);
  expect(empty.display(1000).limits).toBe("rate_limited");
  empty.failedResponse(503);
  expect(empty.display(1000).limits).toBe("none");
});
