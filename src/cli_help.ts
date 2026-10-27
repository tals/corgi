import * as i18n from "./i18n";
import * as config from "./build_config";
import * as releaseLabel from "./release_label";
import { displayWidth } from "./text";

/** A command, an example of its arguments, and what it does or its subcommands. */
type Row = [command: string, example: string, about: string];
const commandWidth = 13,
  exampleWidth = 21;

/** `corgi --help`: the common commands by group, styled like Bun's on a
 * terminal. `corgi help --all` prints the full reference. */
export function overview(
  rich: boolean,
  release = releaseLabel.of(config.releaseVersion, config.releaseCommit, config.builtAt),
): string {
  const sgr = (code: string, text: string) => (rich && text ? `\x1b[${code}m${text}\x1b[0m` : text),
    bold = (text: string) => sgr("1", text),
    dim = (text: string) => sgr("2", text),
    link = (url: string, text: string) => (rich ? `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\` : text);
  const groups: [string, Row[]][] = [
    [
      i18n.t`Start`,
      [
        ["corgi", "", i18n.t`Start Corgi or attach to it`],
        ["open", "~/src/app", i18n.t`Show a folder's workspace, or add one`],
        ["keys", "tmux", i18n.t`List shortcuts; Ctrl+B opens the menu`],
      ],
    ],
    [
      i18n.t`Layout`,
      [
        ["list", "[--json]", i18n.t`Workspaces, tabs, panes and agents`],
        ["workspace", "new api [--cwd DIR]", "new, edit, switch, archive, close"],
        ["tab", "new [--name logs]", "new, rename, move, merge, close"],
        ["pane", "split 3 --right", "split, move, resize, read, send, keys, close"],
      ],
    ],
    [
      i18n.t`Agents`,
      [
        ["message", '4 "keep going"', i18n.t`Prompt an agent through its own channel`],
        ["launcher", "edit claude", "list, hide, show, move, edit, clone, add"],
        ["history", "[--limit 20]", i18n.t`Past conversations, newest first`],
        ["grep", '[-i] "flaky test"', i18n.t`Search conversation text`],
        ["resume", "claude <session>", i18n.t`Reopen a past conversation`],
      ],
    ],
    [
      i18n.t`Setup`,
      [
        ["account", "add claude work", "list, add, login, remove"],
        ["integration", "install claude", "status, install, uninstall"],
        ["update", "[--check]", i18n.t`Download and apply an update`],
      ],
    ],
  ];
  const short = releaseLabel.short(release),
    time = releaseLabel.time(release),
    commit = short && link(releaseLabel.url(release), short) + (release.dirty ? "-dirty" : ""),
    build = commit && time ? i18n.t`Build ${commit} built on ${time}` : commit && i18n.t`Build ${commit}`,
    details = bold("corgi <command> --help"),
    all = bold("corgi help --all");
  const lines = [
    `${i18n.t`Happy helper for your terminal.`} ${dim(build)}`.trimEnd(),
    "",
    `${bold(i18n.t`Usage:`)} ${bold("corgi [command]")} ${sgr("36", "[...flags]")} ${bold("[...args]")}`,
    "",
  ];
  for (const [title, rows] of groups) {
    lines.push(bold(title));
    for (const [command, example, about] of rows)
      lines.push(
        "  " +
          sgr("1;32", command) +
          " ".repeat(commandWidth - command.length) +
          dim(example) +
          " ".repeat(exampleWidth - example.length) +
          about,
      );
    lines.push("");
  }
  const column = 2 + commandWidth + exampleWidth,
    footer = (label: string, color: string, url: string) =>
      label + " ".repeat(Math.max(2, column - displayWidth(label))) + sgr(color, url);
  lines.push(
    i18n.t`${details} for details · ${all} for everything`,
    "",
    footer(i18n.t`Learn more about Corgi:`, "35", "https://corgi.computer"),
    footer(i18n.t`Join our Discord community:`, "34", "https://discord.gg/8v6eNAKuT"),
  );
  return lines.join("\n") + "\n";
}

