/** Starred agents in gold: three starred among others at work, waiting and done, sorted by activity. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { table, type World } from "../sandbox";
import * as rpc from "../../src/rpc";

const agents: { name: string; state: "working" | "idle" | "blocked"; seen: boolean; starred: boolean }[] = [
  { name: "Ship release notes", state: "working", seen: true, starred: true },
  { name: "Fix login redirect", state: "idle", seen: false, starred: true },
  { name: "Review database migration", state: "idle", seen: true, starred: true },
  { name: "Update keyboard shortcuts", state: "blocked", seen: true, starred: false },
  { name: "Stream build logs", state: "working", seen: true, starred: false },
  { name: "Cache API responses", state: "idle", seen: false, starred: false },
  { name: "Audit error handling", state: "idle", seen: true, starred: false },
];

export const world: World = {
  configure(s) {
    const prefs = join(s.home, ".local/state/corgi/viewer.json");
    writeFileSync(prefs, JSON.stringify({ ...JSON.parse(readFileSync(prefs, "utf8")), agent_sort: "activity" }));
  },
  seed(s) {
    s.write(join(s.dir, "app", "README.md"), "# app\n\nA workspace for trying starred agents.\n");
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
    s.corgi(["tab", "rename", String(app.tab), "shell"]);
    const panes = agents.map(
      a =>
        s.corgi([
          "tab",
          "new",
          "--workspace",
          String(app.workspace),
          "--name",
          a.name,
          "--cwd",
          join(s.dir, "app"),
          "--command",
          `claude --sandbox-name '${a.name}' --sandbox-state ${a.state === "working" ? "working" : "idle"}`,
        ]).pane as number,
    );
    const connection = new rpc.Connection(s.env.CORGI_SOCKET);
    try {
      const deadline = Date.now() + 15000;
      for (;;) {
        const snapshot = (await connection.call("session.list")).result;
        const ready = panes.every((id, i) => {
          const agent = snapshot.panes.find(p => p.id === id)?.agent;
          return (
            agent?.name === agents[i].name &&
            (agents[i].state === "working" ? agent.state === "working" : BigInt(agent.observation.completed) > 0n)
          );
        });
        if (ready) {
          for (const [i, id] of panes.entries()) {
            if (agents[i].state === "working" || !agents[i].seen) continue;
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
      for (const [i, id] of panes.entries())
        if (agents[i].starred)
          await connection.call("session.command", {
            command: { "agent.pin": { workspace: app.workspace, target: { pane: id }, pinned: true } },
          });
    } finally {
      connection.close();
    }
    for (const [i, id] of panes.entries())
      if (agents[i].state === "blocked") s.corgi(["pane", "keys", String(id), "b", "l", "o", "c", "k", "enter"]);
    for (const ws of before)
      if ((ws.model?.tabs?.length ?? 0) === 0) s.corgi(["workspace", "close", String(ws.id)], false);
  },
  intro(s) {
    return [
      '"app" has three starred agents among others at work, waiting and done, sorted by activity.',
      ...table([
        ["Right-click", "an agent → Star or Unstar."],
        ["Click", "the agents ▾ menu → Manual to see starred rows among the rest."],
        [`${s.prefixName} 1`, "the shell tab, so no agent row is focused."],
      ]),
    ];
  },
};
