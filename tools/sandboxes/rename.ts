/**
 * The inline rename's sandbox: a crowded sidebar where every corner case of
 * the name-line sizing is one double-click away.
 *
 * - web: a plain folder with a web server, so its row carries a port link.
 * - notes: nothing on its name line, under web's link.
 * - Billing team: two commits ahead of its upstream with uncommitted
 *   changes, and six agents, one unread, one starred, one at 87% context.
 * - Design system refresh for the mobile app: ahead, uncommitted, and a
 *   server, so its name line carries both the link and the Git figure.
 * - 日本語版: a wide-character name, under the crowded row above.
 * - Prototype: archived, under "▸ 1 archived".
 */
import { join } from "node:path";
import { table, type Sandbox, type World } from "../sandbox";
import * as rpc from "../../src/rpc";

const agents: { name: string; context?: number; starred?: boolean; read?: boolean }[] = [
  { name: "Fix login redirect", read: true },
  { name: "Docs", read: true },
  { name: "Cache API responses", context: 87, read: true },
  { name: "Refactor the onboarding flow for the mobile application", read: true },
  { name: "日本語の修正" },
  { name: "Ship release notes", starred: true, read: true },
];

function paths(s: Sandbox) {
  const repos = join(s.dir, "repos");
  return {
    repos,
    billing: join(repos, "billing"),
    billing_origin: join(repos, "billing-origin.git"),
    design: join(repos, "design"),
    design_origin: join(repos, "design-origin.git"),
  };
}

const server = (reply: string) =>
  `const server = Bun.serve({ port: 0, fetch: () => new Response("${reply}") }); console.log("Serving http://localhost:" + server.port);`;

const billing_source = [
  "/** Invoice totals, kept per period. */",
  "export interface Invoice {",
  "  id: string;",
  "  period: string;",
  "  amount: number;",
  "}",
  "",
  "export function total(invoices: Invoice[]): number {",
  "  return invoices.reduce((sum, invoice) => sum + invoice.amount, 0);",
  "}",
  "",
  "export function byPeriod(invoices: Invoice[], period: string): Invoice[] {",
  "  return invoices.filter(invoice => invoice.period === period);",
  "}",
  "",
].join("\n");

const design_source = [
  "/** The design tokens the app's rows and cards share. */",
  "export const spacing = [0, 4, 8, 12, 16, 24];",
  "",
  "export function pad(cells: number): number {",
  "  return spacing[Math.min(spacing.length - 1, Math.ceil(cells / 8))];",
  "}",
  "",
].join("\n");

