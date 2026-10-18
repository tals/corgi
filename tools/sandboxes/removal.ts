/**
 * The worktree removal sandbox: a repository with linked worktrees of every
 * size, to hold ⌫ on in the worktree overview.
 *
 * - quick-fix, typo: a few files, so Git is done before the effect ends.
 * - deps-cache: 40k ignored files, so "Deleting..." shows for a moment.
 * - build-output: 120k ignored files, long enough to stop with Esc.
 * - docs-pass, scratch-a, scratch-b: uncommitted files; the scratch ones hold
 *   hundreds of notes, so each overview scan takes a while.
 * - usb-disk: locked, so removal is refused.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { table, type Sandbox, type World } from "../sandbox";

function paths(s: Sandbox) {
  const repos = join(s.dir, "repos"),
    app = join(repos, "app");
  return { repos, app, tree: (name: string) => join(repos, "app-worktrees", name) };
}
/** `count` files under `dir`, a hundred to a folder. */
function fill(dir: string, count: number, text: (i: number) => string) {
  for (let i = 0; i < count; i += 100) {
    const folder = join(dir, `p${i / 100}`);
    mkdirSync(folder, { recursive: true });
    for (let k = i; k < Math.min(count, i + 100); k++) writeFileSync(join(folder, `f${k}.txt`), text(k));
  }
}

export const world: World = {
  seed(s) {
    const { repos, app, tree } = paths(s);
    s.run(["mkdir", "-p", repos]);
    s.run(["git", "init", "-q", "-b", "main", app], repos);
    for (const path of ["README.md", "src/sidebar.ts", "src/worktree_removal.ts"])
      s.write(join(app, path), s.pristine(path));
    s.write(join(app, ".gitignore"), "node_modules/\ndist/\n");
    s.dated(60 * 50);
    s.commit(app, "corgi: snapshot for the removal sandbox");
    s.dated(60 * 3);
    for (const [name, branch] of [
      ["quick-fix", "fix/quick"],
      ["typo", "fix/typo"],
      ["deps-cache", "chore/deps"],
      ["build-output", "build/output"],
      ["docs-pass", "docs/pass"],
      ["scratch-a", "spike/a"],
      ["scratch-b", "spike/b"],
      ["usb-disk", "feature/usb"],
    ])
      s.git(app, "worktree", "add", "-q", "-b", branch, tree(name));
    s.git(app, "worktree", "lock", "--reason", "on a USB disk", tree("usb-disk"));
    s.dated(40);
    s.write(join(tree("quick-fix"), "src/quick.ts"), "export const quick = true;\n");
    s.commit(tree("quick-fix"), "quick: fix it");
    fill(join(tree("deps-cache"), "node_modules"), 40_000, i => `module.exports = ${i};\n`);
    fill(join(tree("build-output"), "dist"), 120_000, i => `export default ${i};\n`);
    s.write(join(tree("docs-pass"), "README.md"), s.pristine("README.md") + "\n## Removing\n\nHold ⌫.\n");
    s.write(join(tree("docs-pass"), "docs/removal.md"), "# Removing a worktree\n");
    for (const name of ["scratch-a", "scratch-b"]) fill(join(tree(name), "notes"), 500, i => `note ${i}\n`.repeat(20));
  },

  /** A shell and an agent on main, and an agent in two of the worktrees. */
  arrange(s) {
    const { app, tree } = paths(s);
    const before: { id: number; model?: { tabs?: unknown[] } }[] = s.corgi(["workspace", "list"])?.workspaces ?? [];
    // A new workspace opens with a shell on main, which becomes the "shell" tab.
    const made: { workspace: number; tab: number } = s.corgi(["workspace", "new", "app", "--cwd", app]);
    s.corgi(["tab", "rename", String(made.tab), "shell"]);
    const tab = (name: string, cwd: string, command: string) =>
      s.corgi([
        "tab",
        "new",
        "--workspace",
        String(made.workspace),
        "--name",
        name,
        "--cwd",
        cwd,
        "--command",
        command,
      ]);
    tab("Release notes", app, "claude");
    tab("Fix typo", tree("typo"), "claude");
    tab("Docs pass", tree("docs-pass"), "codex");
    // The daemon's own starting workspace stays empty; close it so one repository shows.
    for (const w of before)
      if (w.id !== made.workspace && (w.model?.tabs?.length ?? 0) === 0)
        s.corgi(["workspace", "close", String(w.id)], false);
  },

  intro() {
    return [
      'Click "8 worktrees" on the app workspace\'s row to open the overview.',
      ...table([
        ["hold ⌫", "remove the selected worktree; let go before it fills to undo"],
        ["", "quick-fix, typo: Git is done before the effect ends; the row closes up"],
        ["", 'deps-cache: "Deleting..." for a moment once the effect ends'],
        ["", "build-output: long enough to press Esc and stop it"],
        ["", "docs-pass, scratch-a, scratch-b: the footer counts the files lost"],
        ["", "typo, docs-pass: their agents close first;  usb-disk: locked, refused"],
      ]),
    ];
  },
};
