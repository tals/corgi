import { test, expect } from "bun:test";
import { applyUsage, defaultModel } from "./claude";
import { Info } from "../usage/account";
import { Text } from "../providers";
test("Claude control usage preserves login on unsupported or malformed quota data", () => {
  const info = new Info();
  info.signed_in = true;
  info.account = new Text("account@example.com");
  expect(() => applyUsage(info, null)).toThrow("InvalidUsage");
  expect(() => applyUsage(info, { rate_limits_available: false })).toThrow("UsageUnavailable");
  expect(info.signed_in).toBe(true);
  expect(info.account.text()).toBe("account@example.com");
  expect(info.limits).toBe("none");
  applyUsage(info, {
    rate_limits_available: true,
    subscription_type: "pro",
    rate_limits: {
      five_hour: { utilization: 0 },
      seven_day: { utilization: 33 },
    },
  });
  expect(typeof info.limits).toBe("object");
  if (typeof info.limits === "object") {
    expect(info.limits.windows[0]?.used).toBe(0);
    expect(info.limits.windows[1]?.used).toBe(33);
  }
});

test("Claude initialize names the default model", () => {
  expect(
    defaultModel({
      models: [
        { value: "opus", resolvedModel: "claude-opus-5-5" },
        { value: "default", resolvedModel: "claude-sonnet-5-5" },
      ],
    }),
  ).toBe("claude-sonnet-5-5");
  expect(defaultModel(null)).toBe("");
});
