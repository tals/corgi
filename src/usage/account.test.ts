import { test, expect } from "bun:test";
import {
  limits,
  Window,
  claudeAccount,
  codexAccount,
  resetCountdown,
} from "./account";
import { timestampMs } from "../providers/common";
test("signed out and API accounts do not borrow subscription details", () => {
  const out = claudeAccount({
    loggedIn: false,
    email: "old@example.com",
    subscriptionType: "max",
    accessToken: "secret",
  });
  expect(out.account.text()).toBe("Not signed in");
  expect(out.plan.text()).toBe("");
  const api = codexAccount({
    type: "apiKey",
    planType: "pro",
    email: "old@example.com",
  });
  expect(api.account.text()).toBe("API key");
  expect(api.plan.text()).toBe("API");
  expect(api.limits).toBe("metered");
  for (const authMethod of ["api_key", "api_key_helper", "third_party"]) {
    const claude = claudeAccount({ loggedIn: true, authMethod });
    expect(claude.signed_in).toBe(true);
    expect(claude.limits).toBe("metered");
  }
});
test("reset countdown rounds up and belongs to its window", () => {
  for (const [at, label] of [
    [99, "now"],
    [101, "1m"],
    [8200, "2h 15m"],
    [273700, "3d 4h"],
  ] as const)
    expect(resetCountdown(at, 100)).toBe(label);
  const codex = limits(
    {
      primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 8200 },
      secondary: {
        usedPercent: 63,
        windowDurationMins: 10080,
        resetsAt: 273700,
      },
    },
    "codex",
  );
  expect(typeof codex).toBe("object");
  if (typeof codex === "object") {
    expect(codex.windows[0]?.countdown(100)).toBe("2h 15m");
    expect(codex.windows[1]?.countdown(100)).toBe("3d 4h");
  }
  const claude = limits(
    {
      five_hour: {
        utilization: 12,
        resets_at: "2026-09-24T12:00:00.000000+00:00",
      },
      seven_day: { utilization: 48, resets_at: "2026-09-27T16:00:00Z" },
    },
    "claude",
  );
  const now = timestampMs("2026-09-24T10:00:00Z")! / 1000;
  if (typeof claude === "object") {
    expect(claude.windows[0]?.countdown(now)).toBe("2h");
    expect(claude.windows[1]?.countdown(now)).toBe("3d 6h");
  }
  expect(new Window({ used: 48 }).countdown(now)).toBeNull();
});
