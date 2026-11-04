import { expect, test } from "bun:test";
import * as usageReport from "./usage_report";
import { preview } from "./agent_launcher";
import { Row } from "./launch/row";
import { Window } from "./usage/account";
import type { Login } from "./providers/adapter";
import { Provider } from "./providers";
import * as sim from "./providers/sim";

const now = 1792663200;
const month = { period_start: now - 10 * 86400, reset_at: now + 20 * 86400 };
const pi_dir = "/home/me/.pi-work";
const codex_work = "/home/me/.codex-work";
/** Who signed in where: the default Codex and Pi's folder share one ChatGPT login. */
const logins: Record<string, Login> = {
  "codex:": { id: "u/ws-1", email: "Me@home.dev", service: "chatgpt", workspace: "ws-1" },
  [`pi:${pi_dir}`]: { id: "openai-codex:u/ws-1", email: "me@home.dev", service: "chatgpt", workspace: "ws-1" },
  [`codex:${codex_work}`]: { id: "u/ws-2", email: "me@home.dev", service: "chatgpt", workspace: "ws-2" },
  "claude:": { id: "u/org-1", email: "me@home.dev", service: "claude", workspace: "org-1" },
  "omp:": { id: "anthropic:u/", email: "me@home.dev", service: "claude", workspace: "" },
};
const limits = (five: number | null, week: number | null) => ({
  usage_fetched_at: now,
  limits: {
    windows: [
      five === null ? null : new Window({ minutes: 300, used: five, reset_at: now + 3600 }),
      week === null ? null : new Window({ minutes: 10080, used: week, reset_at: now + 2 * 86400 }),
    ] satisfies [Window | null, Window | null],
  },
});
const report = (value: unknown, order: Row[] = []) => {
  const normalized = preview(value);
  for (const [provider, option] of Object.entries(normalized.options)) option.login = logins[`${provider}:`] ?? null;
  for (const entry of normalized.accounts) entry.option.login = logins[`${entry.provider}:${entry.account}`] ?? null;
  return usageReport.build(normalized, order, now);
};

test("one subscription shows once, as its own agent's account", () => {
  const value = {
    options: { codex: { account: "Me@home.dev", plan: "Pro", ...limits(42, 31) }, pi: { account: "me@home.dev" } },
    accounts: [
      { provider: "pi", account: pi_dir, name: "work", option: { account: "me@home.dev", ...limits(40, 30) } },
      { provider: "codex", account: codex_work, name: "team", option: { account: "me@home.dev", ...limits(7, null) } },
    ],
  };
  const accounts = report(value, [Row.of("pi", pi_dir), "codex"]);
  expect(accounts.map(a => [a.provider, a.name, a.shared])).toEqual([
    ["codex", "", [{ provider: "pi", name: "work" }]],
    ["codex", "team", []],
  ]);
  expect(accounts[0].limits).toEqual(limits(42, 31).limits);
  expect(accounts[1].limits).toEqual(limits(7, null).limits);
  expect(accounts[0].usage_fetched_at).toBe(now);
});

test("a registered provider represents only its own subscription", () => {
  for (const service of ["chatgpt", "claude", undefined] as const) {
    const remove = Provider.register({ ...sim.adapter, accounts: { ...sim.adapter.accounts, service } });
    try {
      const login: Login = { id: "u/A", email: "me@x.dev", service: "chatgpt", workspace: "A" },
        value = preview({
          options: { pi: { ...limits(20, 30), login }, [sim.sim]: { ...limits(1, 2), login } },
        }),
        [account] = usageReport.build(value, ["pi", sim.sim], now);
      expect(account.provider).toBe(service === "chatgpt" ? sim.sim : "pi");
      expect(account.shared).toEqual([{ provider: service === "chatgpt" ? "pi" : sim.sim, name: "" }]);
      expect(account.limits).toEqual(service === "chatgpt" ? limits(1, 2).limits : limits(20, 30).limits);
    } finally {
      remove();
    }
  }
});

test("window histories retain their samples, gaps and provider order", () => {
  const history: usageReport.Account["history"] = [
    [5, 9, null, 7],
    [10, 20, 15, ...Array(17).fill(30)],
  ];
  const [codex] = report({
    options: { codex: { account: "a@x.dev", ...limits(42, 31), history } },
  });
  expect(codex.limits).toEqual(limits(42, 31).limits);
  expect(codex.history).toEqual(history);
});

test("accounts follow the workspace's launcher order", () => {
  const value = {
    options: { codex: { account: "a@x.dev", ...limits(1, 2) }, claude: { account: "b@x.dev", ...limits(3, 4) } },
  };
  expect(report(value).map(a => a.provider)).toEqual(["codex", "claude"]);
  expect(report(value, ["claude"]).map(a => a.provider)).toEqual(["claude", "codex"]);
});

test("a credential that doesn't name its workspace folds in only where it can't be another", () => {
  const folded = report(
    {
      options: {
        claude: { account: "me@home.dev", ...limits(10, 5) },
        omp: { account: "me@home.dev", ...limits(10, 5) },
      },
    },
    ["omp", "claude"],
  );
  expect(folded.map(a => [a.provider, a.shared])).toEqual([["claude", [{ provider: "omp", name: "" }]]]);
});

