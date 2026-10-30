import { specs } from "./action";
import { Provider } from "./providers/names";

type Command = { syntax: string[]; summary: string; details?: string; hidden?: boolean };
const command = (syntax: string, summary: string, details?: string): Command => ({
  syntax: [syntax],
  summary,
  details,
});
const beside = "--right-of ID|--left-of ID|--above ID|--below ID";
const edit =
  "[--name NAME] [--model ID|auto] [--effort LEVEL|default]\n    [--flags FLAGS] [--env JSON_OBJECT] [--yolo on|off] [--workspace ID]";
const launcherDetails = `AGENT is a provider, an account (claude/work or work), a saved command's
name, profile/ID, a clone name, or command/N, as launcher list names them.
Agent settings are shared; order and visibility belong to each workspace.
Outside Corgi, launcher mutations require --workspace.
Move without a position appends. Env replaces overrides, e.g. '{"KEY":"value"}'.
Auto uses the agent CLI's last model; default leaves effort to the agent CLI.`;

/** Control command names also define the parser's accepted vocabulary. */
export const controls = {
  list: command("[--json]", "list layout, panes, agents and viewers"),
  current: command("", "show the calling pane's live location"),
  focus: command("ID|current --viewer ID", "select a pane in exactly one viewer"),
  claim: {
    syntax: ["PROVIDER [--pane ID|current] [--owner PID]", "--clear [--pane ID|current] [--owner PID]"],
    summary: "set or clear a pane's agent identity",
  },
  "workspace.list": command("", "list workspaces, tabs and panes"),
  "workspace.new": command("NAME [--cwd DIR]", "create a workspace"),
  "workspace.edit": command("ID [--name NAME|--clear] [--cwd DIR]", "edit a workspace"),
  "workspace.close": command("ID", "close an empty workspace"),
  "workspace.switch": command("ID [--viewer ID]", "switch a viewer's workspace"),
  "tab.new": command(
    "[--name NAME] [--cwd DIR] [--workspace ID] [--command SHELL_COMMAND]",
    "create a tab",
    "Outside Corgi, new tabs require --workspace.",
  ),
  "tab.rename": command("ID|current NAME|--clear", "rename a tab or clear its name"),
  "tab.move": command("ID|current --before ID|--after ID|--workspace ID", "move a tab"),
  "tab.merge": command(`ID|current ${beside}`, "merge a tab beside a pane"),
  "tab.close": command("ID|current", "close a tab and terminate its processes"),
  "pane.split": command("ID|current --right|--left|--up|--down [--cwd DIR] [--command SHELL_COMMAND]", "split a pane"),
  "pane.move": {
    syntax: [`ID|current ${beside}`, "ID|current --new-tab [--name NAME]"],
    summary: "move a pane beside another or into a new tab",
  },
  "pane.swap": command("ID|current ID", "swap two panes"),
  "pane.resize": command(
    "ID|current --width PERCENT|--height PERCENT",
    "resize a split",
    "PERCENT must be between 10% and 90%.",
  ),
  "pane.close": command("ID|current", "close a pane and terminate its process"),
  "pane.read": command(
    "ID|current [--lines N] [--json]",
    "read terminal output",
    "Reads 100 lines by default; --lines accepts 1 through 10000.\nAgent mode trims line ends, shortens rules and collapses blank runs.",
  ),
  "pane.send": command(
    "ID|current TEXT|--stdin [--enter]",
    "send literal text to a pane",
    "--stdin reads text from standard input; --enter submits it.\nUse -- before literal flags: corgi pane send current -- --help",
  ),
  "pane.keys": command("ID|current KEY...", "send keys such as enter, esc, ctrl+c or arrows"),
  "pane.idle": command("[--workspace ID] [--cwd DIR] [--first]", "find shells waiting at their prompt"),
  "launcher.list": command("[--workspace ID] [--json]", "list agents each launcher shows"),
  "launcher.hide": command("AGENT... [--workspace ID]", "hide agents in one workspace"),
  "launcher.show": command("AGENT... [--workspace ID]", "show agents in one workspace"),
  "launcher.move": command("AGENT [--before AGENT|--after AGENT|--first] [--workspace ID]", "reorder an agent"),
  "launcher.edit": {
    syntax: [`AGENT ${edit}`, "AGENT --command COMMAND [--name NAME] [--workspace ID]"],
    summary: "edit agent settings or a saved command",
  },
  "launcher.clone": command(`AGENT ${edit}`, "clone an agent configuration"),
  "launcher.models": command("AGENT [--json]", "list native model IDs, efforts and defaults"),
  "launcher.add": command("--command COMMAND [--name NAME] [--workspace ID]", "save a launcher command"),
  "launcher.remove": command("AGENT [--workspace ID]", "delete a clone or saved command"),
  "launcher.copy": command("--from ID --workspace ID", "replace destination order and visibility"),
} satisfies Record<string, Command>;

