import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scopedEnv } from "../../fixtures/env";
import * as log from "../../log";
import { Quit } from "../../subprocess";
import { Info } from "../../usage/account";
import { timestampMs } from "../common";
import { applyUsage } from "./account";
import { configured, directory } from "./config";
import { open } from "./launcher";

const usageReply = {
  conversation_id: "",
  status: "SUCCESS",
  response: "",
  duration_seconds: 0,
  num_turns: 0,
  command: {
    name: "usage",
    data: {
      groups: [
        {
          name: "Gemini Models",
          description:
            "Models within this group: Gemini 4 Neon, Gemini 4 Hydrogen, Orchestrator (Neon), Gemini 3.8 Flash",
          buckets: [
            {
              id: "gemini-weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remaining_fraction: 0.924,
              reset_time: "2026-12-05T16:53:05Z",
            },
            {
              id: "gemini-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remaining_fraction: 0.704,
              reset_time: "2026-11-28T21:53:05Z",
            },
          ],
        },
        {
          name: "Claude and GPT models",
          description: "Models within this group: Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B",
          buckets: [
            {
              id: "3p-weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remaining_fraction: 0.55,
              reset_time: "2026-12-06T00:00:00Z",
            },
            {
              id: "3p-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remaining_fraction: 1,
              reset_time: "1970-01-01T00:00:00Z",
            },
          ],
        },
      ],
    },
  },
};

let root: string, account: string, dir: string, state: string, env: Disposable;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "corgi-agy-account-"));
  account = join(root, "home");
  dir = directory(account);
  state = join(root, "fake-state.json");
  mkdirSync(dir, { recursive: true });
  env = scopedEnv({
    XDG_STATE_HOME: root,
    CORGI_ANTIGRAVITY_BIN: join(root, "agy"),
    GEMINI_API_KEY: undefined,
    CORGI_PANE: "7",
    CORGI_SOCKET: "/tmp/corgi.sock",
  });
  writeFileSync(
    join(root, "agy"),
    `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
const cfg = JSON.parse(readFileSync(${JSON.stringify(state)}, "utf8"));
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(root, "calls.jsonl"))}, JSON.stringify({
  args,
  cwd: process.cwd(),
  home: process.env.HOME,
  autoUpdate: process.env.AGY_CLI_DISABLE_AUTO_UPDATE,
  pane: process.env.CORGI_PANE ?? null,
  socket: process.env.CORGI_SOCKET ?? null,
}) + "\\n");
if (args[0] === "models") {
  if (cfg.modelsHang) { await new Promise(() => {}); }
  if (cfg.modelsError) {
    process.stderr.write(cfg.modelsStderr ?? "network error\\n");
    process.exit(cfg.modelsExit ?? 1);
  }
  process.stdout.write(cfg.modelsOut ?? "gemini-4-hydrogen-high\\tGemini 4 Hydrogen (High)\\n");
  process.exit(0);
}
if (cfg.usageHang) { await new Promise(() => {}); }
if (cfg.usageAuthPrompt) {
  process.stderr.write("Authentication required. Please visit the URL to log in:\\nWaiting for authentication (timeout 60s)...\\n");
  await new Promise(() => {});
}
if (cfg.usageError) {
  process.stderr.write(cfg.usageStderr ?? "usage error\\n");
  process.exit(cfg.usageExit ?? 1);
}
process.stdout.write(JSON.stringify(cfg.usage ?? ${JSON.stringify(usageReply)}));
`,
    { mode: 0o755 },
  );
  setState({});
});

afterEach(() => {
  setSystemTime();
  env[Symbol.dispose]();
  rmSync(root, { recursive: true, force: true });
});

function setState(value: Record<string, unknown>) {
  writeFileSync(state, JSON.stringify(value));
}

function setToken(email = "user@example.com") {
  writeFileSync(
    join(dir, "antigravity-oauth-token"),
    JSON.stringify({
      token: { access_token: "secret-access", refresh_token: "secret-refresh" },
      id_token_email: email,
    }),
  );
}

function setSettings(value: Record<string, unknown>) {
  writeFileSync(join(dir, "settings.json"), JSON.stringify(value));
}

