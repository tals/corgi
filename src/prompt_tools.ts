//! What the prompt's model may do to Corgi: its CLI, as the `corgi` tool
//! where the provider takes one, or in its own shell, told how in the
//! session's instructions.
import skill from "../assets/corgi-skill.md" with { type: "text" };
import { field } from "./json";
import { fence } from "./prompt_conversations";
import type { HostTool } from "./providers/adapter";

/** The tool a prompt session drives Corgi with, offered to that session alone. */
export const tool: HostTool = {
  name: "corgi",
  description:
    "Runs a Corgi command and returns what it prints. `args` are the command's words after `corgi`, one per " +
    'item and unquoted: ["list"], ["grep", "--workspace", "/project", "flicker"], ["memory", "add", ' +
    '"--workspace", "Q&A", "Ships on Fridays"]. No shell runs it.',
  input: {
    type: "object",
    properties: { args: { type: "array", items: { type: "string" }, description: "The words after `corgi`." } },
    required: ["args"],
    additionalProperties: false,
  },
};
/** The words a call to the tool gives, or null when it gives none. */
export function toolArgs(input: unknown): string[] | null {
  const args = field(input, "args");
  return Array.isArray(args) && args.length && args.every(a => typeof a === "string") ? args : null;
}
/** A call as its row shows it, the command it runs: "corgi grep …". */
export function toolLine(input: unknown): string {
  return ["corgi", ...(toolArgs(input) ?? [])].join(" ");
}
/** For a session whose model runs Corgi in its own shell, where nothing says
 * which chat a command runs for: the flag that does. */
export function chatFlag(chat: number): string {
  return `Add \`--chat ${chat}\` to every \`corgi memory\` and \`corgi grep\` command, so each reports to this chat.`;
}

/** Journals may clip the command's tail; classification needs only its prefix. */
export function searchTool(line: string, binary: string): boolean {
  return ["corgi", binary, `'${binary}'`, `"${binary}"`].some(
    executable => line === executable + " grep" || line.startsWith(executable + " grep "),
  );
}
/** How the model drives Corgi, for its instructions: what's particular to
 * the prompt, then the Corgi skill whole, so it needn't go and read it. */
const reply_format =
  "Show commits inline in normal Markdown with descriptive links: [fix](abc1234@.) or [changes](main..topic@/project). Use the repository you queried; no commits fences.";
/** Existing sessions receive the current rendering contract alongside each follow-up. */
export function replyFormat(): string {
  return `<corgi-reply-format>\n${reply_format}\n</corgi-reply-format>\n`;
}
/** `tools`: the session drives Corgi with the `corgi` tool, not its shell. */
export function instructions(binary: string, tools = false): string {
  return [
    ...(tools
      ? [
          "You can drive Corgi, the terminal multiplexer you live in, with the `corgi` tool. Below and in the",
          "Corgi skill, `corgi WORDS` means calling it with WORDS as its args, unquoted; run Corgi only through it.",
        ]
      : [
          "You can drive Corgi, the terminal multiplexer you live in, with its CLI: `corgi` (also " + binary + ").",
          "CORGI_SOCKET points at this Corgi.",
        ]),
    "The viewer the user is looking at is in each message's <corgi> line.",
    "You run in no pane of your own, so `current` names nothing: use IDs from `corgi list`.",
    "To find things: `corgi list` (workspaces, tabs, panes, agents and what they're doing, viewers),",
    "`corgi history` (past conversations: provider, session, title, folder, age), `corgi pane read ID`.",
    "Search their content with `corgi grep --workspace DIR REGEX`; its index and live progress are automatic.",
    "To show the user something: `corgi resume PROVIDER SESSION --viewer V` jumps to a conversation, or",
    "reopens it in a tab if it isn't open; `corgi focus PANE --viewer V`; `corgi workspace switch ID --viewer V`.",
    "Do it when the user asks to go somewhere; don't just explain how.",
    reply_format,
    "Hover previews the diff; clicking opens review. `@.` means the prompt's workspace.",
    "To offer conversations to pick from, put them in a fenced block marked " + fence + ", one",
    "`PROVIDER SESSION` a line as `corgi history` prints them, best first. Corgi draws each with its",
    "title, folder, what the user last said and when, and the user clicks one to open it, so don't",
    "list them again as text. Use it whenever you'd list conversations; with one clear match, just open it:",
    "```" + fence,
    "claude 4f9e2a51-0c1d-4b7a-9e3f-2d8c6b1a7e50",
    "codex 019a3c2e-5b7d-7f10-a2c4-6e8d9f0b1c3a",
    "```",
    "Nothing you run asks the user first, so type into panes, close or launch things only when they ask.",
    "The Corgi skill follows.",
    "",
    "<corgi_skill>",
    skill.replace(/^---\n[^]*?\n---\n+/, "").trim(),
    "</corgi_skill>",
  ].join("\n");
}
/** The line that tells the model which viewer the user is looking at. */
export function where(viewer: number, workspace: string): string {
  return `<corgi viewer="${viewer}" workspace="${workspace.replace(/["<>\n]/g, " ")}"/>`;
}
