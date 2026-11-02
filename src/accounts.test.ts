import { afterEach, beforeEach, expect, test, spyOn } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import * as accounts from "./accounts";
import * as profiles from "./agent_profiles";
import * as accountCommand from "./account_command";
import * as signin from "./signin";
import { Launch } from "./runtime";
import { Info, Text, Window } from "./usage/account";

const saved = { ...process.env },
  variables = ["HOME", "CORGI_ENV_BASE", "XDG_STATE_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"];
let home = "";
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "corgi-accounts-")));
  process.env.HOME = home;
  process.env.CORGI_ENV_BASE = join(home, "state");
  for (const key of ["XDG_STATE_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) delete process.env[key];
  mkdirSync(join(home, ".claude"));
  accounts.reset();
});
afterEach(() => {
  for (const key of variables)
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  accounts.reset();
  rmSync(home, { recursive: true, force: true });
});
const signIn = (dir: string, email: string, id = email) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, ".claude.json"),
    JSON.stringify({ oauthAccount: { emailAddress: email, accountUuid: id, organizationUuid: "org" } }),
  );
};

test("default-only providers reject account creation before creating a folder", () => {
  expect(() => accounts.stage("opencode2", "work")).toThrow("AccountManagementUnsupported");
  expect(() => accounts.add("opencode2", "work", home)).toThrow("AccountManagementUnsupported");
  expect(accounts.known().filter(a => a.provider === "opencode2")).toEqual([]);
  expect(existsSync(accounts.path())).toBe(false);
});

test("an account is its settings folder, and the default's is none", () => {
  expect(accounts.normalize("claude", join(home, ".claude"))).toBe("");
  expect(accounts.normalize("claude", "~/.claude-work")).toBe(join(home, ".claude-work"));
  expect(accounts.of("claude", [["CLAUDE_CONFIG_DIR", "$HOME/.claude-work"]])).toBe(join(home, ".claude-work"));
  expect(accounts.of("claude", [["CLAUDE_CONFIG_DIR", "~/.claude"]])).toBe("");
  expect(accounts.of("claude", [["CODEX_HOME", "/elsewhere"]])).toBe("");
  expect(accounts.of("claude", [["CLAUDE_CONFIG_DIR", "$WORK/claude"]])).toBe("");
  expect(accounts.env("claude", "/a")).toEqual([["CLAUDE_CONFIG_DIR", "/a"]]);
  expect(accounts.env("claude", "")).toEqual([]);
});

test("public identities include resolved default folders and keep native accounts separate", () => {
  const dir = join(home, ".claude");
  expect(accounts.describe("claude", "")).toEqual({
    id: JSON.stringify(["claude", dir]),
    name: ".claude",
    directory: dir,
    loginId: null,
    email: null,
    type: null,
    plan: null,
    usage: null,
  });
  expect(accounts.describe("claude", accounts.normalize("claude", dir))?.id).toBe(accounts.describe("claude", "")?.id);
  expect(accounts.describe("codex", dir)?.id).not.toBe(accounts.describe("claude", "")?.id);
  expect(accounts.describe("opencode2", "/different-config")).toBeNull();
});

test("profile lookups expose the existing login key and cached structured metadata", () => {
  const one = join(home, ".claude-one"),
    two = join(home, ".claude-two");
  signIn(one, "me@example.com", "same-login");
  signIn(two, "me@example.com", "same-login");
  const a = accounts.describe("claude", one)!,
    b = accounts.describe("claude", two)!;
  expect(a.id).not.toBe(b.id);
  expect(a.loginId).toBe(accounts.identity("claude", one)!.id);
  expect(a.loginId).toBe(b.loginId);
  expect(a.usage).toBeNull();
  const info = Object.assign(new Info(), {
    email: "me@example.com",
    type: "oauth" as const,
    plan: new Text("Max"),
    usage_fetched_at: 1700000000,
    limits: { windows: [new Window({ used: 42, minutes: 300, reset_at: 1700000500 }), null] },
  });
  accounts.record("claude", one, info);
  expect(accounts.describe("claude", one)).toMatchObject({
    loginId: a.loginId,
    email: "me@example.com",
    type: "oauth",
    plan: "Max",
    usage: { fetched_at: 1700000000, limits: { windows: [{ used: 42, minutes: 300, reset_at: 1700000500 }, null] } },
  });
  expect(accounts.describe("claude", two)?.usage).toBeNull();
});

