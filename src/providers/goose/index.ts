import path from "node:path";
import type { Adapter } from "../adapter";
import { Hooks, field, str } from "../common";
import { ScreenWatcher } from "../watcher";
import * as commandLine from "../command_line";
import { clip } from "../../activity/tools";
import { info } from "./info";
import { accounts } from "./accounts";
import { directory, install, status, uninstall, startup, snippet } from "./integration";
import { GooseInference } from "./inference";
const hooks = new Hooks();
export const adapter: Adapter = {
  ...info,
  // Proof of concept: no turn ids, no transcript, no titles yet, so every
  // cap stays false until its channel is proven.
  caps: {
    prompt_turns: false,
    children_at_stop: false,
    follows_cd: false,
    titles_once_loaded: false,
    transcript_tools: false,
  },
  owns: p => path.basename(p) === "goose",
  inspect(c) {
    let model = "";
    for (let i = 0; i < c.args.length; i++) {
      if (c.args[i] === "--model" && c.args[i + 1]) model = c.args[i + 1];
      if (c.args[i].startsWith("--model=")) model = c.args[i].slice(8);
    }
    return { permissions: "default", model, account: "", default_account: !c.flagged };
  },
  // PATH only; the install script's paths are not yet verified.
  installs: () => [],
  accounts,
  // Hooks carry working; the screen survey confirms idle. Goose's input
  // prompt ("Enter to send · Ctrl+J newline") only renders while it waits
  // for input, so its presence in the tail is the idle marker. Tool calls
  // stay in scrollback when idle, so they must NOT count as working here;
  // anything else is "can't tell" and the hooks keep speaking.
  watch: () =>
    new ScreenWatcher((_title, text) => {
      const tail = text.trimEnd().split("\n").slice(-10).join("\n").toLowerCase();
      if (tail.includes("enter to send")) return "idle";
      return null;
    }),
  hook(v) {
    const input = field(v, "input");
    const hook = hooks.decode({
      hook_event_name: str(v, "event"),
      session_id: str(v, "session"),
      turn_id: "",
      prompt_id: "",
      transcript_path: "",
      cwd: str(v, "cwd"),
      model: str(v, "model"),
      tool_name: str(v, "tool"),
      tool_input: {
        command: str(input, "command"),
        file_path: str(input, "file_path") || str(input, "path"),
        description: str(input, "description"),
      },
    });
    // The plugin does not subscribe to prompts yet; the mapping is ready.
    if (hook && hook.kind === "prompt") hook.initial_request = clip(str(v, "message"), 2048);
    return hook;
  },
  launch: {
    start: s => ["session", ...s.args],
    resume: session => ["--resume", "--session-id", session],
    fork: ({ session }, name) =>
      session
        ? {
            args: ["--resume", "--fork", "--session-id", session, ...(name ? ["--name", name] : [])],
            session: null,
            named: !!name,
          }
        : null,
    keep: c =>
      commandLine.keep(c, {
        drop: ["--resume", "--session-id", "--fork", "--name", "--history", "--edit"],
        flags: ["--resume", "--fork", "--history", "--edit"],
        env: /^(?:HOME|GOOSE_.+)$/,
      }),
  },
  inference: {
    model: "",
    start: (r, at) => GooseInference.start(at, r),
    restore: GooseInference.restore,
  },
  // Lazy like pi's: history reads the launch store, which reads the registry.
  history: account => import("./history").then(m => m.open(account)),
  integration: {
    directory,
    install: async account => install(account),
    uninstall: async account => uninstall(account),
    status: async account => status(account),
    startup: async account => startup(account),
    snippet: () => snippet(),
  },
};
