/** Working and idle agents, split shells and a server to review before archiving. */
import { join } from "node:path";
import { table, type World } from "../sandbox";
import * as rpc from "../../src/rpc";

const tasks = [
  "Fix login redirect",
  "Add search filters",
  "Stream build logs",
  "Cache API responses",
  "Review database migration",
  "Update keyboard shortcuts",
  "Audit error handling",
  "Write release notes",
  "Refresh onboarding copy",
  "Clean up test fixtures",
  "Add retry backoff",
  "Improve upload progress",
  "Review access controls",
  "Validate webhook signatures",
  "Update API documentation",
  "Check database indexes",
  "Review dependency updates",
  "Verify session expiry",
  "Test offline behavior",
  "Review mobile layouts",
  "Check export formatting",
  "Audit accessibility",
  "Simplify settings forms",
  "Refresh empty states",
  "Document environment setup",
  "Clean up feature flags",
  "Organize integration tests",
  "Update error messages",
  "Polish command help",
  "Remove unused assets",
  "Review logging levels",
  "Prepare deployment notes",
];
const running = 12,
  unread = 10;

export const world: World = {
  seed(s) {
    for (const folder of ["app", "notes"])
      s.write(join(s.dir, folder, "README.md"), `# ${folder}\n\nA workspace for trying hibernation.\n`);
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
    s.corgi(["tab", "rename", String(app.tab), "Split shells"]);
    s.corgi(["pane", "split", String(app.pane), "--right"]);
    const panes: number[] = [];
    for (const [i, name] of tasks.entries()) {
      const agent = s.corgi([
        "tab",
        "new",
        "--workspace",
        String(app.workspace),
        "--name",
        name,
        "--cwd",
        join(s.dir, "app"),
        "--command",
        `claude --sandbox-name '${name}' --sandbox-state ${i < running ? "working" : "idle"}`,
      ]);
      panes.push(agent.pane);
    }
    const connection = new rpc.Connection(s.env.CORGI_SOCKET);
    try {
      const deadline = Date.now() + 15000;
      for (;;) {
        const snapshot = (await connection.call("session.list")).result;
        const ready = panes.every((id, i) => {
          const agent = snapshot.panes.find(p => p.id === id)?.agent;
          return (
            agent?.name === tasks[i] &&
            (i < running ? agent.state === "working" : BigInt(agent.observation.completed) > 0n)
          );
        });
        if (ready) {
          for (const id of panes.slice(running + unread)) {
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
    const server = join(s.dir, "app", "server.ts");
    s.write(
      server,
      'const server = Bun.serve({ port: 0, fetch: () => new Response("Hibernation sandbox") }); console.log("Serving http://localhost:" + server.port);',
    );
    s.corgi(["pane", "type", String(app.pane), `bun '${server}'`, "--enter"]);
    s.corgi(["workspace", "new", "notes", "--cwd", join(s.dir, "notes")]);
    for (const ws of before)
      if ((ws.model?.tabs?.length ?? 0) === 0) s.corgi(["workspace", "close", String(ws.id)], false);
  },
  intro(s) {
    return [
      '"app" has 32 named agents (12 running, 10 unread, 10 idle), split shells and a web server.',
      ...table([
        ["CLI", "corgi pane hibernate ID; it stays selected and asleep."],
        ["", "Select another pane and return, or run corgi pane wake ID."],
        ["", "A known session resumes; a fresh agent restarts its launch; other panes become shells."],
        ["Right-click", "app → Archive workspace. ↑↓ previews an agent; Enter or a click opens it."],
        ["a", "press again in the review to archive the workspace."],
        ["Tab", "choose Cancel or Archive workspace in the review."],
        [`${s.prefixName} w`, "choose an archived workspace; only its selected pane wakes."],
        ["work", "type this in the fake agent, then hibernate it while it is busy."],
      ]),
    ];
  },
};