export function commands(): string {
  return [
    i18n.t`Agent controls (--json prints the daemon's reply as JSON):`,
    i18n.t`  corgi list [--json]                 layout, panes, agents, viewers`,
    "  corgi workspace list",
    "  corgi workspace new NAME [--cwd DIR]",
    "  corgi workspace edit ID [--name NAME] [--cwd DIR]",
    i18n.t`  corgi workspace close ID          requires an empty workspace`,
    i18n.t`  corgi workspace archive ID        hibernate panes and hide the workspace`,
    i18n.t`  corgi workspace unarchive ID      show the workspace; panes stay asleep`,
    "  corgi workspace switch ID [--viewer ID]",
    i18n.t`  corgi current                      calling pane's live location`,
    "  corgi tab new [--name NAME] [--cwd DIR] [--workspace ID] [--command SHELL_COMMAND]",
    "  corgi tab rename ID|current NAME|--clear",
    "  corgi tab move ID|current --before ID|--after ID|--workspace ID",
    "  corgi tab merge ID|current --right-of ID|--left-of ID|--above ID|--below ID",
    "  corgi tab close ID|current",
    "  corgi pane split ID|current --right|--left|--up|--down [--cwd DIR] [--command SHELL_COMMAND]",
    "  corgi pane move ID|current --right-of ID|--left-of ID|--above ID|--below ID",
    "  corgi pane move ID|current --new-tab [--name NAME]",
    "  corgi pane swap ID|current ID",
    "  corgi pane resize ID|current --width PERCENT|--height PERCENT (10%-90%)",
    "  corgi pane close ID|current",
    i18n.t`  corgi pane hibernate ID|current... hibernate panes and stop their processes`,
    i18n.t`  corgi pane wake ID|current         resume or restart a pane`,
    "  corgi pane read ID|current [--lines N] [--json]",
    "  corgi pane send ID|current TEXT|--stdin [--enter]",
    i18n.t`  corgi pane keys ID|current KEY...    enter, esc, ctrl+c, arrows, etc.`,
    "  corgi message ID|current|pane:ID|headless:ID TEXT|--stdin",
    i18n.t`    prompt through the agent's own channel, or type it and press Enter`,
    i18n.t`  corgi pane idle [--workspace ID] [--cwd DIR] [--first]  shells at their prompt`,
    "  corgi claim PROVIDER [--pane ID|current] [--owner PID]",
    "  corgi claim --clear [--pane ID|current] [--owner PID]",
    i18n.t`  corgi focus ID|current --viewer ID  select in exactly one viewer`,
    i18n.t`  corgi history [--limit N] [--json]  past conversations, newest first`,
    "  corgi grep [--workspace NAME|ID|DIR|'*'] [--max-age 7d] [--tools] [-iC2] REGEX",
    i18n.t`    search conversation text; --session PROVIDER:ID narrows, -o extracts matches`,
    i18n.t`  corgi resume PROVIDER SESSION [--viewer ID] [--workspace ID]  show it: focus
    the pane already showing it, or resume it in a tab where its folder belongs`,
    i18n.t`  corgi launcher list [--workspace ID] [--json]  agents each launcher shows`,
    i18n.t`  corgi launcher hide AGENT... [--workspace ID]  in one workspace only`,
    i18n.t`  corgi launcher show AGENT... [--workspace ID]  in one workspace only`,
    "  corgi launcher move AGENT [--before AGENT|--after AGENT|--first] [--workspace ID]",
    "  corgi launcher edit AGENT [--name NAME] [--model ID|auto] [--effort LEVEL|default]",
    "    [--flags FLAGS] [--env JSON_OBJECT] [--yolo on|off] [--workspace ID]",
    "  corgi launcher clone AGENT [--name NAME] [--model ID|auto] [--effort LEVEL|default]",
    "    [--flags FLAGS] [--env JSON_OBJECT] [--yolo on|off] [--workspace ID]",
    i18n.t`  corgi launcher models AGENT [--json]  native model IDs, efforts and defaults`,
    "  corgi launcher add --command COMMAND [--name NAME] [--workspace ID]",
    "  corgi launcher edit AGENT --command COMMAND [--name NAME] [--workspace ID]",
    i18n.t`  corgi launcher remove AGENT [--workspace ID]  delete a clone or saved command`,
    i18n.t`  corgi launcher copy --from ID --workspace ID  replace destination order and visibility`,
    i18n.t`  corgi memory search WORDS... [--limit N]  the Corgi prompt's memory lines`,
    i18n.t`  corgi memory get [FILE[:FROM[-TO]]]  its files, or a file's lines`,
    "  corgi memory add [--long|--workspace NAME] [--replaces FILE:LINE] TEXT...",
    i18n.t`    to today's log, MEMORY.md or a workspace's note; an exact repeat isn't added`,
    "  corgi memory forget FILE:LINE",
    i18n.t`  corgi --skill                      print bundled agent instructions`,
    "",
    i18n.t`IDs come from list; current means CORGI_PANE, never UI focus.`,
    i18n.t`New tabs and launcher mutations outside Corgi require --workspace.`,
    i18n.t`Agent settings are shared; order and visibility belong to each workspace.`,
    i18n.t`Move without a position appends. Env replaces overrides, e.g. '{"KEY":"value"}'.`,
    i18n.t`Auto uses the agent CLI's last model; default leaves effort to the agent CLI.`,
    i18n.t`AGENT is codex, claude, an account (claude/work or work), a saved command's
name, profile/ID, a clone name, or command/N, as launcher list names them.`,
    i18n.t`Operations never auto-start a server.`,
    i18n.t`Layout changes preserve processes and do not select another pane in a viewer.`,
    "",
    i18n.t`Control Corgi panes, agents, or workspaces:`,
    i18n.t`  SKIP if a Corgi skill is already in your context. Otherwise run: corgi --skill`,
    "",
  ].join("\n");
}

