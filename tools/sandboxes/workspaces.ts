/** Workspaces on sibling folders, with spare folders to move them to and agents to rename. */
import { join } from "node:path";
import { table, type World } from "../sandbox";

const folders = ["projects/web", "projects/web-v2", "projects/billing", "projects/billing-next", "projects/docs"];

export const world: World = {
  seed(s) {
    for (const folder of folders)
      s.write(join(s.dir, folder, "README.md"), `# ${folder}\n\nA folder for trying workspace moves.\n`);
    s.write(
      join(s.home, ".claude/.claude.json"),
      JSON.stringify({
        oauthAccount: { emailAddress: "sandbox@example.com", accountUuid: "sandbox" },
        hasCompletedOnboarding: true,
      }),
    );
  },
  arrange(s) {
    const before: { id: number; model?: { tabs?: unknown[] } }[] = s.corgi(["workspace", "list"])?.workspaces ?? [];
    const agent = (workspace: number, cwd: string, name: string, state: "working" | "idle") =>
      s.corgi([
        "tab",
        "new",
        "--workspace",
        String(workspace),
        "--name",
        name,
        "--cwd",
        cwd,
        "--command",
        `claude --sandbox-name '${name}' --sandbox-state ${state}`,
      ]);
    const web = join(s.dir, "projects/web");
    const made = s.corgi(["workspace", "new", "web", "--cwd", web]);
    agent(made.workspace, web, "Fix login redirect", "working");
    agent(made.workspace, web, "Add search filters", "idle");
    const billing = join(s.dir, "projects/billing");
    const named = s.corgi(["workspace", "new", "Billing team", "--cwd", billing]);
    agent(named.workspace, billing, "Retry failed invoices", "idle");
    s.corgi(["workspace", "new", "docs", "--cwd", join(s.dir, "projects/docs")]);
    for (const w of before)
      if ((w.model?.tabs?.length ?? 0) === 0) s.corgi(["workspace", "close", String(w.id)], false);
  },
  intro(s) {
    return [
      `"web", "Billing team" and "docs" sit in ${join(s.dir, "projects")}, beside web-v2 and billing-next.`,
      ...table([
        ["r-click", "a workspace, then Change folder: ←/→ out and in, type a path, ↵ moves it"],
        ["", '"web" takes its new folder\'s name; "Billing team" keeps its own'],
        ["dbl-click", "a workspace or agent row to rename it in place; ↵ saves, Esc cancels"],
        [`${s.prefixName} W`, "the current workspace's menu: r renames, f changes its folder"],
      ]),
    ];
  },
};