test("Omarchy's accounts show under their labels, and a folder named like one doesn't", async () => {
  signIn(join(home, ".claude-work"), "me@work.com");
  const side = join(home, ".local", "state", "omarchy", "agents", "accounts", "claude", "side");
  signIn(side, "me@side.com");
  writeFileSync(
    join(dirname(side), "..", "claude.json"),
    JSON.stringify({
      active: "main",
      accounts: [
        { id: "main", label: "Main", home: "", primary: true },
        { id: "side", label: "Side", home: side, primary: false },
        { id: "gone", label: "Gone", home: join(home, "missing"), primary: false },
      ],
    }),
  );
  expect(accounts.known()).toEqual([{ provider: "claude", dir: side, name: "Side", managed: false }]);
  expect(accounts.identity("claude", side)?.email).toBe("me@side.com");
  expect(accounts.named("claude/Side")?.dir).toBe(side);
  expect(accounts.named("codex/Side")).toBeNull();
  await accounts.remove(accounts.named("Side")!);
  expect(accounts.known()).toEqual([]);
});

test("the default account's login is read from HOME", () => {
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "me@home.com" } }));
  expect(accounts.identity("claude", "")).toEqual({ email: "me@home.com", id: "me@home.com/" });
});

test("a new account's numbered folder waits in a private temporary folder until its sign-in works out", () => {
  writeFileSync(join(home, ".claude", "CLAUDE.md"), "be terse");
  writeFileSync(join(home, ".claude", "settings.json"), '{"model":"opus"}');
  const s = accounts.stage("claude", "work"),
    dir = join(realpathSync(join(home, "state", "corgi", "accounts", "claude")), "1");
  expect(s.dir).toBe(dir);
  expect(readlinkSync(dir)).toBe(s.temp);
  expect(dirname(s.temp)).toBe(realpathSync(tmpdir()));
  expect(lstatSync(s.temp).mode & 0o777).toBe(0o700);
  expect(accounts.known()).toEqual([]);
  // It shares the default's setup, made there when missing, and keeps its
  // conversations.
  expect(readlinkSync(join(s.temp, "CLAUDE.md"))).toBe(join(home, ".claude", "CLAUDE.md"));
  expect(readlinkSync(join(s.temp, "settings.json"))).toBe(join(home, ".claude", "settings.json"));
  expect(readlinkSync(join(s.temp, "skills"))).toBe(join(home, ".claude", "skills"));
  expect(lstatSync(join(home, ".claude", "skills")).isDirectory()).toBe(true);
  expect(existsSync(join(s.temp, "projects"))).toBe(false);
  expect(existsSync(join(s.temp, "keybindings.json"))).toBe(false);
  signIn(dir, "me@work.com");
  const work = accounts.adopt(s);
  expect(work).toEqual({ provider: "claude", dir, name: "work", managed: true });
  expect(lstatSync(dir).isDirectory()).toBe(true);
  expect(existsSync(s.temp)).toBe(false);
  expect(readlinkSync(join(dir, "settings.json"))).toBe(join(home, ".claude", "settings.json"));
  expect(accounts.identity("claude", dir)?.email).toBe("me@work.com");
  expect(accounts.known()).toEqual([work]);
  expect(() => accounts.stage("claude", "work")).toThrow("AccountExists");
  expect(() => accounts.stage("claude", "default")).toThrow("InvalidAccountName");
  expect(() => accounts.stage("claude", " ")).toThrow("InvalidAccountName");
});

