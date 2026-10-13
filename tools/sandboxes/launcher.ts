/**
 * The launcher's sandbox: a repository with two linked worktrees, fake
 * agents on main and in each worktree, and a second workspace, so the New
 * agent launcher can be opened from each checkout.
 *
 * - main: two agents and a shell.
 * - fix/sidebar-flicker, docs/pass: an agent each, under ./.worktrees.
 * - notes: a plain folder in a workspace of its own, for the All list.
 */
import { join } from "node:path";
import { table, type Sandbox, type World } from "../sandbox";

function paths(s: Sandbox) {
  const repos = join(s.dir, "repos"),
    app = join(repos, "app");
  return {
    repos,
    origin: join(repos, "origin.git"),
    app,
    flicker: join(app, ".worktrees/sidebar-flicker"),
    docs: join(app, ".worktrees/docs-pass"),
    notes: join(repos, "notes"),
  };
}

export const world: World = {
  seed(s) {
    const { repos, origin, app, flicker, docs, notes } = paths(s);
    s.run(["mkdir", "-p", repos, notes]);
    s.run(["git", "init", "-q", "--bare", "-b", "main", origin], repos);
    s.run(["git", "clone", "-q", origin, app], repos);
    for (const path of ["README.md", "src/sidebar.ts", "docs/agent-launcher.md"])
      s.write(join(app, path), s.pristine(path));
    s.dated(60 * 26);
    s.commit(app, "corgi: snapshot for the launcher sandbox");
    s.git(app, "push", "-q", "-u", "origin", "main");
    s.git(app, "remote", "set-head", "origin", "main");
    // Where the launcher puts new worktrees, kept out of main's status as Corgi does.
    s.write(join(app, ".git/info/exclude"), "/.worktrees/\n");
    s.dated(90);
    s.git(app, "worktree", "add", "-q", "-b", "fix/sidebar-flicker", flicker, "origin/main");
    s.git(app, "worktree", "add", "-q", "-b", "docs/pass", docs, "origin/main");
    s.write(join(notes, "ideas.md"), "# Ideas\n\n- Dim what a new agent won't join.\n");
  },

  /** One tab per agent in its checkout, a shell on main, and the notes workspace. */
  arrange(s) {
    const { app, flicker, docs, notes } = paths(s);
    const before: { id: number; model?: { tabs?: unknown[] } }[] = s.corgi(["workspace", "list"])?.workspaces ?? [];
    const tab = (workspace: number, name: string, cwd: string, command: string) =>
      s.corgi(["tab", "new", "--workspace", String(workspace), "--name", name, "--cwd", cwd, "--command", command]);
    // A new workspace opens with a shell on main, which becomes the "shell" tab.
    // A viewer starts on the first workspace, so app comes first.
    const made: { workspace: number; tab: number } = s.corgi(["workspace", "new", "app", "--cwd", app]);
    s.corgi(["tab", "rename", String(made.tab), "shell"]);
    tab(made.workspace, "Release notes", app, "claude");
    tab(made.workspace, "Fix sidebar flicker", flicker, "claude");
    tab(made.workspace, "Docs pass", docs, "codex");
    tab(made.workspace, "Changelog", app, "codex");
    const other: { workspace: number; tab: number } = s.corgi(["workspace", "new", "notes", "--cwd", notes]);
    s.corgi(["tab", "rename", String(other.tab), "shell"]);
    tab(other.workspace, "Ideas", notes, "claude");
    // The daemon's own starting workspace stays empty; close it so only these show.
    for (const w of before)
      if (w.id !== made.workspace && w.id !== other.workspace && (w.model?.tabs?.length ?? 0) === 0)
        s.corgi(["workspace", "close", String(w.id)], false);
  },

  intro(s) {
    return [
      'Workspace "app": agents on main and in two worktrees; "notes" is a plain folder.',
      ...table([
        [`${s.prefixName} c`, "open the New agent launcher from the focused agent's checkout"],
        ["", "on main: worktree groups fade, the title stays gray"],
        ["", "in a worktree: only its group stays lit, its ⌥ name turns warm"],
        ["w", "in the launcher: choose another checkout; the light follows"],
        ["n", "in the launcher: name a new worktree; everything fades"],
        ["agents ▾", "switch the agent list to All: other workspaces fade too"],
      ]),
    ];
  },
};
