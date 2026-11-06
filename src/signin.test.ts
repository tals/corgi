import { expect, spyOn, test } from "bun:test";
import { adding, link, Signin } from "./signin";
import * as discovery from "./discovery";
import { signin as claude } from "./providers/claude/signin";
import { signin as codex } from "./providers/codex/signin";

test("account creation resolves installed agents before selecting the only provider", async () => {
  const pending = Promise.withResolvers<void>(),
    check = spyOn(discovery, "check").mockReturnValue(pending.promise),
    installed = spyOn(discovery, "installed").mockReturnValue(false),
    begin = spyOn(Signin.prototype, "begin").mockResolvedValue(),
    signin = adding(null, null, { changed() {}, done() {} });
  try {
    signin.cwd = "/workspace";
    const opened = signin.open(80, 24);
    expect(check).toHaveBeenCalledWith("/workspace");
    expect(begin).not.toHaveBeenCalled();
    installed.mockImplementation(p => p === "codex");
    pending.resolve();
    await opened;
    expect(signin.provider).toBe("codex");
    expect(begin).toHaveBeenCalledTimes(1);
  } finally {
    pending.resolve();
    signin.abandon();
    begin.mockRestore();
    installed.mockRestore();
    check.mockRestore();
  }
});

// Screens the agents showed on their first run, as their text reads.
const claude_method = `Claude Code can be used with your Claude subscription or billed based on API usage through your Console
account.
Select login method:

❯ 1. Claude account with subscription · Pro, Max, Team, or Enterprise
  2. Anthropic Console account · API usage billing
  3. 3rd-party platform · Amazon Bedrock, Microsoft Foundry, Google Vertex AI`;
const url =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=Xl3Z95hLjuYYwJiFV4YFI1aVF8";
const wrapped = (cols: number) => url.match(new RegExp(`.{1,${cols}}`, "g"))!.join("\n");
const claude_code = ` Browser didn't open? Use the url below to sign in (c to copy)

${wrapped(112)}
 Hold Shift while selecting to use your terminal's native copy
 Paste code here if prompted >`;
const codex_method = `  Welcome to Codex, OpenAI's command-line coding agent
  Sign in with ChatGPT to use Codex as part of your paid plan
  or connect an API key for usage-based billing
> 1. Sign in with ChatGPT
     Usage included with Plus, Pro, Business, and Enterprise plans
  2. Sign in with Device Code
     Sign in from another device with a one-time code
  3. Provide your own API key
     Pay for what you use
  Press enter to continue`;
const codex_device = `  Welcome to Codex, OpenAI's command-line coding agent
  Finish signing in via your browser
  1. Open this link in your browser and sign in
  https://auth.openai.com/codex/device
  2. Enter this one-time code after you are signed in (expires in 15 minutes)
  BC99-D104U
  Press esc to cancel`;

test("each agent's sign-in screens read as its steps", () => {
  expect(claude.step(claude_method)).toBe("method");
  expect(claude.step(claude_code)).toBe("code");
  expect(claude.step("Choose the text style that looks best with your terminal")).toBeNull();
  expect(codex.step(codex_method)).toBe("method");
  expect(codex.step(codex_device)).toBe("device");
  expect(codex.step("If your browser did not open, navigate to this URL to authenticate:")).toBe("browser");
  expect(codex.step("› Ask Codex to do anything")).toBeNull();
});

test("an agent's sign-in is up once it asks how to sign in or fails", () => {
  expect(codex.started("")).toBe(false);
  expect(codex.started("  >_ OpenAI Codex (v0.163.0)\n     ~/app")).toBe(false);
  expect(codex.started(codex_method)).toBe(true);
  expect(codex.started(codex_device)).toBe(true);
  // Its prompt shows first, until its server says no one signed in.
  expect(codex.started("› Ask Codex to do anything")).toBe(false);
  expect(codex.started("Error: app server did not become ready")).toBe(true);
  expect(claude.started("")).toBe(false);
  expect(claude.started("Welcome to Claude Code")).toBe(true);
});

test("a sign-in link is joined back from the rows it wraps over", () => {
  expect(link(claude_code, 112)).toBe(url);
  expect(link(codex_device, 112)).toBe("https://auth.openai.com/codex/device");
  expect(link("Open https://example.com/a now", 80)).toBe("https://example.com/a");
  expect(link("nothing here", 80)).toBeNull();
});

test("ctrl c closes a stopped sign-in without retrying", async () => {
  const statuses: number[] = [];
  const s = new Signin(true, false, {
    changed() {},
    done(status) {
      statuses.push(status);
    },
  });
  const retry = spyOn(s, "start").mockResolvedValue();
  s.stopped("The agent closed before signing in.");
  await s.input("\x03");
  expect(statuses).toEqual([1]);
  expect(retry).not.toHaveBeenCalled();
});
test("an agent too old to sign in to says so and makes no account", async () => {
  const statuses: number[] = [];
  const s = new Signin(true, false, {
    changed() {},
    done(status) {
      statuses.push(status);
    },
  });
  s.provider = "pi";
  s.cwd = "/workspace";
  const resolve = spyOn(discovery, "resolve").mockRejectedValue(Error("ProviderTooOld")),
    outdated = spyOn(discovery, "outdated").mockReturnValue("0.84.2"),
    start = spyOn(s, "start").mockResolvedValue();
  try {
    await s.begin();
    expect(resolve).toHaveBeenCalledWith("pi", "/workspace");
    expect(s.stage.kind === "dialog" && s.stage.dialog.heading).toBe(
      "Pi 0.84.2 is too old: Corgi needs Pi 1.0.0 or newer. Update it, then try again.",
    );
    expect(s.staged).toBeNull();
    expect(start).not.toHaveBeenCalled();
    await s.input("\x1b");
    expect(statuses).toEqual([1]);
  } finally {
    resolve.mockRestore();
    outdated.mockRestore();
  }
});
