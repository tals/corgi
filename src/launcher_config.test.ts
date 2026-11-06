import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as accounts from "./accounts";
import * as profiles from "./agent_profiles";
import * as agentOptions from "./agent_options";
import * as launcher from "./agent_launcher";
import * as mirror from "./mirror";
import * as prompt from "./prompt_models";
import * as visibility from "./launch/visibility";
import { catalog } from "./launcher_config";
import { Runtime } from "./runtime";
import { byProvider, type Provider } from "./providers";

const base = process.env.CORGI_ENV_BASE;
let state = "";
beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "corgi-launcher-config-"));
  process.env.CORGI_ENV_BASE = state;
  accounts.reset();
});
afterEach(() => {
  if (base === undefined) delete process.env.CORGI_ENV_BASE;
  else process.env.CORGI_ENV_BASE = base;
  accounts.reset();
  rmSync(state, { recursive: true, force: true });
});

test("picker, manager, CLI and prompt share the installed fallback despite unavailable saved rows", () => {
  using runtime = new Runtime();
  const saved: profiles.Profile = {
      id: "missing",
      name: "Missing",
      provider: "claude",
      account: "",
      options: agentOptions.empty(),
      yolo: false,
    },
    known = spyOn(accounts, "known").mockReturnValue([
      { provider: "claude", dir: "/missing/account", name: "missing", managed: false },
    ]),
    stored = spyOn(profiles, "list").mockReturnValue([saved]),
    preview = launcher.preview({
      pending: false,
      installed: byProvider(p => p === "codex" || p === "pi"),
      configured: byProvider(() => false),
      options: byProvider(() => ({ pending: false, signed_in: null })),
    }),
    menu = new launcher.Menu({ profiles: [saved] }),
    mirrored = new mirror.Runtime();
  menu.preview = preview;
  const check = (expected: Provider[]) => {
    expect(menu.rows().filter(row => row !== "terminal" && menu.shown(row))).toEqual(expected);
    expect(
      menu
        .manageModel()
        .agents.filter(a => a.shown)
        .map(a => a.provider),
    ).toEqual(expected);
    expect(
      catalog(runtime, preview)
        .filter(a => a.launcher)
        .map(a => a.row),
    ).toEqual(expected);
    expect(prompt.places(mirrored, preview, null).map(p => p.provider)).toEqual(expected);
  };
  try {
    check(["codex", "pi"]);
    preview.configured.codex = true;
    check(["codex"]);
    menu.added = runtime.launcher_added = mirrored.launcher_added = ["pi"];
    check(["codex", "pi"]);
    menu.hidden.pi = runtime.agent_hidden.pi = mirrored.agent_hidden.pi = true;
    check(["codex"]);
  } finally {
    known.mockRestore();
    stored.mockRestore();
    mirrored.destroy();
  }
});

test("fallback waits for discovery and excludes install-on-use shims and unavailable account profiles", () => {
  const preview = launcher.preview({
    installed: byProvider(p => p === "pi"),
    configured: byProvider(() => false),
    options: byProvider(() => ({ pending: false, signed_in: false })),
  });
  expect(visibility.defaults(preview, [], []).pi).toBe(false);
  preview.pending = false;
  expect(visibility.defaults(preview, [], [{ provider: "pi", account: "/missing" }]).pi).toBe(true);
  const onDemand = { ...preview, on_demand: byProvider(p => p === "pi") };
  expect(visibility.defaults(onDemand, [], []).pi).toBe(false);
  expect(visibility.defaults(onDemand, ["pi"], []).pi).toBe(true);
});
