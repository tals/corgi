/**
 * The copy cleanup sandbox: drag over text an agent wrapped at the pane's
 * edge, lines the terminal wrapped, and an app that takes the mouse.
 *
 * - commands: commands a fake agent wraps at the pane's width, redrawn when
 *   the pane resizes; each note says what a drag over the rows copies.
 * - text: YAML, prose, a list, and the cases cleanup still gets wrong.
 * - shell: long lines the terminal wraps, then a shell for your own.
 * - less: the commands in `less --mouse`, which keeps plain drags.
 *
 * `bun tools/sandboxes/copy.ts commands|text` draws a page on its own.
 */
import { join } from "node:path";
import { table, type World } from "../sandbox";

interface Item {
  note: string;
  /** The block's lines for a pane `width` cells wide, before wrapping. */
  lines: (width: number) => string[];
}

const commands: Item[] = [
  {
    note: "wrapped command → one line",
    lines: () => [
      "kubectl --kubeconfig ~/.kube/home-config -n monitoring rollout restart deployment/grafana --context prod-eu-west-1",
    ],
  },
  {
    note: "backslashes → one line",
    lines: () => [
      "docker run --rm \\",
      '  -v "$PWD:/src" \\',
      "  -e RUST_LOG=debug \\",
      "  ghcr.io/acme/builder:latest cargo build --release",
    ],
  },
  {
    note: "a pipeline over rows → one line",
    lines: () => ["git log --oneline --since=2.weeks", "  | grep -i fix", "  | head -20"],
  },
  {
    note: "&& ending a row → one line",
    lines: () => ["cd ./services/api &&", "bun install --frozen-lockfile"],
  },
  {
    note: "a URL split at the edge → one line",
    lines: () => [
      "curl -fsSL https://raw.githubusercontent.com/acme/tools/refs/heads/main/scripts/install-everything-for-the-dev-environment.sh | sh",
    ],
  },
  {
    note: "two commands, the first filling its row → two lines",
    lines: width => [filling("rm -rf ./build/output", width), "make install"],
  },
  {
    note: "a prompt → dropped",
    lines: () => ["$ git push --force-with-lease origin feature/copy-cleanup"],
  },
];

const text: Item[] = [
  {
    note: "YAML → its lines, without the shared indent",
    lines: () => [
      "apiVersion: apps/v1",
      "kind: Deployment",
      "metadata:",
      "  name: corgi-daemon",
      "spec:",
      "  replicas: 3",
      "  template:",
      "    spec:",
      "      containers:",
      "        - name: corgi",
      "          image: ghcr.io/acme/corgi:1.4.0",
    ],
  },
  {
    note: "prose → its lines",
    lines: () => [
      "The daemon keeps every pane's terminal, so a viewer that reconnects picks up where it left off; the viewer only mirrors what the daemon draws.",
    ],
  },
  {
    note: "a numbered list → its lines",
    lines: () => ["1. Build the native layer with bun build.ts", "2. Run bun test src", "3. Open a sandbox"],
  },
  {
    note: "still wrong: a prompt and its output join",
    lines: width => [filling("$ ls -la ./build/output", width), "total 0"],
  },
  {
    note: "still wrong: ls -l rows join the command",
    lines: width => [filling("ls -la ./build/output", width), "-rw-r--r--  1 corgi staff  0 Nov 20 09:00 a.o"],
  },
];

const indent = "  ";

/** `head` grown with path segments until it ends two cells before the
 * pane's edge, so no next word wider than one cell fits after it. */
function filling(head: string, width: number): string {
  const target = width - indent.length - 2;
  let line = head;
  for (let i = 0; line.length < target; i++) line += `/part-${i}`;
  return line.slice(0, Math.max(head.length, target)).replace(/\/$/, "x");
}

/** `line` wrapped as an agent's renderer wraps it at `width`: at a space
 * when the next word won't fit, inside a word only when it is wider than a
 * row; each row indented, and by the line's own indent too. */
