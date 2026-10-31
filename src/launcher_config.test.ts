import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { uses } from "./launcher_config";
import { key } from "./launch/preview";
import { Row } from "./launch/row";
import { Runtime } from "./runtime";
import { Workspace } from "./workspace";
import { Provider } from "./providers";
import * as accounts from "./accounts";
import * as profiles from "./agent_profiles";
import * as options from "./agent_options";

let saved: string | undefined, root: string;
beforeEach(() => {
  saved = process.env.CORGI_ENV_BASE;
  root = mkdtempSync(join(tmpdir(), "corgi-launcher-config-"));
  process.env.CORGI_ENV_BASE = root;
  accounts.reset();
});
afterEach(() => {
  if (saved === undefined) delete process.env.CORGI_ENV_BASE;
  else process.env.CORGI_ENV_BASE = saved;
  accounts.reset();
  rmSync(root, { recursive: true, force: true });
});
/** Folders signed in to `provider`, by name. */
function listed(provider: Provider, names: string[]) {
  mkdirSync(dirname(accounts.path()), { recursive: true });
  writeFileSync(
    accounts.path(),
    JSON.stringify({ accounts: names.map(name => ({ provider, dir: join(root, name), name, managed: false })) }),
  );
  accounts.reset();
  return Object.fromEntries(accounts.known().map(a => [a.name, a.dir]));
}

test("the preview reads what launchers show, agents run in and Corgi's own inference uses", () => {
  const dirs = listed("claude", ["work", "spare", "gone"]),
    r = new Runtime(),
    here = new Workspace(1, "/tmp"),
    there = new Workspace(2, "/tmp");
  r.workspaces.items = [here, there];
  for (const p of Provider.all) r.agent_hidden[p] = p !== "claude" && p !== "pi";
  r.account_hidden = [dirs.spare, dirs.gone];
  // Pi is hidden in every workspace, and work only in one of them.
  here.launcher_hidden = ["pi", Row.of("claude", dirs.work)];
  there.launcher_hidden = ["pi"];
  const profile = profiles.save({
    provider: "codex",
    account: "",
    name: "Astra",
    options: options.empty(),
    yolo: false,
  });
  const pane = (account: string, state = {}) =>
    ({
      agent: () => ({ provider: "claude" }),
      account: () => account,
      dormant: false,
      terminal: { exited: false },
      ...state,
    }) as any;
  // An agent that exited or waits dormant runs in no account.
  r.panes = [pane(dirs.spare), pane(dirs.gone, { dormant: true }), pane(dirs.gone, { terminal: { exited: true } })];
  r.inference.provider = "omp";
  try {
    expect(Object.fromEntries(uses(r))).toEqual({
      [key("claude")]: "launcher",
      [key("claude", dirs.work)]: "launcher",
      [key("claude", dirs.spare)]: "account",
      [key("codex")]: "launcher",
      [key("omp")]: "account",
    });
    // A saved command in Pi's default account shows Pi's reading, and a
    // headless agent runs in its default account.
    Object.assign(r.agent_commands[0], { command: "pi" });
    Object.assign(r.agent_commands[0].semantics, { provider: "pi", default_account: true });
    r.sessions = [{ provider: "opencode2", exited: false } as any];
    expect(Object.fromEntries(uses(r))).toMatchObject({ [key("pi")]: "launcher", [key("opencode2")]: "account" });
    r.sessions = [{ provider: "opencode2", exited: true } as any];
    expect(uses(r).has(key("opencode2"))).toBe(false);
    r.agent_commands[0].hidden = true;
    r.sessions = [];
    // Manage agents lists the rest too, for their sign-in and usage.
    there.launcher_hidden.push(Row.ofProfile(profile.id));
    here.launcher_hidden.push(Row.ofProfile(profile.id));
    expect(Object.fromEntries(uses(r, true))).toEqual({
      ...Object.fromEntries(Provider.all.map(p => [key(p), "account"])),
      [key("claude")]: "launcher",
      [key("claude", dirs.work)]: "launcher",
      [key("claude", dirs.spare)]: "account",
      [key("claude", dirs.gone)]: "account",
    });
  } finally {
    r.panes = [];
    r.sessions = [];
    r.destroy();
  }
});