function calls(): Array<{
  args: string[];
  cwd: string;
  home: string;
  autoUpdate: string;
  pane: string | null;
  socket: string | null;
}> {
  try {
    return readFileSync(join(root, "calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

test("applyUsage converts remaining fractions, orders windows, picks the configured model group, and ignores epoch resets", () => {
  const gemini = new Info();
  applyUsage(gemini, usageReply);
  expect(gemini.signed_in).toBe(true);
  expect(gemini.limits).toMatchObject({
    windows: [
      { minutes: 300, used: 30, reset_at: timestampMs("2026-11-28T21:53:05Z")! / 1000 },
      { minutes: 10080, used: 8, reset_at: timestampMs("2026-12-05T16:53:05Z")! / 1000 },
    ],
  });

  for (const model of ["Claude Opus 5.5 (High)", "claude-opus-5-5-medium", "GPT-OSS 120B (Medium)"]) {
    const partner = new Info();
    applyUsage(partner, usageReply, model);
    expect(partner.limits).toMatchObject({
      windows: [
        { minutes: 300, used: 0, reset_at: null },
        { minutes: 10080, used: 45, reset_at: timestampMs("2026-12-06T00:00:00Z")! / 1000 },
      ],
    });
  }

  for (const model of ["Orchestrator (Neon)", "gemini-pro-orchestrator-neon", "Gemini 4 Hydrogen (High)"]) {
    const picked = new Info();
    applyUsage(picked, usageReply, model);
    expect(picked.limits).toEqual(gemini.limits);
  }
});

test("applyUsage handles offsets, fractional seconds, single windows, disabled buckets, plan tiers, and invalid payloads", () => {
  const info = new Info();
  applyUsage(
    info,
    {
      status: "SUCCESS",
      command: {
        name: "usage",
        data: {
          plan_tier: "google_ai_pro",
          groups: [
            {
              name: "Claude and GPT models",
              description: "Models within this group: Claude Opus 5.5",
              buckets: [{ id: "3p-weekly", window: "weekly", remaining_fraction: 0.5, disabled: true }],
            },
            {
              name: "Gemini Models",
              description: "Models within this group: Gemini 4 Hydrogen",
              buckets: [
                {
                  id: "gemini-weekly",
                  window: "weekly",
                  remaining_fraction: 0.25,
                  reset_time: "2026-09-27T18:00:00.123456+02:00",
                },
              ],
            },
          ],
        },
      },
    },
    "Claude Opus 5.5 (High)",
  );
  // Disabled partner group falls back to the usable Gemini group.
  expect(info.plan.text()).toBe("Google Ai Pro");
  expect(info.limits).toMatchObject({
    windows: [{ minutes: 10080, used: 75, reset_at: timestampMs("2026-09-27T16:00:00Z")! / 1000 }, null],
  });

  const badReset = new Info();
  applyUsage(badReset, {
    status: "SUCCESS",
    command: {
      name: "quota",
      data: {
        groups: [
          {
            name: "Gemini Models",
            buckets: [{ id: "gemini-5h", remaining_fraction: 1, reset_time: "2026-09-24T12:00:00+24:00" }],
          },
        ],
      },
    },
  });
  expect(badReset.limits).toMatchObject({ windows: [{ minutes: 300, used: 0, reset_at: null }, null] });

  for (const invalid of [
    null,
    {},
    { status: "ERROR", command: { name: "usage", data: { groups: [] } } },
    { status: "SUCCESS", command: { name: "help", data: { groups: [] } } },
    { status: "SUCCESS", command: { name: "usage", data: { groups: [] } } },
    {
      status: "SUCCESS",
      command: {
        name: "usage",
        data: { groups: [{ name: "Gemini", buckets: [{ id: "gemini-5h", remaining_fraction: 1.1 }] }] },
      },
    },
    {
      status: "SUCCESS",
      command: {
        name: "usage",
        data: { groups: [{ name: "Gemini", buckets: [{ id: "gemini-5h", remaining_fraction: -0.1 }] }] },
      },
    },
  ])
    expect(() => applyUsage(new Info(), invalid)).toThrow("UsageUnavailable");
});

test("Antigravity launcher reads and caches usage limits without leaking credentials or panel env", async () => {
  setToken("dev@example.com");
  const launcher = open(account);
  try {
    const info = await launcher.account(new Quit(), 60, root);
    expect(info.signed_in).toBe(true);
    expect(info.account.text()).toBe("dev@example.com");
    expect(info.usage_fetched_at).toBeGreaterThan(0);
    expect(info.limits).toMatchObject({
      windows: [
        { minutes: 300, used: 30 },
        { minutes: 10080, used: 8 },
      ],
    });
    const probe = calls();
    expect(probe.map(c => c.args)).toEqual([
      ["models"],
      ["-p", "/usage", "--output-format", "json", "--settings", '{"disableSlashCommands":false}'],
    ]);
    for (const c of probe) {
      expect(c.cwd).toBe("/tmp");
      expect(c.home).toBe(account);
      expect(c.autoUpdate).toBe("true");
      expect(c.pane).toBeNull();
      expect(c.socket).toBeNull();
    }

    // Within max_age, no subprocess runs.
    await launcher.account(new Quit(), 60, root);
    expect(calls()).toHaveLength(2);

    const cached = readdirSync(join(root, "corgi/account-previews"));
    expect(cached).toHaveLength(1);
    const content = readFileSync(join(root, "corgi/account-previews", cached[0]!), "utf8");
    expect(content).not.toContain("secret");

    // Switching the configured model selects that model's quota group.
    setSettings({ model: "Claude Opus 5.5 (High)" });
    const switched = await launcher.account(new Quit(), 60, root);
    expect(switched.limits).toMatchObject({
      windows: [
        { minutes: 300, used: 0, reset_at: null },
        { minutes: 10080, used: 45 },
      ],
    });
  } finally {
    launcher.close();
  }
});

test("a failed Antigravity usage refresh retains the last reading, enforces per-client cooldown, and recovers", async () => {
  setToken("dev@example.com");
  const launcher = open(account),
    again = open(account),
    stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
  log.configure("serve", {});
  try {
    const first = await launcher.account(new Quit(), 60);
    setState({ usageError: true });
    const failed = await launcher.account(new Quit(), 0);
    expect(failed.limits).toEqual(first.limits);
    expect(failed.usage_fetched_at).toBe(first.usage_fetched_at);
    expect(failed.usage_error.text()).toBe("usage request failed");
    expect(stderr).toHaveBeenCalledTimes(1);

    // Same client waits during cooldown; another client signed into the same account may retry.
    setSystemTime(new Date(Date.now() + 120_000));
    const count = calls().length;
    await launcher.account(new Quit(), 60);
    expect(calls()).toHaveLength(count);

    setState({});
    expect((await again.account(new Quit(), 60)).usage_error.text()).toBe("");
    expect((await launcher.account(new Quit(), 60)).usage_error.text()).toBe("");

    // Switching email opens an isolated cache entry.
    setToken("other@example.com");
    setState({ usageError: true });
    const other = await again.account(new Quit(), 60);
    expect(other.account.text()).toBe("other@example.com");
    expect(other.signed_in).toBe(true);
    expect(other.limits).toBe("none");
  } finally {
    log.configure("test");
    stderr.mockRestore();
    launcher.close();
    again.close();
  }
});

test("Gemini API key configuration reports metered without invoking agy", async () => {
  setSettings({ modelProvider: "gemini" });
  expect(await configured(account)).toBe(false);
  const launcher = open(account);
  try {
    const missing = await launcher.account(new Quit(), 60);
    expect(missing.signed_in).toBe(false);
    expect(missing.limits).toBe("none");
    expect(calls()).toHaveLength(0);

    using _key = scopedEnv({ GEMINI_API_KEY: "test-key" });
    expect(await configured(account)).toBe(true);
    const ready = await launcher.account(new Quit(), 60);
    expect(ready.signed_in).toBe(true);
    expect(ready.account.text()).toBe("API key");
    expect(ready.plan.text()).toBe("API");
    expect(ready.limits).toBe("metered");
    expect(calls()).toHaveLength(0);
  } finally {
    launcher.close();
  }
});

test("Antigravity detects keyring sign-in, signed-out state, and revoked tokens without hanging on OAuth", async () => {
  const launcher = open(account);
  try {
    // Signed out with no token file: agy models reports sign-in required and /usage is never called.
    setState({ modelsError: true, modelsStderr: "Error: Please sign in to view available models.\n" });
    const signedOut = await launcher.account(new Quit(), 60);
    expect(signedOut.signed_in).toBe(false);
    expect(signedOut.limits).toBe("none");
    expect(calls().map(c => c.args)).toEqual([["models"]]);

    // Keyring / ADC login without antigravity-oauth-token on disk still reads usage.
    setState({});
    const keyring = await launcher.account(new Quit(), 0);
    expect(keyring.signed_in).toBe(true);
    expect(keyring.account.text()).toBe("Signed in");
    expect(keyring.limits).toMatchObject({
      windows: [
        { minutes: 300, used: 30 },
        { minutes: 10080, used: 8 },
      ],
    });

    // If /usage ever prompts for interactive authentication, it aborts immediately and clears cached limits.
    setState({ usageAuthPrompt: true });
    const revoked = await launcher.account(new Quit(), 0);
    expect(revoked.signed_in).toBe(false);
    expect(revoked.limits).toBe("none");
    expect(revoked.usage_error.text()).toBe("");
  } finally {
    launcher.close();
  }
});

test.each(["cancel", "close"])("Antigravity usage requests stop on %s without caching an error", async mode => {
  setToken("dev@example.com");
  setState({ usageHang: true });
  const launcher = open(account),
    quit = new Quit();
  try {
    const pending = launcher.account(quit, 60);
    while (!calls().some(c => c.args[0] === "-p")) await Bun.sleep(10);
    if (mode === "cancel") quit.signal();
    else launcher.close();
    const info = await pending;
    expect(info.limits).toBe("none");
    expect(info.usage_error.text()).toBe("");
  } finally {
    launcher.close();
  }
});