function wrap(line: string, width: number): string[] {
  const own = /^ */.exec(line)![0];
  const room = Math.max(10, width - indent.length - own.length);
  const rows: string[] = [];
  let row = "";
  for (let word of line.slice(own.length).split(" ")) {
    if (row !== "" && row.length + 1 + word.length > room) {
      rows.push(row);
      row = "";
    }
    if (row !== "") row += " ";
    while (row.length + word.length > room) {
      const fits = room - row.length;
      rows.push(row + word.slice(0, fits));
      row = "";
      word = word.slice(fits);
    }
    row += word;
  }
  rows.push(row);
  return rows.map(row => indent + own + row);
}

/** A page of items drawn for a pane `width` cells wide. */
function page(items: Item[], width: number): string {
  const out: string[] = [];
  for (const item of items) {
    out.push(`\x1b[2m▸ ${item.note}\x1b[0m`);
    for (const line of item.lines(width)) out.push(...wrap(line, width));
    out.push("");
  }
  out.push("\x1b[2mDrag over a block's rows. Enter redraws; resizing the pane rewraps.\x1b[0m");
  return out.join("\r\n");
}

/** Draws `items` and draws them again on Enter or a resize. */
function show(items: Item[]): void {
  const draw = () => process.stdout.write(`\x1b[H\x1b[2J\x1b[3J${page(items, process.stdout.columns ?? 80)}`);
  draw();
  process.stdout.on("resize", draw);
  process.stdin.on("data", draw);
}

if (import.meta.main) {
  const which = process.argv[2];
  show(which === "text" ? text : commands);
}

const soft = [
  "\x1b[2m# Lines the terminal wraps: a drag over one copies it whole.\x1b[0m",
  "$ kubectl get pods --all-namespaces -o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName,STATUS:.status.phase --sort-by=.metadata.creationTimestamp",
  `$ curl -fsSL "https://example.com/api/v2/search?q=corgi&sort=stars&order=desc&per_page=100&page=2" | jq '.items[].full_name'`,
  "\x1b[2m# Type your own long command; then drag over it.\x1b[0m",
].join("\n");

export const world: World = {
  seed(s) {
    s.write(join(s.dir, "soft.txt"), soft + "\n");
    s.write(join(s.dir, "commands.txt"), page(commands, 72).replaceAll("\r\n", "\n") + "\n");
  },

  /** The two agent pages, the shell and less. */
  arrange(s) {
    const before: { id: number; model?: { tabs?: unknown[] } }[] = s.corgi(["workspace", "list"])?.workspaces ?? [];
    const made: { workspace: number; tab: number } = s.corgi(["workspace", "new", "copy", "--cwd", s.dir]);
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
    const draw = (which: string) => `'${process.execPath}' '${import.meta.path}' ${which}`;
    tab("commands", draw("commands"));
    tab("text", draw("text"));
    tab("shell", "cat soft.txt; PS1='$ ' exec bash --norc --noprofile -i");
    tab("less", "less --mouse -R commands.txt");
    // A viewer opens on the first tab: the commands, not a spare shell.
    s.corgi(["tab", "close", String(made.tab)], false);
    for (const w of before)
      if (w.id !== made.workspace && (w.model?.tabs?.length ?? 0) === 0)
        s.corgi(["workspace", "close", String(w.id)], false);
  },

  intro(s) {
    return [
      'Workspace "copy": each block\'s note says what a drag over it copies.',
      ...table([
        ["drag", "copies the block cleaned up; the notice says when it joined a line"],
        ["Alt+drag", "copies exactly as shown (Ctrl too, outside macOS Ghostty)"],
        ["resize", "the commands and text tabs rewrap at the new width; Enter redraws"],
        ["tab text", "YAML, prose, a list, and two cases cleanup still joins wrongly"],
        ["tab shell", "lines the terminal wrapped copy whole; type your own"],
        ["tab less", "less takes the mouse: Shift+drag selects, and copies raw"],
        [`${s.prefixName} i`, "Clever Corgi › Smart Copy turns it off and on"],
      ]),
    ];
  },
};
