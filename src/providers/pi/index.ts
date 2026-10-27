import path from "node:path";
import type { Adapter } from "../adapter";
import { Hooks, field, str } from "../common";
import { ScreenWatcher } from "../watcher";
import * as commandLine from "../command_line";
import { Pi, summaryArgs } from "./headless";
import { directory, extension, source } from "./integration";
import { transcript } from "./transcript";
import { channel, suggest } from "./rename";
import { info } from "./info";
import { accounts } from "./accounts";
import * as locations from "./locations";
import { clip } from "../../activity/tools";
const hooks = new Hooks();
export const adapter: Adapter = {
  ...info,
  caps: {
    prompt_turns: true,
    children_at_stop: false,
    follows_cd: false,
    titles_once_loaded: false,
    transcript_tools: true,
  },
  installs: ({ home, root }) => [
    ...(home ? [".bun/bin", ".local/bin", ".npm-global/bin"].map(d => path.join(home, d, "pi")) : []),
    ...["/opt/homebrew/bin/pi", "/usr/local/bin/pi"].map(p => root + p),
  ],
  version: v => /^(?:[1-9]\d*)\.\d+\.\d+(?:[-+].*)?$/.test(v.trim()),
  requires: "1.0.0 or newer",
  inspect(c) {
    const result = commandLine.inspect(c, {
      config_env: "PI_CODING_AGENT_DIR",
      account_home: ".pi/agent",
      yolo: "--approve",
      profile_flags: ["--provider"],
      settings_flags: ["--api-key"],
      credential_env: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
      endpoint_env: [],
      provider_env: [],
      account: () => null,
    });
    // Project trust is not tool approval. Pi's tools use extension-defined policy.
    result.permissions = "default";
    const p = c.args.indexOf("--provider");
    if (p >= 0 && c.args[p + 1] && result.model && !result.model.includes("/"))
      result.model = c.args[p + 1] + "/" + result.model;
    return result;
  },
  accounts,
  watch: () =>
    new ScreenWatcher((_title, text) => {
      const tail = text.trimEnd().split("\n").slice(-10).join("\n").toLowerCase();
      if (tail.includes("esc to interrupt")) return "working";
      return null;
    }),
  hook(v) {
    const input = field(v, "input"),
      tool = str(v, "tool");
    const hook = hooks.decode({
      hook_event_name: str(v, "event"),
      session_id: str(v, "session"),
      turn_id: str(v, "turn"),
      prompt_id: str(v, "event") === "UserPromptSubmit" ? str(v, "turn") : "",
      transcript_path: str(v, "transcript"),
      cwd: str(v, "cwd"),
      model: str(v, "model"),
      tool_name: tool,
      tool_input: {
        command: str(input, "command"),
        file_path: str(input, "path"),
        description: str(input, "description"),
      },
    });
    if (hook && hook.kind === "prompt") hook.initial_request = clip(str(v, "initial_request"), 2048);
    const outcome = str(v, "outcome");
    if (hook && hook.kind === "stop" && ["completed", "interrupted", "failed"].includes(outcome))
      hook.outcome = outcome as "completed" | "interrupted" | "failed";
    if (hook && hook.kind === "tool_finish" && ["write", "edit"].includes(tool) && str(input, "path"))
      hook.writes = [path.resolve(hook.cwd, str(input, "path"))];
    if (hook && (hook.kind === "session_start" || hook.kind === "stop"))
      locations.remember(str(v, "session"), str(v, "transcript"), str(v, "account"));
    return hook;
  },
  unnest: env => {
    delete env.CORGI_PI_OWNER;
  },
  launch: {
    start: s => [...(s.model ? ["--model", s.model] : []), ...s.args],
    resume: (session, account) => ["--session", locations.locate(session, account)],
    fork: ({ session, transcript }, name) =>
      session
        ? { args: ["--fork", transcript || session, ...(name ? ["--name", name] : [])], session: null, named: true }
        : null,
    keep: c =>
      commandLine.keep(c, {
        drop: [
          "--session",
          "--session-id",
          "--fork",
          "--continue",
          "-c",
          "--resume",
          "-r",
          "--model",
          "--name",
          "-n",
          "--mode",
          "--print",
          "-p",
          "--no-session",
        ],
        flags: [
          "--continue",
          "-c",
          "--resume",
          "-r",
          "--print",
          "-p",
          "--no-session",
          "--no-extensions",
          "-ne",
          "--no-tools",
          "-nt",
          "--no-mcp",
          "--offline",
          "--approve",
          "-a",
          "--no-approve",
          "-na",
          "--no-skills",
          "-ns",
          "--no-context-files",
          "-nc",
        ],
        env: /^(?:HOME|PI_.+|.+_API_KEY|.+_AUTH_TOKEN|.+_BASE_URL)$/,
      }),
  },
  rename: { channel, suggest },
  headless: { start: at => Pi.start(at), restore: Pi.restore },
  inference: {
    model: "openai-codex/gpt-6-luna",
    models: (account, quit) => import("./models").then(m => m.read(account, quit)),
    start: (r, at) => Pi.start({ ...at, cwd: "/tmp" }, summaryArgs(r)),
    restore: Pi.restore,
  },
  launcher: account => import("./launcher").then(m => m.open(account)),
  history: account => import("./history").then(m => m.open(account)),
  transcript,
  integration: {
    directory,
    install: async account => [extension("install", account)],
    status: async account => [extension("status", account)],
    uninstall: async account => [extension("uninstall", account)],
    startup: async account => {
      if (!(await import("../../discovery")).installed("pi")) return;
      const r = extension("install", account);
      if (r.outcome === "failed") console.error("hook setup:", r.error);
    },
    snippet: () => source,
  },
};
