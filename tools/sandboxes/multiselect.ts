/** A populated agent list for Space toggles, visual ranges and bulk actions. */
import { join } from "node:path";
import { table, type World } from "../sandbox";
import * as rpc from "../../src/rpc";

const tasks = [
  "Fix login redirect",
  "Add search filters",
  "Stream build logs",
  "Review database migration",
  "Update keyboard shortcuts",
  "Audit error handling",
  "Write release notes",
  "Refresh onboarding copy",
  "Clean up test fixtures",
  "Add retry backoff",
  "Improve upload progress",
  "Review access controls",
];

export const world: World = {
  seed(s) {
    for (const folder of ["app", "docs"]) s.write(join(s.dir, folder, "README.md"), `# ${folder}\n`);
    s.write(
      join(s.home, ".claude/.claude.json"),
      JSON.stringify({
        oauthAccount: { emailAddress: "sandbox@example.com", accountUuid: "sandbox" },
        hasCompletedOnboarding: true,
      }),
    );
  },
  async arrange(s) {
    const before: { id: number; model?: { tabs?: unknown[] } }[] = s.corgi(["workspace", "list"])?.workspaces ?? [];
    const app = s.corgi(["workspace", "new", "app", "--cwd", join(s.dir, "app")]);
    const panes = tasks.map(
      (name, i) =>
        s.corgi([
          "tab",
          "new",
          "--workspace",
          String(app.workspace),
          "--name",
          name,
          "--cwd",
          join(s.dir, "app"),
          "--command",
          `claude --sandbox-name '${name}' --sandbox-state ${i < 4 ? "working" : "idle"}`,
        ]).pane as number,
    );
    const connection = new rpc.Connection(s.env.CORGI_SOCKET);
    try {
      const deadline = Date.now() + 15000;
      for (;;) {
        const snapshot = (await connection.call("session.list")).result;
        if (
          panes.every((id, i) => {
            const agent = snapshot.panes.find(p => p.id === id)?.agent;
            return (
              agent?.name === tasks[i] && (i < 4 ? agent.state === "working" : BigInt(agent.observation.completed) > 0n)
            );
          })
        ) {
          for (const id of panes.slice(8)) {
            const p = snapshot.panes.find(p => p.id === id)!;
            await connection.call("pane.acknowledge", {
              pane: id,
              session: p.agent.session,
              through: p.agent.observation.completed,
              attention_at: p.agent.changed_at,
            });
          }
          break;
        }
        if (Date.now() >= deadline) throw Error("SandboxAgentsNotReady");
        await Bun.sleep(100);
      }
    } finally {
      connection.close();
    }
    s.corgi(["tab", "close", String(app.tab)]);
    const docs = s.corgi(["workspace", "new", "docs", "--cwd", join(s.dir, "docs")]);
    s.corgi([
      "tab",
      "new",
      "--workspace",
      String(docs.workspace),
      "--name",
      "Check examples",
      "--cwd",
      join(s.dir, "docs"),
      "--command",
      "codex --sandbox-name 'Check examples' --sandbox-state idle",
    ]);
    for (const ws of before)
      if ((ws.model?.tabs?.length ?? 0) === 0) s.corgi(["workspace", "close", String(ws.id)], false);
  },
  intro(s) {
    return [
      "Twelve fake agents in app, plus docs for trying the All scope.",
      ...table([
        ["[Select]", `click below the agents header, or press ${s.prefixName} a`],
        ["Space", "select / deselect the cursor's agent; arrows or j/k move"],
        ["v", "start a range; move, then v or Enter keeps it; Esc cancels"],
        ["Shift+↑↓", "extend / shrink a range, keeping earlier separate marks"],
        ["Ctrl-click", "toggle and focus one agent, when forwarded by the terminal"],
        ["a / m", "select all shown / open bulk actions (star, unread, close panes)"],
        ["Esc", "clear marks, then return to the pane"],
      ]),
    ];
  },
};
