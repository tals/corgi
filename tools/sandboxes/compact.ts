/** The compact sidebar: six workspaces, one without agents, and twenty agents that are working, idle or blocked. */
import { join } from "node:path";
import { table, type World } from "../sandbox";
import * as rpc from "../../src/rpc";

type State = "working" | "idle" | "blocked";
const workspaces: { name: string; agents: [string, State][] }[] = [
  {
    name: "dev",
    agents: [
      ["quick", "idle"],
      ["claude_cleanup", "working"],
      ["ornl", "idle"],
      ["nvrx_ecc", "idle"],
      ["ssl", "working"],
    ],
  },
  { name: "accuracy", agents: [["review", "idle"]] },
  {
    name: "code-review",
    agents: [
      ["grace", "idle"],
      ["docs", "blocked"],
      ["mayuri", "idle"],
      ["alex", "working"],
    ],
  },
  {
    name: "migration",
    agents: [
      ["migration", "working"],
      ["docs", "idle"],
      ["review", "blocked"],
      ["multi-agent", "idle"],
      ["simple", "idle"],
    ],
  },
  {
    name: "triage",
    agents: [
      ["sync", "blocked"],
      ["gcp-iad", "idle"],
      ["glean", "working"],
      ["oci-iad", "idle"],
      ["jira", "idle"],
    ],
  },
  { name: "notes", agents: [] },
];

export const world: World = {
  configure(s) {
    s.settings({ compact_sidebar: true });
  },
  seed(s) {
    for (const ws of workspaces) s.write(join(s.dir, ws.name, "README.md"), `# ${ws.name}\n`);
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
    const panes: { id: number; state: State }[] = [];
    for (const ws of workspaces) {
      const cwd = join(s.dir, ws.name);
      const made = s.corgi(["workspace", "new", ws.name, "--cwd", cwd]);
      for (const [name, state] of ws.agents) {
        const command = `claude --sandbox-name '${name}' --sandbox-state ${state === "working" ? "working" : "idle"}`;
        const tab = s.corgi([
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
        panes.push({ id: tab.pane as number, state });
      }
    }
    // A blocked agent asks once it has finished its first turn.
    const connection = new rpc.Connection(s.env.CORGI_SOCKET);
    try {
      const deadline = Date.now() + 15000;
      for (;;) {
        const snapshot = (await connection.call("session.list")).result;
        const ready = panes
          .filter(p => p.state === "blocked")
          .every(p => BigInt(snapshot.panes.find(q => q.id === p.id)?.agent?.observation.completed ?? 0) > 0n);
        if (ready) break;
        if (Date.now() >= deadline) throw Error("SandboxAgentsNotReady");
        await Bun.sleep(100);
      }
    } finally {
      connection.close();
    }
    for (const p of panes)
      if (p.state === "blocked") s.corgi(["pane", "keys", String(p.id), "b", "l", "o", "c", "k", "enter"]);
    for (const ws of before)
      if ((ws.model?.tabs?.length ?? 0) === 0) s.corgi(["workspace", "close", String(ws.id)], false);
  },
  intro() {
    return [
      'Six workspaces in one tree, each agent on one line; "notes" has no agents.',
      ...table([
        ["Click", "a workspace's name to switch to it, or its ▾ to fold it."],
        ["Setup", "Corgi setup → Compact sidebar turns it off and on."],
        ["CLI", "corgi action compact-sidebar toggles it."],
      ]),
    ];
  },
};
