import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Adapter } from "../adapter";
import * as commandLine from "../command_line";
import * as effort from "../effort";
import { info } from "./info";
import { home, customizations, directory, identity, validSession } from "./config";
import * as hooks from "./hooks";
import { Watcher, rename } from "./screen";
import { transcript } from "./transcript";
import { Worker } from "./observer";
import { Antigravity } from "./headless";

const bypass = "--dangerously-skip-permissions";
export const adapter: Adapter = {
  ...info,
  caps: {
    prompt_turns: true,
    children_from_hooks: false,
    follows_cd: false,
    titles_once_loaded: false,
    transcript_tools: false,
  },
  installs: ({ home, root }) => [
    ...(home ? [join(home, ".local/bin/agy")] : []),
    root + "/usr/local/bin/agy",
    root + "/opt/homebrew/bin/agy",
  ],
  accounts: {
    env: "HOME",
    home,
    prefix: "",
    identity,
    variant: async () => "",
    shared: { dirs: [], files: [] },
    signin: null,
  },
  inspect: c =>
    commandLine.inspect(c, {
      config_env: "HOME",
      account_home: "",
      yolo: bypass,
      profile_flags: [],
      settings_flags: ["--settings"],
      credential_env: ["GEMINI_API_KEY"],
      endpoint_env: [],
      provider_env: [],
      account: async root => (await identity(root))?.email ?? null,
    }),
  watch: () => new Watcher(),
  hook: hooks.decode,
  observer: account => new Worker(account),
  launch: {
    options: (args, model, level) => effort.apply("--effort", model ? commandLine.withoutModel(args) : args, level),
    models: (account, quit, cwd) => import("./launcher").then(m => m.models(account, quit, cwd)),
    start: s => [...(s.permissions === "bypass" ? [bypass] : []), ...(s.model ? ["--model", s.model] : []), ...s.args],
    resume: session => ["--conversation", session],
    fork: ({ session }) =>
      validSession(session) ? { args: ["--corgi-fork", session], session: null, named: false } : null,
    async prepare(args, bin, progress) {
      const index = args.indexOf("--corgi-fork");
      if (index < 0) return { args };
      const source = args[index + 1];
      if (!validSession(source)) throw Error("InvalidSession");
      progress?.update("session");
      const { sessionDirectory } = await import("./history");
      const cwd = sessionDirectory(directory(), source) || process.cwd();
      const session = await (await import("./fork")).fork(bin, source, cwd, progress);
      return { args: [...args.slice(0, index), "--conversation", session, ...args.slice(index + 2)] };
    },
    keep: c =>
      commandLine.keep(c, {
        drop: [
          "-r",
          "--resume",
          "--conversation",
          "-c",
          "--continue",
          "--model",
          "-i",
          "--prompt-interactive",
          "-p",
          "--print",
          "--prompt",
          "--input-format",
          "--output-format",
          "--json-schema",
          "--print-timeout",
          "--new-project",
        ],
        flags: [
          "-c",
          "--continue",
          "--sandbox",
          "--new-project",
          "--disable-slash-commands",
          "--remote-agent",
          "--remote-control",
          bypass,
        ],
        env: /^(HOME|XDG_CONFIG_HOME|GEMINI_API_KEY|GOOGLE_APPLICATION_CREDENTIALS)$/,
      }),
  },
  rename: { channel: async () => null, typed: rename },
  message: { channel: async () => null, empty: rename.empty },
  headless: { start: at => Antigravity.start(at), restore: Antigravity.restore },
  inference: {
    model: "",
    models: (account, quit, cwd) => import("./launcher").then(m => m.models(account, quit, cwd)),
    start: (r, at) => Antigravity.start(at, r),
    restore: Antigravity.restore,
  },
  launcher: async account => (await import("./launcher")).open(account),
  history: async account => (await import("./history")).open(account),
  search: async () => (await import("./search")).conversations,
  transcript,
  integration: {
    directory: customizations,
    prepare_on_launch: true,
    install: async account => hooks.integration("install", account),
    uninstall: async account => hooks.integration("uninstall", account),
    status: async account => hooks.integration("status", account),
    async startup(account, _handoff, cwd) {
      if (!existsSync(directory(account)) && !(await import("../../discovery")).installed("antigravity", cwd)) return;
      for (const step of hooks.integration("install", account))
        if (step.outcome === "failed") console.error("hook setup:", step.error);
    },
  },
};
