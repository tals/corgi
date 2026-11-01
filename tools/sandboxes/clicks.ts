/**
 * The click-selection sandbox: double-click a word, triple-click a line, on
 * text built for the edge cases, and on a pane that keeps redrawing.
 *
 * - words: paths, hosts, punctuation, wide text, links (plain, OSC 8 with a
 *   label, a label that spoofs another URL), tokens that soft-wrap, and
 *   scrollback to pick from. Enter prints it again.
 * - ticker: a spinner line that changes under a highlight, and a still one.
 * - less: the same text in `less --mouse`, a mouse-aware app.
 * - shell: a plain shell, for prompts and your own output.
 */
import { join } from "node:path";
import { table, type World } from "../sandbox";

const link = (url: string, label: string) => `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`;
const bold = (text: string) => `\x1b[1m${text}\x1b[0m`;

function sheet(): string {
  const history = Array.from({ length: 120 }, (_, i) => {
    const n = String(i + 1).padStart(3, "0");
    return `history ${n}  build/out-${n}.o  see notes/line-${n}.md.  host-${n}:80${n}`;
  });
  const long = "wrapped/" + Array.from({ length: 14 }, (_, i) => `segment-${i + 1}`).join("/") + "/end.ts";
  const words = Array.from({ length: 40 }, (_, i) => `word${i + 1}`).join(" ");
  return [
    ...history,
    "",
    bold("Double-click a word, triple-click a line; drag to extend."),
    "",
    "  paths     src/terminal.ts:42:7   ./build/out.o,   ~/notes/todo.md",
    "  hosts     localhost:8080   10.0.0.7:22   user@example.com",
    '  sentence  see src/a.ts. then (in/parens.ts) and "quoted.txt" ok? yes!',
    "  hash      0123456789abcdef0123456789abcdef01234567",
    "  wide      日本語のテキスト  emoji🐕corgi  café-au-lait",
    "  nothing   ...   ,,,      (and the blank cells)",
    "",
    bold("Links: a click opens; a double-click copies."),
    "",
    "  plain     https://corgi.computer/",
    "  parens    https://en.wikipedia.org/wiki/Foo_(bar)?q=1#x",
    `  osc 8     read the ${link("https://corgi.computer/docs", "docs")} first`,
    `  spoof     ${link("https://corgi.computer/spoof", "https://safe.example/")}`,
    `  spaces    ${link("https://corgi.computer/spaces", "a link with spaces")} here`,
    "  file      file:///etc/hostname",
    "",
    bold("Soft-wrapped:"),
    "",
    `  ${long}`,
    `  ${words}`,
    "",
    "Enter prints this again; scroll up for history.",
  ].join("\n");
}

const ticker = [
  "printf 'still: spin/word.ts stays put\\n\\n'",
  "spin='|/-\\'",
  "i=0",
  "while :; do",
  "  printf '\\r%s working on src/tick-%03d.ts ' \"${spin:i%4:1}\" $((i % 1000))",
  "  i=$((i + 1))",
  "  sleep 1",
  "done",
].join("\n");

export const world: World = {
  seed(s) {
    s.write(join(s.dir, "words.ans"), sheet() + "\n");
    s.write(join(s.dir, "ticker.sh"), ticker + "\n");
  },

  /** The sheet, the ticker, the sheet in less, and a shell. */
  arrange(s) {
    const before: { id: number; model?: { tabs?: unknown[] } }[] = s.corgi(["workspace", "list"])?.workspaces ?? [];
    const made: { workspace: number; tab: number } = s.corgi(["workspace", "new", "clicks", "--cwd", s.dir]);
    s.corgi(["tab", "rename", String(made.tab), "shell"]);
    const tab = (name: string, command: string): { pane: number; tab: number } =>
      s.corgi([
        "tab",
        "new",
        "--workspace",
        String(made.workspace),
        "--name",
        name,
        "--cwd",
        s.dir,
        "--command",
        command,
      ]);
    const words = tab("words", "cat words.ans; while read -r _; do cat words.ans; done");
    tab("ticker", "bash ticker.sh");
    tab("less", "less --mouse -R words.ans");
    // A viewer opens on the first tab: the sheet, not the shell.
    s.corgi(["tab", "move", String(made.tab), "--after", String(words.tab)]);
    for (const w of before)
      if (w.id !== made.workspace && (w.model?.tabs?.length ?? 0) === 0)
        s.corgi(["workspace", "close", String(w.id)], false);
  },

  intro(s) {
    return [
      'Workspace "clicks": tab "words" holds the edge cases.',
      ...table([
        ["2× click", "copies the word once the 300 ms window passes"],
        ["3× click", "copies only the line, never the word first"],
        ["2× + drag", "extends by words; 3× + drag by lines"],
        ["click", "a link opens after 300 ms; a double-click on it copies instead"],
        ["2× link", "osc 8 copies 'docs'; spoof copies the label, not its target"],
        ["2× ticker", "the changing line's highlight goes on its next redraw"],
        ["scroll up", "double-click in history copies from it"],
        ["tab less", "plain clicks are less's; Shift+2× and Shift+3× pick anyway"],
        [`${s.prefixName} s`, "copy mode drops a pick's highlight"],
      ]),
    ];
  },
};
