import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as profiles from "./agent_profiles";
import * as accounts from "./accounts";
import { Launch } from "./runtime";

let directory = "";
const base = process.env.CORGI_ENV_BASE;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "corgi-profiles-"));
  process.env.CORGI_ENV_BASE = directory;
  accounts.reset();
});
afterEach(() => {
  if (base === undefined) delete process.env.CORGI_ENV_BASE;
  else process.env.CORGI_ENV_BASE = base;
  accounts.reset();
  rmSync(directory, { recursive: true, force: true });
});
const source = () => ({
  provider: "claude" as const,
  account: "",
  name: "Reviewer",
  options: { flags: "--verbose", env: [["REVIEW", "yes"]] as [string, string][], model: "opus" },
  yolo: false,
});

test("clones persist independent options while sharing an account", () => {
  accounts.configure("claude", "", "", source().options);
  const before = readFileSync(accounts.path(), "utf8"),
    draft = source(),
    first = profiles.save(draft);
  draft.options.env[0][1] = "changed";
  const second = profiles.save({
    ...first,
    id: undefined,
    name: "Second",
    options: { ...first.options, model: "sonnet" },
  });
  expect(second.id).not.toBe(first.id);
  expect(profiles.find(first.id)?.options.env).toEqual([["REVIEW", "yes"]]);
  expect(profiles.find(second.id)?.options.model).toBe("sonnet");
  profiles.remove(first.id);
  expect(profiles.list().map(p => p.id)).toEqual([second.id]);
  expect(readFileSync(accounts.path(), "utf8")).toBe(before);
  expect(statSync(profiles.path()).mode & 0o777).toBe(0o600);
});

test("profile writes reject invalid settings and account overrides", () => {
  expect(() => profiles.save({ ...source(), name: "" })).toThrow("InvalidAgentName");
  expect(() => profiles.save({ ...source(), account: "/missing-profile-account" })).toThrow("AccountNotFound");
  expect(() =>
    profiles.save({ ...source(), options: { flags: "", env: [["CLAUDE_CONFIG_DIR", "/different"]] } }),
  ).toThrow("AccountEnvironmentOverride");
  const p = profiles.save(source());
  writeFileSync(profiles.path(), JSON.stringify([null, {}, p, { ...p, id: "bad:id" }]));
  expect(profiles.list()).toEqual([p]);
});

test("explicit model overrides flags; Auto passes no model and preserves CLI configuration", () => {
  const flags = "--model old --verbose -m=older";
  expect(Launch.in("claude", "", false, { flags, env: [], model: "sonnet" }).typed()).toBe(
    "claude --model sonnet --verbose",
  );
  expect(Launch.in("claude", "", false, { flags: "--verbose", env: [] }).typed()).toBe("claude --verbose");
  expect(Launch.in("claude", "", false, { flags, env: [] }).typed()).toContain("--model old");
  expect(
    Launch.in("pi", "", false, { flags: "--provider old --model old", env: [], model: "openai/new" }).typed(),
  ).toBe("pi --model openai/new");
});
