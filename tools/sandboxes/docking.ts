/** Real shells and split trees for trying mouse docking. */
import { join } from "node:path";
import { table, type World } from "../sandbox";

export const world: World = {
  seed(s) {
    s.write(
      join(s.dir, "editor.txt"),
      [
        "Editor · src/layout.ts",
        "",
        "export type Node =",
        "  | { pane: number }",
        "  | { split: { first: number; second: number } };",
        "",
        "Drag Checks or Logs onto this pane.",
        "Bottom left nests here; bottom middle spans both panes.",
        "",
      ].join("\n"),
    );
  },
  arrange(s) {
    const before: { id: number; model?: { tabs?: unknown[] } }[] = s.corgi(["workspace", "list"])?.workspaces ?? [];
    const made = s.corgi(["workspace", "new", "docking", "--cwd", s.dir]);
    s.corgi(["tab", "rename", String(made.tab), "Work"]);
    s.corgi(["pane", "send", String(made.pane), "cat editor.txt", "--enter"]);
    s.corgi([
      "pane",
      "split",
      String(made.pane),
      "--right",
      "--cwd",
      s.dir,
      "--command",
      "printf 'Server · localhost:3000\n\nReady for connections.\n'; exec bash --norc",
    ]);
    const checks = s.corgi([
      "tab",
      "new",
      "--workspace",
      String(made.workspace),
      "--name",
      "Checks",
      "--cwd",
      s.dir,
      "--command",
      "printf 'Checks\n\n✓ layout\n✓ mouse\n✓ undo\n'; exec bash --norc",
    ]);
    s.corgi([
      "pane",
      "split",
      String(checks.pane),
      "--down",
      "--cwd",
      s.dir,
      "--command",
      "printf 'Typecheck\n\nNo errors.\n'; exec bash --norc",
    ]);
    s.corgi([
      "tab",
      "new",
      "--workspace",
      String(made.workspace),
      "--name",
      "Logs",
      "--cwd",
      s.dir,
      "--command",
      "i=0; while :; do printf 'request %04d  GET /health  200\n' \"$i\"; i=$((i + 1)); sleep 1; done",
    ]);
    for (const w of before)
      if (w.id !== made.workspace && (w.model?.tabs?.length ?? 0) === 0)
        s.corgi(["workspace", "close", String(w.id)], false);
  },
  intro(s) {
    return [
      'Workspace "docking": Work has side-by-side panes; Checks has a stacked pair.',
      ...table([
        ["drag tab", "dock its whole tree; hold over another tab to open it"],
        ["edges", "split a leaf; the broad middle near the root divider splits the whole layout"],
        ["drag ::", "move a pane; drop in another pane's center to swap, or on the tab bar to extract"],
        ["self-drop", "drag Work into itself to start a shell at its focused pane's path"],
        ["cancel", "Esc, right-click, or release outside the docking area"],
        ["Undo / Redo", "click the tab-bar buttons; undo keeps new shells alive in their own tabs"],
        [`${s.prefixName} Ctrl+Z / Ctrl+Y`, "undo / redo from the keyboard"],
      ]),
    ];
  },
};