test("links its sign-in made to the staging folder lead into the folder once it moves in", () => {
  const s = accounts.stage("codex", "work"),
    release = join(s.temp, "packages", "daemon", "releases", "1");
  mkdirSync(release, { recursive: true });
  symlinkSync(release, join(s.temp, "packages", "daemon", "current"));
  const work = accounts.adopt(s);
  expect(readlinkSync(join(work.dir, "packages", "daemon", "current"))).toBe(
    join(work.dir, "packages", "daemon", "releases", "1"),
  );
  expect(readlinkSync(join(work.dir, "prompts"))).toBe(join(home, ".codex", "prompts"));
});

test("a new Codex account keeps its own sessions", () => {
  const s = accounts.stage("codex", "work");
  try {
    expect(existsSync(join(s.temp, "sessions"))).toBe(false);
    expect(readlinkSync(join(s.temp, "prompts"))).toBe(join(home, ".codex", "prompts"));
  } finally {
    accounts.unstage(s);
  }
});

test("cancelling a new account deletes its folder and leaves what it linked to", () => {
  writeFileSync(join(home, ".claude", "CLAUDE.md"), "be terse");
  const s = accounts.stage("claude", "work");
  signIn(s.dir, "me@work.com");
  mkdirSync(join(s.dir, "skills", "mine"), { recursive: true });
  writeFileSync(join(s.dir, "skills", "mine", "SKILL.md"), "a skill");
  accounts.unstage(s);
  expect(existsSync(s.dir) || existsSync(s.temp)).toBe(false);
  expect(readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8")).toBe("be terse");
  expect(existsSync(join(home, ".claude", "skills", "mine", "SKILL.md"))).toBe(true);
  expect(accounts.known()).toEqual([]);
  // Nothing but its own staged folder goes.
  accounts.unstage({ ...s, temp: join(home, ".claude") });
  expect(existsSync(join(home, ".claude", "CLAUDE.md"))).toBe(true);
});

test("a new account takes the number a cancelled sign-in left linked, never a real folder's", () => {
  const left = accounts.stage("claude");
  rmSync(left.temp, { recursive: true });
  const again = accounts.stage("claude");
  expect([again.dir, readlinkSync(again.dir)]).toEqual([left.dir, again.temp]);
  // One still signing in keeps its number.
  const next = accounts.stage("claude");
  expect(basename(next.dir)).toBe("2");
  accounts.unstage(again);
  accounts.unstage(next);
  mkdirSync(again.dir);
  symlinkSync(join(home, ".claude"), join(dirname(again.dir), "2"));
  const third = accounts.stage("claude");
  expect(basename(third.dir)).toBe("3");
  accounts.unstage(third);
  expect(lstatSync(again.dir).isDirectory() && existsSync(join(home, ".claude"))).toBe(true);
});

test("a new account is named for who signed in: the company at work, the mailbox at home", () => {
  const login = (email: string) => ({ email, id: email });
  expect(accounts.suggest("claude", login("me@acme.com"))).toBe("acme");
  expect(accounts.suggest("claude", login("me@work.example.com"))).toBe("work");
  expect(accounts.suggest("claude", login("Tal.Side@gmail.com"))).toBe("tal.side");
  expect(accounts.suggest("claude", login("x@default.io"))).toBe("account");
  expect(accounts.suggest("claude", null)).toBe("account");
  const s = accounts.stage("claude");
  signIn(s.dir, "me@acme.com");
  expect(accounts.adopt(s).name).toBe("acme");
  // Another login at the same company takes the next name; Codex has its own.
  expect(accounts.suggest("claude", login("you@acme.com"))).toBe("acme-2");
  expect(accounts.suggest("codex", login("you@acme.com"))).toBe("acme");
  expect(accounts.suggest("claude", login("me@acme.com"), s.dir)).toBe("acme");
});

test.each([
  "AOL.com",
  "hotmail.co.uk",
  "yahoo.co.jp",
  "pm.me",
  "fastmail.fm",
  "tuta.com",
  "gmx.de",
  "qq.com",
  "comcast.net",
])("a personal address at %s uses its mailbox for the account name", domain => {
  expect(accounts.suggest("claude", { email: ` Tal.Side@${domain} `, id: "id" })).toBe("tal.side");
});

test("personal mail hosts only match exact domains", () => {
  expect(accounts.suggest("claude", { email: "tal@gmail.corp", id: "id" })).toBe("gmail");
  expect(accounts.suggest("claude", { email: "tal@acme.co.uk", id: "id" })).toBe("acme");
});

test("renaming an account keeps its folder, and names one Omarchy keeps in Corgi's own list", () => {
  const s = accounts.stage("claude");
  signIn(s.dir, "me@acme.com");
  const acme = accounts.adopt(s);
  expect(accounts.rename(acme, "big")).toEqual({ ...acme, name: "big" });
  expect(accounts.known()).toEqual([{ ...acme, name: "big" }]);
  expect(() => accounts.rename(accounts.known()[0], "default")).toThrow("InvalidAccountName");
  const side = join(home, ".local", "state", "omarchy", "agents", "accounts", "claude", "side");
  mkdirSync(side, { recursive: true });
  writeFileSync(
    join(dirname(side), "..", "claude.json"),
    JSON.stringify({ accounts: [{ id: "side", label: "Side", home: side, primary: false }] }),
  );
  accounts.reset();
  expect(() => accounts.rename(accounts.named("Side")!, "big")).toThrow("AccountExists");
  accounts.rename(accounts.named("Side")!, "personal");
  accounts.reset();
  expect(accounts.known().map(a => [a.name, a.dir])).toEqual([
    ["big", acme.dir],
    ["personal", side],
  ]);
  expect(JSON.parse(readFileSync(join(dirname(side), "..", "claude.json"), "utf8")).accounts[0].label).toBe("Side");
});

test("the default account's name stays with the default, whoever signs in to it", () => {
  signIn(join(home, ".claude"), "me@acme.com");
  expect(accounts.defaultName("claude")).toBe("");
  accounts.renameDefault("claude", "acme");
  expect([accounts.defaultName("claude"), accounts.defaultName("codex")]).toEqual(["acme", ""]);
  // Another login, or another folder, is still the default.
  signIn(join(home, ".claude"), "you@gmail.com");
  process.env.CLAUDE_CONFIG_DIR = join(home, "elsewhere");
  accounts.reset();
  expect(accounts.defaultName("claude")).toBe("acme");
  // Its name is taken for the provider's other accounts, and kept as they change.
  const login = { email: "them@acme.com", id: "them" };
  expect(accounts.suggest("claude", login)).toBe("acme-2");
  expect(accounts.suggest("claude", login, "")).toBe("acme");
  expect(() => accounts.add("claude", "acme", mkdirSync(join(home, "big"), { recursive: true })!)).toThrow(
    "AccountExists",
  );
  const big = accounts.add("claude", "big", join(home, "big"));
  expect(() => accounts.renameDefault("claude", "big")).toThrow("AccountExists");
  accounts.rename(big, "bigger");
  expect(accounts.defaultName("claude")).toBe("acme");
  accounts.renameDefault("claude", "");
  expect(accounts.defaultName("claude")).toBe("");
  expect(JSON.parse(readFileSync(accounts.path(), "utf8")).defaults).toEqual({});
});

test("removing an account deletes a folder Corgi made, and only forgets another", async () => {
  writeFileSync(join(home, ".claude", "CLAUDE.md"), "be terse");
  const s = accounts.stage("claude");
  signIn(s.dir, "me@acme.com");
  const acme = accounts.adopt(s),
    mine = join(home, "accounts", "big-co");
  mkdirSync(mine, { recursive: true });
  const big = accounts.add("claude", "bigco", mine);
  await accounts.remove(acme);
  expect(existsSync(acme.dir)).toBe(false);
  expect(readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8")).toBe("be terse");
  await accounts.remove(big);
  expect(existsSync(mine)).toBe(true);
  expect(accounts.known()).toEqual([]);
  // Not one that says Corgi made it from somewhere else.
  await accounts.remove({ ...big, managed: true });
  expect(existsSync(mine)).toBe(true);
});

test("an imported folder under Corgi's account root is never owned, even if a caller says it is", async () => {
  const s = accounts.stage("claude");
  accounts.unstage(s);
  mkdirSync(s.dir);
  writeFileSync(join(s.dir, "keep"), "mine");
  const imported = accounts.add("claude", "mine", s.dir);
  await accounts.remove({ ...imported, managed: true });
  expect(readFileSync(join(s.dir, "keep"), "utf8")).toBe("mine");
  expect(accounts.known()).toEqual([]);
});

test("a managed folder replaced by a link cannot transfer ownership to its target", async () => {
  const s = accounts.stage("claude"),
    owned = accounts.adopt(s, "work"),
    external = join(dirname(s.dir), "external");
  mkdirSync(external);
  writeFileSync(join(external, "keep"), "mine");
  rmSync(owned.dir, { recursive: true });
  symlinkSync(external, owned.dir);
  accounts.reset();
  const linked = accounts.named("work")!;
  expect(linked).toMatchObject({ dir: external, managed: false });
  await accounts.remove(linked);
  expect(readFileSync(join(external, "keep"), "utf8")).toBe("mine");
  expect(lstatSync(owned.dir).isSymbolicLink()).toBe(true);
  expect(accounts.known()).toEqual([]);
});

test("a replacement directory and an old record without creation identity are only forgotten", async () => {
  const owned = accounts.adopt(accounts.stage("claude"), "work");
  renameSync(owned.dir, owned.dir + "-original");
  mkdirSync(owned.dir);
  writeFileSync(join(owned.dir, "keep"), "replacement");
  expect(await accounts.remove(owned)).toBe(false);
  expect(readFileSync(join(owned.dir, "keep"), "utf8")).toBe("replacement");
  writeFileSync(accounts.path(), JSON.stringify({ accounts: [owned] }));
  accounts.reset();
  expect(accounts.named("work")?.managed).toBe(false);
  expect(await accounts.remove(owned)).toBe(false);
  expect(readFileSync(join(owned.dir, "keep"), "utf8")).toBe("replacement");
});

test("a folder the user has joins under the name they give it, and forgetting it keeps it out", async () => {
  const mine = join(home, "accounts", "big-co");
  mkdirSync(mine, { recursive: true });
  const added = accounts.add("claude", "bigco", mine);
  expect(added).toEqual({ provider: "claude", dir: mine, name: "bigco", managed: false });
  expect(accounts.known().map(a => a.name)).toEqual(["bigco"]);
  expect(() => accounts.add("claude", "home", join(home, ".claude"))).toThrow("DefaultAccount");
  expect(() => accounts.add("claude", "gone", join(home, "missing"))).toThrow("FileNotFound");
  await accounts.remove(added);
  expect(accounts.known()).toEqual([]);
  expect(existsSync(mine)).toBe(true);
});

test("a removed folder, the user's or Omarchy's, is offered back until it's restored or gone", async () => {
  const mine = join(home, "accounts", "big-co"),
    side = join(home, ".local", "state", "omarchy", "agents", "accounts", "claude", "side");
  mkdirSync(mine, { recursive: true });
  signIn(side, "me@side.com");
  writeFileSync(
    join(dirname(side), "..", "claude.json"),
    JSON.stringify({ accounts: [{ id: "side", label: "Side", home: side, primary: false }] }),
  );
  await accounts.remove(accounts.add("claude", "bigco", mine));
  await accounts.remove(accounts.named("Side")!);
  // One Corgi made goes with its folder, so there's nothing to offer.
  const s = accounts.stage("claude");
  signIn(s.dir, "me@acme.com");
  await accounts.remove(accounts.adopt(s));
  expect(accounts.removed()).toEqual([
    { provider: "claude", dir: mine, name: "bigco", managed: false },
    { provider: "claude", dir: side, name: "Side", managed: false },
  ]);
  // A name taken meanwhile gets a number.
  accounts.add("claude", "bigco", mkdtempSync(join(home, "other-")));
  expect(accounts.restore("claude", mine)).toEqual({ provider: "claude", dir: mine, name: "bigco-2", managed: false });
  expect(accounts.forgotten(mine)).toBe(false);
  expect(accounts.removed().map(a => a.name)).toEqual(["Side"]);
  expect(() => accounts.restore("claude", mine)).toThrow("AccountNotFound");
  // A long name stays a valid one with its number.
  const long = "é".repeat(80),
    other = mkdtempSync(join(home, "long-"));
  await accounts.remove(accounts.add("claude", long, other));
  accounts.add("claude", long, mkdtempSync(join(home, "taken-")));
  const restored = accounts.restore("claude", other);
  expect(restored.name).toBe("é".repeat(79) + "-2");
  accounts.reset();
  expect(accounts.known().some(a => a.dir === other && a.name === restored.name)).toBe(true);
  rmSync(side, { recursive: true });
  accounts.reset();
  expect(accounts.removed()).toEqual([]);
});

test("a login one account has already is found in another", () => {
  signIn(join(home, ".claude"), "me@home.com", "home-id");
  const work = join(home, "work"),
    side = join(home, "side");
  signIn(work, "me@home.com", "home-id");
  signIn(side, "me@home.com", "team-id");
  process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
  accounts.reset();
  accounts.add("claude", "work", work);
  expect(accounts.signedInElsewhere("claude", side, accounts.identity("claude", side)!)).toBeNull();
  expect(accounts.signedInElsewhere("claude", work, accounts.identity("claude", work)!)).toBe("default");
  accounts.add("claude", "side", side);
  const third = join(home, "third");
  signIn(third, "me@home.com", "team-id");
  expect(accounts.signedInElsewhere("claude", third, accounts.identity("claude", third)!)).toMatchObject({
    name: "side",
  });
});

test("a folder an agent ran in is remembered once someone signed in there, until it's removed", async () => {
  const dir = join(home, "elsewhere", ".claude-side");
  mkdirSync(dir, { recursive: true });
  expect(accounts.remember("claude", dir)).toBe(false);
  signIn(dir, "me@side.com");
  expect(accounts.remember("claude", dir)).toBe(true);
  expect(accounts.remember("claude", dir)).toBe(false);
  expect(accounts.remember("claude", "")).toBe(false);
  expect(accounts.known()).toEqual([{ provider: "claude", dir, name: "side", managed: false }]);
  expect(accounts.label("claude", dir)).toBe("side");
  await accounts.remove(accounts.named("side")!);
  expect(accounts.forgotten(dir)).toBe(true);
  expect(accounts.remember("claude", dir)).toBe(false);
  expect(accounts.known()).toEqual([]);
  expect(accounts.add("claude", "side", dir).dir).toBe(dir);
  expect(accounts.forgotten(dir)).toBe(false);
});

test("an agent's account comes from how it was launched", () => {
  const work = join(home, ".claude-work");
  expect(Launch.in("claude", work).account()).toBe(work);
  expect(Launch.in("claude", "").account()).toBe("");
  expect(new Launch(undefined, `CLAUDE_CONFIG_DIR=${work} claude --model opus`).account("claude")).toBe(work);
  expect(new Launch(undefined, "claude").account("claude")).toBe("");
  expect(new Launch(undefined, 'CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude').account("claude")).toBe(work);
  expect(new Launch(undefined, "CLAUDE_CONFIG_DIR=acct claude").account("claude", "/work")).toBe("/work/acct");
  expect(Launch.from(JSON.parse(JSON.stringify(Launch.in("claude", work)))).account()).toBe(work);
});

test("deleting a folder yields and keeps account edits made during cleanup", async () => {
  const owned = accounts.adopt(accounts.stage("claude"), "remove-me");
  const pending = accounts.remove(owned);
  accounts.renameDefault("claude", "personal");
  const added = accounts.add("claude", "keep-me", mkdirSync(join(home, "keep"), { recursive: true })!);
  expect(await pending).toBe(true);
  expect(accounts.defaultName("claude")).toBe("personal");
  expect(accounts.known()).toEqual([added]);
});

test("account edits persist privately and apply only to new launches of that account", async () => {
  const dir = join(home, "work");
  mkdirSync(dir);
  const work = accounts.add("claude", "work", dir),
    before = Launch.in("claude", dir),
    options = {
      flags: '--model sonnet --add-dir "two words"',
      env: [
        ["API_TIMEOUT_MS", "60000"],
        ["EMPTY", ""],
        ["LITERAL", "$(whoami)"],
      ] as [string, string][],
    };
  accounts.configure("claude", dir, "acme", options);
  expect(statSync(accounts.path()).mode & 0o777).toBe(0o600);
  accounts.reset();
  expect(accounts.find("claude", dir)?.name).toBe("acme");
  expect(accounts.launchOptions("claude", dir)).toEqual(options);
  const launch = Launch.in("claude", dir, true);
  expect(launch.typed()).toBe("claude --dangerously-skip-permissions --model sonnet --add-dir 'two words'");
  expect(launch.run("/corgi", launch.typed()).env).toEqual([...options.env, ["CLAUDE_CONFIG_DIR", dir]]);
  expect(launch.account()).toBe(dir);
  expect(before.typed()).toBe("claude");
  expect(Launch.in("claude", "").typed()).toBe("claude");
  expect(Launch.in("codex", dir).typed()).toBe("codex");
  expect(Launch.from(JSON.parse(JSON.stringify(launch))).typed()).toBe(launch.typed());
  accounts.configure("claude", dir, "acme", { flags: "", env: [] });
  expect(Launch.in("claude", dir).typed()).toBe("claude");
  expect(launch.typed()).toContain("--model sonnet");
  accounts.configure("claude", dir, "acme", options);
  await accounts.remove(work);
  expect(accounts.launchOptions("claude", dir)).toEqual({ flags: "", env: [] });
});

test("default launch options stay with their provider across renames and reset", () => {
  const options = {
    flags: '--config "model=custom"',
    env: [["HTTPS_PROXY", "http://localhost:8080"]] as [string, string][],
  };
  accounts.configure("codex", "", "personal", options);
  accounts.renameDefault("codex", "home");
  accounts.reset();
  expect(accounts.launchOptions("codex", "")).toEqual(options);
  expect(Launch.in("codex", "").agent?.env).toEqual(options.env);
  const copy = accounts.launchOptions("codex", "");
  copy.env[0][1] = "changed";
  expect(accounts.launchOptions("codex", "")).toEqual(options);
  accounts.configure("codex", "", "", { flags: "", env: [] });
  expect(accounts.defaultName("codex")).toBe("");
  expect(accounts.launchOptions("codex", "")).toEqual({ flags: "", env: [] });
});

test("invalid account edits are atomic, and old account files need no migration", () => {
  accounts.renameDefault("claude", "home");
  const before = readFileSync(accounts.path(), "utf8");
  expect(() => accounts.configure("claude", "", "new", { flags: "'unfinished", env: [] })).toThrow(
    "InvalidAgentOptions",
  );
  expect(() => accounts.configure("claude", "", "new", { flags: "", env: [["CLAUDE_CONFIG_DIR", "/other"]] })).toThrow(
    "AccountEnvironmentOverride",
  );
  expect(() => accounts.configure("claude", "", "bad\nname", { flags: "", env: [] })).toThrow("InvalidAccountName");
  expect(readFileSync(accounts.path(), "utf8")).toBe(before);
  expect(accounts.defaultName("claude")).toBe("home");
  writeFileSync(accounts.path(), JSON.stringify({ accounts: [], forgotten: [], defaults: { claude: "legacy" } }));
  accounts.reset();
  expect(accounts.defaultName("claude")).toBe("legacy");
  expect(accounts.launchOptions("claude", "")).toEqual({ flags: "", env: [] });
  accounts.configure("claude", "", "legacy", { flags: "--verbose", env: [] });
  expect(accounts.launchOptions("claude", "").flags).toBe("--verbose");
});

test("display names allow spaces, punctuation and Unicode without changing account folders", () => {
  const name = "Claude / Review 🤖 (work)",
    staged = accounts.stage("claude", name);
  signIn(staged.dir, "me@work.com");
  const account = accounts.adopt(staged);
  expect(basename(account.dir)).toBe("1");
  expect(accounts.named(name)?.dir).toBe(account.dir);
  expect(accounts.named("claude/" + name)?.dir).toBe(account.dir);
  accounts.rename(account, "Review: é / 中文");
  accounts.configure("codex", "", "Codex Astra (XHigh)", { flags: "", env: [] });
  accounts.reset();
  expect(accounts.known()[0]).toMatchObject({ name: "Review: é / 中文", dir: account.dir });
  expect(accounts.defaultName("codex")).toBe("Codex Astra (XHigh)");
  for (const invalid of [" ", "a\nb", "a\x1bb", "a\x85b", "é".repeat(81)])
    expect(() => accounts.rename(account, invalid)).toThrow("InvalidAccountName");
  expect(accounts.known()[0].name).toBe("Review: é / 中文");
});

test("provider-prefixed names resolve literally and reject ambiguous qualifiers", () => {
  const literal = accounts.adopt(accounts.stage("claude", "claude/Review"));
  expect(accounts.named("claude/Review")?.dir).toBe(literal.dir);
  expect(accounts.named("claude/claude/Review")?.dir).toBe(literal.dir);
  const other = accounts.adopt(accounts.stage("claude", "Review"));
  expect(() => accounts.named("claude/Review")).toThrow("AmbiguousAccount");
  expect(accounts.named("Review")?.dir).toBe(other.dir);
  expect(accounts.named("claude/claude/Review")?.dir).toBe(literal.dir);
});

test("account removal refuses referenced accounts before signing out", async () => {
  const account = accounts.adopt(accounts.stage("claude"), "referenced"),
    profile = profiles.save({
      provider: "claude",
      account: account.dir,
      name: "Clone",
      options: { flags: "", env: [] },
      yolo: false,
    }),
    signout = spyOn(signin, "signOut").mockResolvedValue(),
    stderr = spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    expect(await accountCommand.command(["remove", "referenced"])).toBe(1);
    expect(stderr).toHaveBeenCalledWith("corgi: delete this account’s cloned configurations first\n");
    expect(signout).not.toHaveBeenCalled();
    expect(existsSync(account.dir)).toBe(true);
    expect(accounts.find("claude", account.dir)).not.toBeNull();
    expect(() => profiles.assertAccountUnused("claude", account.dir)).toThrow("AccountHasProfiles");
    profiles.remove(profile.id);
    expect(() => profiles.assertAccountUnused("claude", account.dir)).not.toThrow();
  } finally {
    stderr.mockRestore();
    signout.mockRestore();
  }
});

test("an account's folder reads from ~ when it's in the user's home, however HOME spells it", () => {
  const mine = join(home, "accounts", "big-co"),
    link = join(dirname(home), basename(home) + "-link");
  mkdirSync(mine, { recursive: true });
  symlinkSync(home, link);
  try {
    process.env.HOME = link;
    expect(accounts.folder("claude", "")).toBe("~/.claude");
    expect(accounts.folder("claude", mine)).toBe("~/accounts/big-co");
    expect(accounts.folder("claude", "/elsewhere/x")).toBe("/elsewhere/x");
  } finally {
    rmSync(link);
  }
});
