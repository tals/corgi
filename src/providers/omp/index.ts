import path from "node:path";
import type { Adapter } from "../adapter";
import { field, Hooks, str, type Hook, type Outcome } from "../common";
import { ScreenWatcher } from "../watcher";
import * as commandLine from "../command_line";
import { decode as decodePi } from "../pi";
import { Omp, summaryArgs, nativeIntent } from "./headless";
import { directory, extension, source } from "./integration";
import { transcript } from "./transcript";
import { sockets } from "../pi/rename";
import { info } from "./info";
import { accounts, identity } from "./accounts";
import * as locations from "./locations";
import * as conversation from "./conversation";
import * as todos from "./todos";
const hooks = new Hooks();
export function decode(v: unknown): Hook {
  const event = str(v, "event");
  if (event === "Todos") {
    const value = field(v, "todos"),
      ms = field(v, "at");
    if (!Array.isArray(field(value, "phases"))) return null;
    const hook = hooks.decode({ hook_event_name: "Checklist", session_id: str(v, "session") });
    // The extension times a list it read back from the session by the entry that holds it.
    if (hook) hook.checklist = todos.parse(value, Number.isSafeInteger(ms) && ms > 0 ? ms * 1000 : 0);
    return hook;
  }
  if (event === "SubagentStart" || event === "SubagentStop") {
    const hook = hooks.decode({
      hook_event_name: event,
      session_id: str(v, "session"),
      agent_id: str(v, "subagent"),
      agent_type: str(v, "subagent_type"),
    });
    if (!hook) return null;
    hook.independent_child = true;
    hook.subagent_name = str(v, "subagent_name");
    hook.description = str(v, "description");
    hook.child_transcript = str(v, "child_transcript");
    hook.model = str(v, "model");
    const outcome = str(v, "outcome");
    if (event === "SubagentStop" && ["completed", "interrupted", "failed"].includes(outcome))
      hook.outcome = outcome as Outcome;
    return hook;
  }
  const hook = decodePi(v);
  if (hook && (hook.kind === "activity" || hook.kind === "tool_start")) {
    const intent = nativeIntent(str(v, "intent"));
    if (hook.kind === "activity" && !intent) return null;
    hook.description = intent;
    hook.activity_amend = field(v, "amend") === true;
  }
  const pid = field(v, "owner_pid");
  if (hook && typeof pid === "number" && Number.isSafeInteger(pid) && pid > 1) hook.owner_pid = pid;
  if (hook?.kind === "stop")
    hook.awaiting_async_work = hook.outcome === "completed" && field(v, "awaiting_async_work") === true;
  return hook;
}
const rename = sockets("omp", directory);
export const adapter: Adapter = {
  ...info,
  caps: {
    prompt_turns: true,
    children_from_hooks: true,
    follows_cd: false,
    titles_once_loaded: false,
    transcript_tools: true,
    native_activity: true,
  },
  installs: ({ home, root }) => [
    ...(home ? [".bun/bin", ".local/bin", ".npm-global/bin"].map(d => path.join(home, d, "omp")) : []),
    ...["/opt/homebrew/bin/omp", "/usr/local/bin/omp"].map(p => root + p),
  ],
  version: v => /^omp\/\d+\.\d+\.\d+/.test(v.trim()),
  inspect(c) {
    const result = commandLine.inspect(c, {
      config_env: "PI_CODING_AGENT_DIR",
      account_home: ".omp/agent",
      yolo: "--auto-approve",
      profile_flags: ["--profile"],
      settings_flags: ["--api-key", "--config"],
      credential_env: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "GEMINI_API_KEY"],
      endpoint_env: [],
      provider_env: [],
      account: root => identity(root)?.email ?? null,
    });
    for (let i = 0; i < c.args.length; i++) {
      const w = c.args[i];
      if (w === "--yolo" || w === "--approval-mode=yolo" || (w === "--approval-mode" && c.args[i + 1] === "yolo"))
        result.permissions = "bypass";
    }
    const p = c.args.indexOf("--provider");
    if (p >= 0 && c.args[p + 1] && result.model && !result.model.includes("/"))
      result.model = c.args[p + 1] + "/" + result.model;
    return result;
  },
  accounts,
  // Its hooks say when it works and stops; the screen adds nothing they leave out.
  watch: () => new ScreenWatcher(() => null),
  hook(v) {
    const hook = decode(v);
    if (hook && (hook.kind === "session_start" || hook.kind === "stop"))
      locations.remember(str(v, "session"), str(v, "transcript"), str(v, "account"));
    return hook;
  },
  unnest: env => {
    delete env.CORGI_OMP_OWNER;
  },
  launch: {
    start: s => [
      ...(s.permissions === "bypass" ? ["--auto-approve"] : []),
      ...(s.model ? ["--model", s.model] : []),
      ...s.args,
    ],
    resume: (session, account) => ["--resume", locations.locate(session, account)],
    fork: ({ session, transcript }) =>
      session ? { args: ["--fork", transcript || session], session: null, named: false } : null,
    keep: c =>
      commandLine.keep(c, {
        drop: [
          "--resume",
          "-r",
          "--session",
          "--restore",
          "--fork",
          "--continue",
          "-c",
          "--model",
          "--mode",
          "--print",
          "-p",
          "--no-session",
          "--goal",
          "--from-claude",
          "--from-codex",
          "--plan-yolo",
        ],
        flags: [
          "--continue",
          "-c",
          "--print",
          "-p",
          "--no-session",
          "--no-extensions",
          "--no-skills",
          "--no-rules",
          "--no-tools",
          "--no-lsp",
          "--no-pty",
          "--no-title",
          "--no-prewalk",
          "--no-ui",
          "--prewalk",
          "--plan-yolo",
          "--allow-home",
          "--hide-thinking",
          "--advisor",
          "--external-thinking",
          "--print-thoughts",
          "--auto-approve",
          "--yolo",
          "--from-claude",
          "--from-codex",
        ],
        env: /^(?:HOME|PI_.+|OMP_.+|.+_API_KEY|.+_AUTH_TOKEN|.+_OAUTH_TOKEN|.+_BASE_URL)$/,
      }),
  },
  rename: { channel: rename.channel },
  headless: { start: at => Omp.start(at), restore: (saved, live) => Omp.restore(saved, live) },
  inference: {
    model: "openai-codex/gpt-6-luna",
    models: (account, quit) => import("./models").then(m => m.read(account, quit)),
    start: (r, at) => Omp.start({ ...at, cwd: "/tmp" }, summaryArgs(r)),
    restore: (saved, live) => Omp.restore(saved, live),
  },
  launcher: account => import("./launcher").then(m => m.open(account)),
  history: account => import("./history").then(m => m.open(account)),
  transcript,
  conversation,
  integration: {
    directory,
    install: async account => [extension("install", account)],
    status: async account => [extension("status", account)],
    uninstall: async account => [extension("uninstall", account)],
    startup: async account => {
      if (!(await import("../../discovery")).installed("omp")) return;
      const r = extension("install", account);
      if (r.outcome === "failed") console.error("hook setup:", r.error);
    },
    snippet: () => source,
  },
};