test("signed-out accounts and ones without readings are left out, stale readings remain", () => {
  const accounts = report({
    options: {
      claude: { account: "a@x.dev", signed_in: false, ...limits(50, 20) },
      codex: { account: "b@x.dev", ...limits(10, 10), usage_fetched_at: now - 3600 },
      pi: { account: "", pending: true },
      omp: { account: "c@x.dev", limits: "rate_limited" },
    },
  });
  expect(accounts).toHaveLength(1);
  expect(accounts[0].provider).toBe("codex");
  expect(accounts[0].usage_fetched_at).toBe(now - 3600);
});

test("spend retains daily readings across billing periods without scaling or smoothing", () => {
  const spend = { used_minor: 38800, limit_minor: 25000000, currency: null, exponent: 2, ...month };
  const spend_daily = Array.from({ length: 30 }, (_, i) => ({
    day: Math.floor((now - (29 - i) * 86400) / 86400) * 86400,
    period_start: i < 19 ? month.period_start - 30 * 86400 : month.period_start,
    used_minor: i === 20 ? 100 : i * 4000,
  }));
  const [codex] = report({
    options: {
      codex: {
        account: "me@acme.dev",
        plan: "Enterprise",
        usage_fetched_at: now,
        limits: "metered",
        spend,
        spend_daily,
      },
    },
  });
  expect(codex.limits).toBe("metered");
  expect(codex.spend).toEqual(spend);
  expect(codex.spend_history).toEqual(spend_daily);
  expect(codex.spend_history).toHaveLength(30);
  expect(codex).not.toHaveProperty("amount");
  expect(codex).not.toHaveProperty("windows");
});

test("spend without a limit retains its units and billing period", () => {
  const spend = { used_minor: 1234, limit_minor: null, currency: "USD", exponent: 2, ...month };
  const [claude] = report({
    options: { claude: { account: "me@acme.dev", usage_fetched_at: now, limits: "metered", spend } },
  });
  expect(claude.spend).toEqual(spend);
  expect(claude.spend_history).toEqual([]);
});

test("limits and spend are both returned when the provider reports both", () => {
  const spend = { used_minor: 500, limit_minor: 5000, currency: "USD", exponent: 2, ...month };
  const [claude] = report({ options: { claude: { account: "me@home.dev", ...limits(20, 60), spend } } });
  expect(claude.limits).toEqual(limits(20, 60).limits);
  expect(claude.spend).toEqual(spend);
});

test("an expired billing period and a fetch error do not erase cached data", () => {
  const spend = {
    used_minor: 500,
    limit_minor: 5000,
    currency: "USD",
    exponent: 2,
    period_start: now - 31 * 86400,
    reset_at: now - 86400,
  };
  const [claude] = report({
    options: { claude: { usage_fetched_at: now - 3600, limits: "metered", spend, usage_error: "fetch failed" } },
  });
  expect(claude.spend).toEqual(spend);
  expect(claude.usage_error).toBe("fetch failed");
});

test("older previews without history do not invent readings", () => {
  const [codex] = report({ options: { codex: { ...limits(42, 31) } } });
  expect(codex.history).toEqual([[], []]);
  expect(codex.spend_history).toEqual([]);
});

test("unnamed workspaces cannot bridge distinct subscriptions in any launcher order", () => {
  const value = preview({
    options: {
      claude: { ...limits(10, 11), login: { id: "u/A", email: "me@x.dev", service: "claude", workspace: "A" } },
      omp: { ...limits(20, 21), login: { id: "u/", email: "me@x.dev", service: "claude", workspace: "" } },
    },
    accounts: [
      {
        provider: "claude",
        account: "/team",
        name: "team",
        option: { ...limits(30, 31), login: { id: "u/B", email: "me@x.dev", service: "claude", workspace: "B" } },
      },
    ],
  });
  // Use the same row spelling the launcher serializes.
  const rows: Row[] = ["claude", "omp", Row.of("claude", "/team")];
  for (const order of [rows, [rows[1], rows[0], rows[2]], [rows[2], rows[1], rows[0]], [rows[2], rows[0], rows[1]]]) {
    const accounts = usageReport.build(value, order, now);
    expect(accounts).toHaveLength(3);
    expect(accounts.every(a => a.shared.length === 0)).toBe(true);
    expect(accounts.map(a => a.limits)).toEqual(
      order.map(row =>
        row === "claude" ? limits(10, 11).limits : row === "omp" ? limits(20, 21).limits : limits(30, 31).limits,
      ),
    );
  }
});

test("grouping uses daemon login metadata and keeps older previews separate", () => {
  const value = preview({
    options: {
      codex: { ...limits(1, 2), login: { id: "u/A", email: "me@x.dev", service: "chatgpt", workspace: "A" } },
      pi: { ...limits(3, 4), login: { id: "openai:u/B", email: "me@x.dev", service: "chatgpt", workspace: "B" } },
    },
  });
  expect(usageReport.build(value, [], now)).toHaveLength(2);
  delete (value.options.pi as Partial<typeof value.options.pi>).login;
  const older = preview(value);
  expect(usageReport.build(older, [], now)).toHaveLength(2);
});
