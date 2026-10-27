import { dirname, join } from "node:path";
import type { Adapter } from "../adapter";
import { Hooks } from "../common";
import { ScreenWatcher } from "../watcher";
import * as commandLine from "../command_line";
import { info } from "./info";
import { API, configDir, validSession } from "./api";
import { prepare } from "./launch";
import { OpenCode2 } from "./headless";
import { Worker } from "./observer";
const hooks = new Hooks();
export const adapter: Adapter = {
  ...info,
  caps: {
    prompt_turns: false,
    children_from_hooks: false,
    follows_cd: false,
    titles_once_loaded: false,
    transcript_tools: false,
  },
  version: s => /^opencode v2\./m.test(s.trim()),
  requires: "v2",
  installs: ({ home, root }) => [
    ...(home ? [join(home, ".opencode/bin/opencode2"), join(home, ".opencode/bin/opencode")] : []),
    ...["/opt/homebrew/bin", "/usr/local/bin"].map(p => root + p + "/opencode2"),
  ],
  accounts: {
    env: "XDG_CONFIG_HOME",
    home: env => dirname(configDir(env)),
    prefix: "",
    identity: () => null,
    shared: { dirs: [], files: [] },
    signin: null,
  },
  inspect: c =>
    commandLine.inspect(c, {
      config_env: "XDG_CONFIG_HOME",
      account_home: ".config/opencode",
      yolo: "--auto",
      profile_flags: [],
      settings_flags: ["--server", "--standalone"],
      credential_env: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENCODE_API_KEY"],
      endpoint_env: [],
      provider_env: [],
      account: () => null,
    }),
  watch: () => new ScreenWatcher(() => null),
  hook: v => hooks.decode(v),
  launch: {
    prepare,
    start: s => [
      ...(s.permissions === "bypass" ? ["--auto"] : []),
      ...(s.model ? ["--model", s.model] : []),
      ...s.args,
    ],
    resume: session => ["--session", session],
    fork: ({ session }, name) =>
      validSession(session)
        ? {
            args: ["--corgi-fork", session, ...(name ? ["--corgi-name", name] : [])],
            session: null,
            named: true,
          }
        : null,
    keep: c =>
      commandLine.keep(c, {
        drop: [
          "--session",
          "-s",
          "--continue",
          "-c",
          "--prompt",
          "--model",
          "-m",
          "--auto",
          "--corgi-fork",
          "--corgi-name",
        ],
        flags: ["--continue", "-c", "--auto", "--standalone", "--print-logs"],
        env: /^(HOME|XDG_\w+|OPENCODE_\w+)$/,
      }),
  },
  rename: {
    async channel(session) {
      if (!validSession(session)) return null;
      const api = await API.open();
      return async name => {
        await api.call("PATCH", `/api/session/${session}`, { title: name });
      };
    },
  },
  headless: { start: at => OpenCode2.start(at, null), restore: (saved, live) => OpenCode2.restore(saved, live) },
  inference: {
    model: "",
    models: (account, quit) => import("./models").then(m => m.read(account, quit)),
    start: (r, at) => OpenCode2.start(at, r),
    restore: (saved, live) => OpenCode2.restore(saved, live),
  },
  history: () => import("./history").then(m => m.open()),
  observer: () => new Worker(),
  launcher: account => import("./launcher").then(m => m.open(account)),
  integration: {
    directory: () => configDir(),
    install: async () => [],
    uninstall: async () => [],
    status: async () => [],
    async startup() {},
    snippet: () => "OpenCode reports through its local API; no hooks are installed.",
  },
};