export const world: World = {
  seed(s) {
    const { repos, billing, billing_origin, design, design_origin } = paths(s);
    for (const folder of ["web", "notes", "nihongo", "prototype"])
      s.write(join(s.dir, folder, "README.md"), `# ${folder}\n\nA folder for trying the inline rename.\n`);
    s.write(join(s.dir, "web", "server.ts"), server("web"));
    s.write(
      join(s.home, ".claude/.claude.json"),
      JSON.stringify({
        oauthAccount: { emailAddress: "sandbox@example.com", accountUuid: "sandbox" },
        hasCompletedOnboarding: true,
      }),
    );
    s.run(["mkdir", "-p", repos]);
    // Billing team: a checkout with two commits to push and work underway.
    s.run(["git", "init", "-q", "--bare", "-b", "main", billing_origin], repos);
    s.run(["git", "clone", "-q", billing_origin, billing], repos);
    s.write(join(billing, "README.md"), "# billing\n\nA checkout with invoices underway.\n");
    s.write(join(billing, "src", "billing.ts"), billing_source);
    s.dated(60 * 26);
    s.commit(billing, "billing: snapshot for the rename sandbox");
    s.git(billing, "push", "-q", "-u", "origin", "main");
    s.git(billing, "remote", "set-head", "origin", "main");
    s.dated(180);
    s.edit(
      join(billing, "src", "billing.ts"),
      "  return invoices.reduce((sum, invoice) => sum + invoice.amount, 0);",
      "  return Math.round(invoices.reduce((sum, invoice) => sum + invoice.amount, 0) * 100) / 100;",
    );
    s.commit(billing, "billing: round invoice totals to cents");
    s.dated(90);
    s.edit(join(billing, "src", "billing.ts"), "  amount: number;", "  amount: number;\n  currency: string;");
    s.commit(billing, "billing: carry each invoice's currency");
    // Left uncommitted, for the Git figure and the review panel's notes.
    s.edit(
      join(billing, "src", "billing.ts"),
      "  return invoices.filter(invoice => invoice.period === period);",
      "  return invoices.filter(invoice => invoice.period === period).sort((a, b) => (a.id < b.id ? -1 : 1));",
    );
    // Design: three commits to push, work underway, and its own web server.
    s.run(["git", "init", "-q", "--bare", "-b", "main", design_origin], repos);
    s.run(["git", "clone", "-q", design_origin, design], repos);
    s.write(join(design, "README.md"), "# design\n\nA checkout with the design system underway.\n");
    s.write(join(design, "src", "design.ts"), design_source);
    s.write(join(design, "server.ts"), server("design"));
    s.dated(60 * 26);
    s.commit(design, "design: snapshot for the rename sandbox");
    s.git(design, "push", "-q", "-u", "origin", "main");
    s.git(design, "remote", "set-head", "origin", "main");
    s.dated(150);
    s.edit(
      join(design, "src", "design.ts"),
      "export const spacing = [0, 4, 8, 12, 16, 24];",
      "export const spacing = [0, 4, 8, 12, 16, 24, 32];",
    );
    s.commit(design, "design: add a 32-cell step");
    s.dated(100);
    s.edit(
      join(design, "src", "design.ts"),
      "  return spacing[Math.min(spacing.length - 1, Math.ceil(cells / 8))];",
      "  return spacing[Math.min(spacing.length - 1, Math.ceil(cells / 4))];",
    );
    s.commit(design, "design: step the padding every four cells");
    s.dated(45);
    s.edit(
      join(design, "src", "design.ts"),
      "export function pad(cells: number): number {",
      "export const radius = 6;\n\nexport function pad(cells: number): number {",
    );
    s.commit(design, "design: round the cards' corners");
    s.edit(join(design, "src", "design.ts"), "export const radius = 6;", "export const radius = 8;");
  },

  /** The six workspaces in sidebar order, the agents in Billing team, and both servers. */
  async arrange(s) {
    const { billing, design } = paths(s);
    const before: { id: number; model?: { tabs?: unknown[] } }[] = s.corgi(["workspace", "list"])?.workspaces ?? [];
    const shell = (name: string, cwd: string) => {
      const made: { workspace: number; tab: number; pane: number } = s.corgi(["workspace", "new", name, "--cwd", cwd]);
      s.corgi(["tab", "rename", String(made.tab), "shell"]);
      return made;
    };
    const web = shell("web", join(s.dir, "web"));
    shell("notes", join(s.dir, "notes"));
    const team = shell("Billing team", billing);
    const crowded = shell("Design system refresh for the mobile app", design);
    shell("日本語版", join(s.dir, "nihongo"));
    const prototype = shell("Prototype", join(s.dir, "prototype"));
    const panes = agents.map(
      a =>
        s.corgi([
          "tab",
          "new",
          "--workspace",
          String(team.workspace),
          "--name",
          a.name,
          "--cwd",
          billing,
          "--command",
          `claude --sandbox-name '${a.name}' --sandbox-state idle${a.context ? ` --sandbox-context ${a.context}` : ""}`,
        ]).pane as number,
    );
    const connection = new rpc.Connection(s.env.CORGI_SOCKET);
    try {
      const deadline = Date.now() + 30000;
      for (;;) {
        const snapshot = (await connection.call("session.list")).result;
        const pane = (id: number) => snapshot.panes.find((p: any) => p.id === id);
        const agentsReady = panes.every((id, i) => {
          const agent = pane(id)?.agent;
          return agent?.name === agents[i].name && agent && BigInt(agent.observation.completed) > 0n;
        });
        // The context figure: one assistant record the fake Claude wrote,
        // 87% of the 1M window claude-opus-5-5 resolves to.
        const figure = pane(panes[2])?.agent;
        const reading = figure && snapshot.conversations.find((a: any) => a.id === figure.conversation)?.context;
        const contextReady =
          reading !== undefined && BigInt(reading.used ?? 0) === 870000n && BigInt(reading.window ?? 0) === 1000000n;
        // The snapshot's cwd is a realpath (/private/tmp on macOS), so the
        // workspaces are told apart by their ids, not their folders.
        const ahead = (workspace: number) => {
          const ws = snapshot.workspaces.find((w: any) => w.id === workspace);
          return ws?.git_ahead === null || ws?.git_ahead === undefined ? null : BigInt(ws.git_ahead);
        };
        const gitReady =
          ahead(team.workspace) === 2n && ahead(crowded.workspace) === 3n && ahead(web.workspace) === null;
        if (agentsReady && contextReady && gitReady) {
          for (const [i, id] of panes.entries()) {
            if (!agents[i].read) continue;
            const p = pane(id)!;
            await connection.call("pane.acknowledge", {
              pane: id,
              session: p.agent.session,
              through: p.agent.observation.completed,
              attention_at: p.agent.changed_at,
            });
          }
          for (const [i, id] of panes.entries())
            if (agents[i].starred)
              await connection.call("session.command", {
                command: { "agent.pin": { workspace: team.workspace, target: { pane: id }, pinned: true } },
              });
          break;
        }
        if (Date.now() >= deadline) throw Error("SandboxRenameNotReady");
        await Bun.sleep(100);
      }
    } finally {
      connection.close();
    }
    // The port links: a web server in each linked workspace's shell.
    s.corgi(["pane", "send", String(web.pane), `bun '${join(s.dir, "web", "server.ts")}'`, "--enter"]);
    s.corgi(["pane", "send", String(crowded.pane), `bun '${join(design, "server.ts")}'`, "--enter"]);
    s.corgi(["workspace", "archive", String(prototype.workspace)]);
    for (const w of before)
      if ((w.model?.tabs?.length ?? 0) === 0) s.corgi(["workspace", "close", String(w.id)], false);
  },

  intro(s) {
    return [
      'The crowded rows of the inline rename: "web" carries a link; "notes" (nothing on its line) sits under it; "Billing team" is two ahead with uncommitted changes and six agents; "Design system refresh for the mobile app" carries both link and Git figure; 日本語版 is a wide name under it; "Prototype" is archived.',
      ...table([
        ["dbl-click", "any name: the field opens with the name selected"],
        ["type", "replaces it; Right keeps it; a press inside the field places the caret"],
        ["↵ / Esc", "save or cancel"],
        [`${s.prefixName} e`, 'the review panel on an agent in "Billing team": v selects lines, c writes a note'],
        ["", 'there; two unsent notes read "2 notes" on its row'],
        ["▸ 1 archived", "at the list's bottom: open it, then double-click its name too"],
        ["drag", "the sidebar's edge narrow and wide, to stress the field's cap"],
      ]),
    ];
  },
};
