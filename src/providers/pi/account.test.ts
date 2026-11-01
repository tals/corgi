import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyUsage } from "./account";
import { open } from "./launcher";
import { Info } from "../../usage/account";
import { Quit } from "../../subprocess";

const usage = {
  plan_type: "pro",
  rate_limit: {
    primary_window: { used_percent: 12.4, limit_window_seconds: 18000, reset_at: 1800000000 },
    secondary_window: { used_percent: 37, limit_window_seconds: 604800, reset_at: 1800500000 },
  },
};
let root: string, account: string, executable: string | undefined, state: string | undefined;
let request: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "corgi-pi-usage-"));
  account = join(root, "account");
  mkdirSync(account);
  executable = process.env.CORGI_PI_BIN;
  state = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = root;
  process.env.CORGI_PI_BIN = join(root, "pi");
  writeFileSync(
    process.env.CORGI_PI_BIN,
    `#!${process.execPath}
import { writeFileSync } from "node:fs";
import { join } from "node:path";
writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "auth-probe.json"), JSON.stringify(process.argv.slice(2)));
console.log("fresh-secret-token");
`,
    { mode: 0o755 },
  );
  auth();
  request = spyOn(globalThis, "fetch").mockResolvedValue(Response.json(usage));
});
afterEach(() => {
  request.mockRestore();
  if (executable === undefined) delete process.env.CORGI_PI_BIN;
  else process.env.CORGI_PI_BIN = executable;
  if (state === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = state;
  rmSync(root, { recursive: true, force: true });
});
function auth(provider = "openai-codex", type = "oauth", email = "user@example.com") {
  writeFileSync(join(account, "settings.json"), JSON.stringify({ defaultProvider: provider }));
  writeFileSync(
    join(account, "auth.json"),
    JSON.stringify({
      [provider]: {
        type,
        access: "old-secret",
        refresh: "refresh-secret",
        accountId: "workspace",
        email,
        key: "api-secret",
      },
    }),
  );
}

test("Pi shows ChatGPT usage and its reset windows without a cached suffix", async () => {
  const launcher = open(account);
  try {
    const info = await launcher.account(new Quit(), 60);
    expect(info.account.text()).toBe("user@example.com");
    expect(info.plan.text()).toBe("Pro 200");
    expect(info.signed_in).toBe(true);
    expect(info.usage_fetched_at).toBeGreaterThan(0);
    expect(info.limits).toMatchObject({
      windows: [
        { used: 12, minutes: 300, reset_at: 1800000000 },
        { used: 37, minutes: 10080, reset_at: 1800500000 },
      ],
    });
    expect(JSON.parse(readFileSync(join(account, "auth-probe.json"), "utf8"))).toEqual([
      "auth",
      "print-bearer-token",
      "--provider",
      "openai-codex",
    ]);
    expect(request).toHaveBeenCalledTimes(1);
    const [url, options] = request.mock.calls[0]!;
    expect(url).toBe("https://chatgpt.com/backend-api/wham/usage");
    expect(options?.headers).toEqual({ Authorization: "Bearer fresh-secret-token", "ChatGPT-Account-Id": "workspace" });
    expect(options?.redirect).toBe("error");
    await launcher.account(new Quit(), 60);
    expect(request).toHaveBeenCalledTimes(1);
    const cached = readdirSync(join(root, "corgi/account-previews"));
    expect(cached).toHaveLength(1);
    const content = readFileSync(join(root, "corgi/account-previews", cached[0]!), "utf8");
    expect(content).not.toContain("secret");
  } finally {
    launcher.close();
  }
});

test("Pi leaves missing account identity empty for the viewer to label", async () => {
  rmSync(join(account, "settings.json"));
  rmSync(join(account, "auth.json"));
  const launcher = open(account);
  try {
    const info = await launcher.account(new Quit(), 60);
    expect(info.account.text()).toBe("");
    expect(info.signed_in).toBeNull();
    expect(request).not.toHaveBeenCalled();
  } finally {
    launcher.close();
  }
});

test.each([
  ["prolite", "Pro 100"],
  ["pro", "Pro 200"],
  ["promax", "Pro 500"],
  ["team", "Business"],
  ["future_plan", "Future Plan"],
])("Pi formats the ChatGPT plan %s as %s", async (plan, label) => {
  request.mockResolvedValue(Response.json({ ...usage, plan_type: plan }));
  const launcher = open(account);
  try {
    expect((await launcher.account(new Quit(), 60)).plan.text()).toBe(label);
  } finally {
    launcher.close();
  }
});

test.each(["anthropic", "custom"])("Pi keeps %s identity without inventing quota", async provider => {
  auth(provider);
  const launcher = open(account);
  try {
    const info = await launcher.account(new Quit(), 60);
    expect(info.account.text()).toBe("user@example.com");
    expect(info.plan.text()).toBe("OAuth");
    expect(info.limits).toBe("none");
    expect(info.signed_in).toBeNull();
    expect(request).not.toHaveBeenCalled();
  } finally {
    launcher.close();
  }
});

test("Pi API keys do not query subscription quota", async () => {
  auth("openai-codex", "api_key");
  const launcher = open(account);
  try {
    const info = await launcher.account(new Quit(), 60);
    expect(info.account.text()).toBe("openai-codex API key");
    expect(info.plan.text()).toBe("API key");
    expect(info.signed_in).toBeNull();
    expect(request).not.toHaveBeenCalled();
  } finally {
    launcher.close();
  }
});

test("Pi does not borrow another provider's account or quota", async () => {
  writeFileSync(join(account, "settings.json"), JSON.stringify({ defaultProvider: "custom" }));
  const launcher = open(account);
  try {
    const info = await launcher.account(new Quit(), 60);
    expect(info.account.text()).toBe("custom");
    expect(info.plan.text()).toBe("");
    expect(info.limits).toBe("none");
    expect(request).not.toHaveBeenCalled();
  } finally {
    launcher.close();
  }
});

test("a failed Pi usage refresh retains the last reading without making it fresh", async () => {
  const launcher = open(account),
    again = open(account);
  try {
    const first = await launcher.account(new Quit(), 60);
    request.mockResolvedValue(Response.json({}, { status: 429 }));
    const failed = await launcher.account(new Quit(), 0);
    expect(failed.limits).toEqual(first.limits);
    expect(failed.usage_fetched_at).toBe(first.usage_fetched_at);
    expect(failed.usage_error.text()).toBe("usage request failed");
    // Once the reading is old, the folder that failed waits; another signed
    // in to the account may try.
    setSystemTime(new Date(Date.now() + 120_000));
    await launcher.account(new Quit(), 60);
    expect(request).toHaveBeenCalledTimes(2);
    request.mockResolvedValue(Response.json(usage));
    expect((await again.account(new Quit(), 60)).usage_error.text()).toBe("");
    expect((await launcher.account(new Quit(), 60)).usage_error.text()).toBe("");
    expect(request).toHaveBeenCalledTimes(3);
    auth("openai-codex", "oauth", "other@example.com");
    request.mockResolvedValue(Response.json({}, { status: 401 }));
    const other = await again.account(new Quit(), 60);
    expect(other.account.text()).toBe("other@example.com");
    expect(other.signed_in).toBeNull();
    expect(other.limits).toBe("none");
  } finally {
    setSystemTime();
    launcher.close();
    again.close();
  }
});

test.each(["cancel", "close"])("Pi usage requests stop on %s", async mode => {
  const launcher = open(account),
    quit = new Quit();
  let ready!: () => void;
  const started = new Promise<void>(resolve => {
    ready = resolve;
  });
  request.mockImplementation(
    ((_url, options) =>
      new Promise<Response>((_resolve, reject) => {
        options!.signal!.addEventListener("abort", () => reject(Error("Cancelled")), { once: true });
        ready();
      })) as typeof fetch,
  );
  try {
    const pending = launcher.account(quit, 60);
    await started;
    if (mode === "cancel") quit.signal();
    else launcher.close();
    expect((await pending).limits).toBe("none");
  } finally {
    launcher.close();
  }
});

test("Pi usage parsing keeps zero and rejects missing or invalid percentages", () => {
  const info = new Info();
  applyUsage(info, { rate_limit: { primary_window: { used_percent: 0 } } });
  expect(info.limits).toMatchObject({ windows: [{ used: 0, minutes: null, reset_at: null }, null] });
  for (const value of [null, {}, { rate_limit: { primary_window: { used_percent: 101 } } }])
    expect(() => applyUsage(new Info(), value)).toThrow("UsageUnavailable");
});