export const actionNames = (() => {
  const lines = ["Actions:"];
  for (const name of Object.keys(specs).filter(name => name !== "relaunch")) {
    if (lines.at(-1)!.length + name.length + 2 > 80) lines.push("  " + name + ",");
    else lines[lines.length - 1] += " " + name + ",";
  }
  lines[lines.length - 1] = lines.at(-1)!.slice(0, -1) + ".";
  return lines.join("\n");
})();
const commands: Record<string, Command> = {
  attach: command("", "start or attach to Corgi (the default)"),
  open: command("DIR", "show DIR's workspace; add one if none"),
  onboard: command("", "open onboarding, even after setup"),
  dev: command("", "reload if changed; attach or relaunch the viewer"),
  "--no-update": command("", "attach without activating a staged update"),
  update: command("[--check|--download-only]", "download and safely apply an update"),
  "update.status": command("", "show update status"),
  "update.rollback": command("", "return to the previous release"),
  "update.auto": command("on|off", "control automatic updates"),
  start: command("", "start a detached runtime"),
  serve: { ...command("", "run the daemon in the foreground"), hidden: true },
  hook: { ...command("PROVIDER", "read an agent hook event from standard input"), hidden: true },
  ping: command("[--json]", "check whether the runtime is running"),
  action: command("NAME [VALUE] [--json]", "run a viewer action", actionNames),
  agent: command(
    "PROVIDER [ARGS...]",
    "launch the discovered agent executable",
    "Arguments after PROVIDER belong to the agent, including --help.",
  ),
  hooks: command("PROVIDER", "print hook configuration"),
  which: command("PROVIDER", "show the automatically selected executable"),
  "integration.status": command("[PROVIDER] [--account NAME]", "show hook installation and trust"),
  "integration.install": command("[PROVIDER] [--account NAME]", "install agent hooks"),
  "integration.uninstall": command("[PROVIDER] [--account NAME]", "remove agent hooks; startup will not add them back"),
  "account.list": command("", "list known accounts and who signed in (the default)"),
  "account.add": {
    syntax: ["[PROVIDER] [NAME]", "PROVIDER NAME --dir DIR"],
    summary: "add an account and sign in, or use an existing account folder",
    details: "Without NAME, the account is named from its login. Signing in requires a terminal.",
  },
  "account.login": command("NAME", "sign in to an account again"),
  "account.rename": command(
    "NAME NEW",
    "rename an account",
    "NAME can be default, or claude/default, for the default account.",
  ),
  "account.remove": command(
    "NAME",
    "remove an account",
    "An account Corgi made is signed out and deleted; an external folder is only forgotten.",
  ),
  keys: command("[PRESET]", "list shortcuts: corgi, tmux, herdr, cmux"),
  "headless.start": command("PROVIDER PROMPT [--workspace ID] [--json]", "start a headless session"),
  "headless.list": command("[--json]", "list headless sessions"),
  "headless.send": command("PROVIDER SESSION JSON [--json]", "prompt, answer or interrupt a headless session"),
  "headless.events": command("PROVIDER SESSION [SEQ] [--json]", "read the journal and pending requests"),
  "headless.stop": command("PROVIDER SESSION [--json]", "stop a headless session"),
  rpc: command("JSON", "send a local JSON control request"),
  reload: command("[ABSOLUTE_EXE] [--json]", "replace the daemon, preserving live processes"),
  checkpoint: command("[--json]", "save recovery context now"),
  shutdown: command("[--json]", "terminate the runtime and its panes"),
  bugreport: command("[--full]", "print bug report details and a link to file it"),
  licenses: command("", "print Corgi's license and bundled software licenses"),
  ...controls,
  "--skill": command("", "print bundled agent instructions"),
  help: command("[COMMAND [SUBCOMMAND]]", "show all commands or help for one command"),
  "--version": command("", "print the version and commit"),
};
const groupDetails: Record<string, string> = {
  launcher: launcherDetails,
  integration:
    "Without PROVIDER, a command covers every agent and account Corgi knows.\n--account selects one account; default selects your own settings.",
  account:
    "Managed sign-in supports codex, claude and pi. Name an account claude/work\nwhen two providers have one called work. Signing in runs the agent's own\nsign-in in the account's folder; start it from the launcher or set\nCODEX_HOME, CLAUDE_CONFIG_DIR or PI_CODING_AGENT_DIR to that folder.",
};
export const nested = new Set(
  Object.keys(controls)
    .filter(name => name.includes("."))
    .map(name => name.split(".")[0]),
);
export const groups = new Set(Object.keys(controls).map(name => name.split(".")[0]));
const roots = new Set(Object.keys(commands).map(name => name.split(".")[0]));
const controlNote = `IDs come from list; current means CORGI_PANE, never UI focus.
Control commands accept --json and never auto-start a server.
Layout changes preserve processes and do not select another pane in a viewer.`;
const options = `Options:
  -h, --help       show help for the selected command
  --version        print the version and commit
  --agent          compact pane read output for agents
  --no-agent       keep pane read output unmodified
  --               treat the remaining arguments as literal text`;

