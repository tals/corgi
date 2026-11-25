/**
 * The file peek sandbox: a transcript naming files, with lines and without,
 * and a log another tab keeps writing to.
 *
 * - transcript: paths to code with a line, a stack frame with a column, a
 *   file without a line, the log, and a screenshot. Rest the pointer on one
 *   to peek, or on the screenshot for its picture.
 * - writer: appends to logs/server.log, so its peek and its pane follow.
 */
import { closeSync, copyFileSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { table, type World } from "../sandbox";

const levels = ["DEBUG", "DEBUG", "DEBUG", "INFO", "INFO", "WARN"];
function log(lines: number): string {
  let out = "";
  for (let i = 0; i < lines; i++) {
    const t = new Date(Date.UTC(2026, 10, 8, 14, 0, 0) + i * 37).toISOString();
    const level = i % 997 === 0 ? "ERROR" : levels[i % levels.length];
    out +=
      level === "ERROR"
        ? `${t} ERROR saved-state checkpoint write failed err="ENOSPC: no space left on device"\n`
        : `${t} ${level.padEnd(5)} render frame pane=${1 + (i % 4)} rows=48 dirty=${i % 7} ms=0.${i % 10}${i % 7}\n`;
  }
  return out;
}
/** A log of `blocks` × `lines` lines, too large to scan for a deep line without asking. */
function huge(path: string, lines: number, blocks: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const block = Buffer.from(log(lines)),
    fd = openSync(path, "w");
  try {
    for (let i = 0; i < blocks; i++) writeSync(fd, block);
  } finally {
    closeSync(fd);
  }
}

export const world: World = {
  seed(s) {
    const root = join(import.meta.dir, "../..");
    s.write(join(s.dir, "src", "highlight.ts"), readFileSync(join(root, "src/review/syntax.ts"), "utf8"));
    s.write(join(s.dir, "package.json"), readFileSync(join(root, "package.json"), "utf8"));
    s.write(join(s.dir, "logs", "server.log"), log(200_000));
    mkdirSync(join(s.dir, "shots"), { recursive: true });
    copyFileSync(join(root, "docs/images/manage-agents/manage.png"), join(s.dir, "shots", "manage-agents.png"));
    // About 600 MB and 6.5 million lines: a line deep in it is asked about before it's scanned for.
    huge(join(s.dir, "logs", "trace.log"), 65_536, 100);
    s.write(
      join(s.dir, "transcript.txt"),
      [
        "> the review panel stalls when I open a big diff. why?",
        "",
        "⏺ Bash(CORGI_LOG=trace ./serve.sh)",
        "  ⎿ trace in logs/server.log (18 MB, still growing)",
        "  ⎿ yesterday's run in logs/trace.log; the stall starts at logs/trace.log:6000000",
        "",
        "⏺ Coloring isn't the slow part. The highlighter at",
        "  src/highlight.ts:382 lexes lazily, 200 lines a chunk,",
        "  and keeps the lexer state at each chunk start.",
        "",
        "⏺ Bash(bun test src/highlight.test.ts)",
        "  ⎿ ✗ colors a block comment that ends mid-line",
        "      at lexLine (src/highlight.ts:301:17)",
        "",
        "⏺ Read(package.json)",
        "  ⎿ Read 39 lines",
        "",
        "⏺ Bash(bun tools/ghostty_screenshot.ts --sandbox launcher -o shots/manage-agents.png)",
        "  ⎿ Saved shots/manage-agents.png",
        "",
        "Rest the pointer on a path to peek; click one to open it.",
      ].join("\n"),
    );
  },

  arrange(s) {
    const before: { id: number; model?: { tabs?: unknown[] } }[] = s.corgi(["workspace", "list"])?.workspaces ?? [];
    const made: { workspace: number; tab: number; pane: number } = s.corgi([
      "workspace",
      "new",
      "files",
      "--cwd",
      s.dir,
    ]);
    s.corgi(["tab", "rename", String(made.tab), "writer"]);
    s.corgi([
      "pane",
      "send",
      String(made.pane),
      `while :; do echo "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ) INFO  writer tick n=$RANDOM" >> logs/server.log; sleep 0.3; done`,
      "--enter",
    ]);
    s.corgi([
      "tab",
      "new",
      "--workspace",
      String(made.workspace),
      "--name",
      "transcript",
      "--cwd",
      s.dir,
      "--command",
      "while :; do clear; cat transcript.txt; read -r _; done",
    ]);
    for (const w of before)
      if (w.id !== made.workspace && (w.model?.tabs?.length ?? 0) === 0)
        s.corgi(["workspace", "close", String(w.id)], false);
  },

  intro() {
    return [
      'Tab "transcript": paths to peek at and open; tab "writer" grows logs/server.log.',
      ...table([
        ["rest", "on a path: its peek, at the line the text names"],
        ["trace.log:6000000", "a line deep in 600 MB: the peek asks before it scans, then shows progress"],
        ["wheel", "in the peek: scroll; up on the log pauses it"],
        ["click", "a path or a peek line: opens it in a pane beside"],
        ["rest", "on shots/manage-agents.png: its picture; c copies, o or a click opens it"],
        ["q", "in that pane: close it; e opens $EDITOR there"],
      ]),
    ];
  },
};