export function main(): string {
  return [
    i18n.t`corgi — a small Ghostty-powered agent terminal`,
    "",
    i18n.t`  corgi                         start / attach`,
    i18n.t`  corgi open DIR                show DIR's workspace; add one if none`,
    i18n.t`  corgi onboard                 open onboarding, even after setup`,
    i18n.t`  corgi dev                     reload if changed; attach or relaunch viewer`,
    i18n.t`  corgi --no-update             attach without activating a staged update`,
    i18n.t`  corgi update                  download and safely apply an update`,
    i18n.t`  corgi update status           show update status`,
    i18n.t`  corgi update rollback         return to the previous release`,
    "  corgi update --check|--download-only",
    i18n.t`  corgi update auto on|off      control automatic updates`,
    i18n.t`  corgi start                   start detached runtime`,
    i18n.t`  corgi action NAME [VALUE] [--viewer ID]  run a viewer action, named below`,
    i18n.t`  corgi agent claude|codex ...   optional discovered-binary launcher`,
    i18n.t`  corgi hooks claude|codex       print hook configuration`,
    i18n.t`  corgi integration COMMAND     status, install, uninstall hooks`,
    i18n.t`  corgi account COMMAND         list, add, login, remove provider accounts`,
    "  corgi voice [--ssh HOST] [--model NAME] [--device ID] [--threshold N] [--silence SECONDS] [--port PORT] [--no-filter] [--verbose]",
    i18n.t`                                dictate into the focused pane by speaking`,
    "  corgi voice setup [--model tiny.en|base.en|small.en|medium|large-v3-turbo]",
    i18n.t`                                check tools, download a speech model`,
    i18n.t`  corgi which claude|codex      show automatically selected executable`,
    i18n.t`  corgi keys [PRESET]           list shortcuts: corgi, tmux, herdr, cmux`,
    "  corgi headless start PROVIDER PROMPT [--workspace ID]",
    i18n.t`  corgi headless list              list headless sessions`,
    i18n.t`  corgi headless send PROVIDER SESSION JSON   prompt, answer or interrupt`,
    i18n.t`  corgi headless events PROVIDER SESSION [SEQ]   journal + pending requests`,
    i18n.t`  corgi headless stop PROVIDER SESSION        stop headless session`,
    i18n.t`  corgi watch --json            print agent states as JSON lines as they change`,
    i18n.t`  corgi usage --json            print each account's limits and spend as JSON`,
    i18n.t`  corgi rpc JSON                local JSON control protocol`,
    i18n.t`  corgi reload [ABSOLUTE_EXE]    replace daemon, preserve live processes`,
    i18n.t`  corgi checkpoint               save recovery context now`,
    i18n.t`  corgi shutdown                terminate runtime and its panes`,
    i18n.t`  corgi bugreport [--full]      details for a bug report, and a link to file it`,
    i18n.t`  corgi licenses                Corgi's license and the software it includes`,
    i18n.t`  corgi help [COMMAND ...]      show help for a command or group`,
    i18n.t`  corgi help --all              list every command`,
    i18n.t`  corgi --help                  list common commands (also -h)`,
    i18n.t`  corgi --version               print the version and commit`,
    "",
    i18n.t`Keys: Ctrl+B opens a clickable command menu; \`corgi keys\` lists every shortcut.`,
    "",
    "",
    "",
    "",
    i18n.t`CORGI_SOCKET selects a runtime. Workspaces group tabs and panes; no worktrees.`,
    i18n.t`Commands print text; --json prints the daemon's reply as JSON instead.`,
    "",
  ].join("\n");
}