function selected(args: string[]): string | null {
  if (!roots.has(args[0])) return null;
  const child = `${args[0]}.${args[1]}`;
  return commands[child] ? child : args[0];
}
function entries(name: string): [string, Command][] {
  return Object.entries(commands).filter(([key]) => key === name || key.startsWith(name + "."));
}
function lines(key: string, entry: Command): string[] {
  return entry.syntax.map(syntax => `  corgi ${key.replaceAll(".", " ")}${syntax ? " " + syntax : ""}`);
}
/** Usage errors use the same definitions as command help. */
export function usage(args: string[]): string[] {
  const name = selected(args);
  return name === null ? [] : entries(name).flatMap(([key, entry]) => lines(key, entry));
}
/** Render root, group or command help without loading the application. */
export function render(args: string[] = []): string {
  if (!args.length) {
    const all = Object.entries(commands)
      .filter(([, entry]) => !entry.hidden)
      .flatMap(([key, entry]) => [...lines(key, entry), `    ${entry.summary}`]);
    return `corgi — a small Ghostty-powered agent terminal

Usage: corgi [COMMAND] [OPTIONS]
With no command, start or attach.

${all.join("\n")}

${options}

CORGI_SOCKET selects a runtime. PROVIDER is ${Provider.all.join(", ")}.
Agent mode compacts pane read output when called by a coding agent.
CORGI_AGENT_MODE=1 or 0 sets its default; help always lists all commands.
Ctrl+B opens the command menu; corgi keys lists shortcuts.
Use corgi COMMAND --help or corgi help COMMAND for details.

Control Corgi panes, agents, or workspaces:
  SKIP if a Corgi skill is already in your context. Otherwise run: corgi --skill
`;
  }
  const name = selected(args);
  if (name === null) throw Error("UnknownCommand");
  const items = entries(name),
    out = [`Usage:`, ...items.flatMap(([key, entry]) => lines(key, entry)), ""];
  for (const [key, entry] of items) {
    out.push(`${key.replaceAll(".", " ")}: ${entry.summary}`);
    if (entry.details) out.push(entry.details);
  }
  const root = name.split(".")[0];
  if (groupDetails[root]) out.push("", groupDetails[root]);
  if (groups.has(root)) out.push("", controlNote);
  out.push("", "Use --help or -h for help; -- ends option parsing.");
  return out.join("\n") + "\n";
}
