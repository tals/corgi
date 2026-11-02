//! What the prompt's model may do to Corgi: its CLI, told how in the
//! session's instructions, and which of its commands run without asking.
import skill from "../assets/corgi-skill.md" with { type: "text" };
import { fence } from "./prompt_conversations";

/** Commands that only look or move a viewer's selection; anything that types
 * into a pane, closes or edits something still asks. */
const looking = [
  ["list"],
  ["current"],
  ["history"],
  ["resume"],
  ["focus"],
  ["workspace", "list"],
  ["workspace", "switch"],
  ["pane", "read"],
  ["launcher", "list"],
  ["--help"],
  ["--skill"],
];
const valued = new Set(["--viewer", "--workspace", "--limit", "--lines"]);
const flags = new Set(["--json"]);
/** The words of `line` when it is plain words and quoted strings holding
 * nothing a shell would expand or run; null for anything else. */
function shellWords(line: string): string[] | null {
  const word = /\s*(?:'([^']*)'|"([^"$`\\!]*)"|([A-Za-z0-9_.:/@+=,-]+))(?=\s|$)/y,
    out: string[] = [];
  for (let at = 0; line.slice(at).trim(); at = word.lastIndex) {
    word.lastIndex = at;
    const m = word.exec(line);
    if (!m) return null;
    out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out;
}
/** Whether `line`, a whole shell command, is one Corgi command that only
 * looks, or a memory command, which touches only the memory folder: plain
 * words, with no pipes, redirects or substitutions, run as `corgi` or as
 * `binary`, the daemon's own executable. Only a memory command's text may
 * be quoted. */
export function looks(line: string, binary: string): boolean {
  const said = line.length <= 2048 ? shellWords(line) : null;
  if (said && (said[0] === "corgi" || said[0] === binary) && said[1] === "memory")
    return ["search", "get", "add", "forget"].includes(said[2]);
  if (!/^[A-Za-z0-9_.:/@+= -]+$/.test(line) || line.length > 512) return false;
  const words = line.split(" ").filter(Boolean);
  if (words[0] !== "corgi" && words[0] !== binary) return false;
  const rest = words.slice(1),
    command = looking.find(c => c.every((w, i) => rest[i] === w));
  if (!command) return false;
  const args = rest.slice(command.length);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (flags.has(a)) continue;
    if (valued.has(a)) {
      if (!/^\d+$/.test(args[++i] ?? "")) return false;
      continue;
    }
    if (a.startsWith("-")) return false;
  }
  return true;
}
/** How the model drives Corgi, for its instructions: what's particular to
 * the prompt, then the Corgi skill whole, so it needn't go and read it. */
export function instructions(binary: string): string {
  return [
    "You can drive Corgi, the terminal multiplexer you live in, with its CLI: `corgi` (also " + binary + ").",
    "CORGI_SOCKET points at this Corgi. The viewer the user is looking at is in each message's <corgi> line.",
    "You run in no pane of your own, so `current` names nothing: use IDs from `corgi list`.",
    "To find things: `corgi list` (workspaces, tabs, panes, agents and what they're doing, viewers),",
    "`corgi history` (past conversations: provider, session, title, folder, age), `corgi pane read ID`.",
    "To show the user something: `corgi resume PROVIDER SESSION --viewer V` jumps to a conversation, or",
    "reopens it in a tab if it isn't open; `corgi focus PANE --viewer V`; `corgi workspace switch ID --viewer V`.",
    "Do it when the user asks to go somewhere; don't just explain how.",
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
