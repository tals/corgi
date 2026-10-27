//! A provider that exists only in tests. Code that assumes every provider is
//! Claude or Codex gives it their answers, which its own tell apart.
import { Provider } from "../../providers";
import type { Adapter } from "../adapter";
import { configHome, Hooks, sharedPrompt } from "../common";
import { ScreenWatcher } from "../watcher";
import * as hooksFile from "../hooks_file";
import * as commandLine from "../command_line";
const events = ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"],
  configDir = (env = process.env) => configHome(env, "SIM_HOME", ".sim"),
  dir = (account: string) => account || configDir(),
  settings = (account: string) =>
    new hooksFile.File("sim", dir(account), "hooks.json", events, account ? configDir() : null),
  hooks = new Hooks();
export const adapter: Adapter = {
  id: "sim",
  label: "Simulated Agent",
  name: "Sim",
  glyph: "§",
  launcher_key: "z",
  command: "sim",
  programs: { names: ["sim"] },
  caps: {
    prompt_turns: true,
    children_from_hooks: false,
    follows_cd: true,
    titles_once_loaded: false,
    transcript_tools: false,
  },
  inspect: c =>
    commandLine.inspect(c, {
      config_env: "SIM_HOME",
      account_home: ".sim",
      yolo: "--unattended",
      profile_flags: [],
      settings_flags: [],
      credential_env: ["SIM_API_KEY"],
      endpoint_env: [],
      provider_env: [],
      account: () => null,
    }),
  installs: ({ home }) => (home ? [home + "/.local/bin/sim"] : []),
  accounts: {
    env: "SIM_HOME",
    home: configDir,
    prefix: ".sim-",
    identity: root => {
      const login = commandLine.cached(root, "login.json");
      return typeof login?.email === "string" ? { email: login.email, id: String(login.id ?? login.email) } : null;
    },
    shared: { dirs: ["notes"], files: ["hooks.json"] },
    signin: {
      started: text => /\S/.test(text),
      step: text => (text.includes("Paste the code") ? "code" : text.includes("Sign in how?") ? "method" : null),
      hints: { code: "Paste the code the page shows." },
      ready: root => commandLine.cached(root, "login.json")?.ready === true,
      check: ["status"],
      logout: ["logout"],
      first: [],
      again: null,
    },
  },
  watch: () => new ScreenWatcher((_title, text) => sharedPrompt(text)),
  hook: v => hooks.decode(v),
  launch: {
    start: s => [
      ...(s.permissions === "bypass" ? ["--unattended"] : []),
      ...(s.model ? ["--model", s.model] : []),
      ...s.args,
    ],
    resume: session => ["--continue", session],
    fork: ({ session }, name) => ({
      args: ["--branch", session, ...(name ? ["--title", name] : [])],
      session: null,
      named: true,
    }),
  },
  inference: {
    model: "sim-small",
    start: () => {
      throw Error("Unsupported");
    },
    restore: () => {
      throw Error("Unsupported");
    },
  },
  integration: {
    directory: dir,
    install: async account => [settings(account).install()],
    uninstall: async account => [settings(account).uninstall().result],
    status: async account => [settings(account).status()],
    startup: async account => void settings(account).install(),
    snippet: executable => hooksFile.snippet("sim", events, executable),
  },
};
export const sim = "sim" as Provider;
/** Adds Sim to the registry until the returned function runs. */
export function register(): () => void {
  return Provider.register(adapter);
}
