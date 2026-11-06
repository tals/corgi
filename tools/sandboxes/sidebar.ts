/**
 * The sidebar sandbox: a crowded sidebar, with more workspaces than fit above
 * the rule and every workspace's agents, waiting, finished and idle, below it.
 *
 * Nine workspaces, each a git repository; web serves a port. Each workspace
 * shows its three rows, readings included.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { table, type Sandbox, type World } from "../sandbox";

const repos = ["api", "web", "docs", "infra", "mobile", "billing", "search", "auth", "design"] as const;
const server = [
  'const server = Bun.serve({ port: 0, fetch: () => new Response("ok from web\\n") });',
  "console.log(`web listening on http://localhost:${server.port}`);",
].join("\n");

/** The fake agents' banner, once they are past signing in. */
const ready = "a fake agent in a Corgi sandbox";

export const world: World = {
  seed(s) {
    for (const name of repos) {
      const repo = join(s.dir, name);
      s.run(["mkdir", "-p", repo]);
      s.git(repo, "init", "-q");
      s.write(join(repo, "README.md"), `# ${name}\n\nPart of the sidebar sandbox.\n`);
      if (name === "web") s.write(join(repo, "serve.ts"), server + "\n");
      s.commit(repo, `${name}: start the sidebar sandbox`);
    }
    // Signed in already, so the agents start at their prompt.
    s.write(
      join(s.home, ".claude/.claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "me@example.com" }, hasCompletedOnboarding: true }),
    );
    const token = Buffer.from(JSON.stringify({ email: "me@example.com", sub: "me@example.com" })).toString("base64url");
    s.write(join(s.home, ".codex/auth.json"), JSON.stringify({ tokens: { id_token: `x.${token}.x` } }));
    // Every workspace's agents, keeping what `prepareHome` wrote.
    const prefs = join(s.home, ".local/state/corgi/viewer.json");
    let saved: Record<string, unknown> = {};
    try {
      saved = JSON.parse(readFileSync(prefs, "utf8"));
    } catch {}
    s.write(prefs, JSON.stringify({ ...saved, agents: "all" }));
  },

  arrange(s) {
    const before: { id: number; model?: { tabs?: unknown[] } }[] = s.corgi(["workspace", "list"])?.workspaces ?? [];
    const made = new Map<string, { workspace: number; tab: number }>();
    for (const name of repos) {
      const opened: { workspace: number; tab: number } = s.corgi([
        "workspace",
        "new",
        name,
        "--cwd",
        join(s.dir, name),
      ]);
      s.corgi(["tab", "rename", String(opened.tab), "shell"]);
      made.set(name, opened);
    }
    const tab = (repo: string, name: string, command: string): { pane: number; tab: number } =>
      s.corgi([
        "tab",
        "new",
        "--workspace",
        String(made.get(repo)!.workspace),
        "--name",
        name,
        "--cwd",
        join(s.dir, repo),
        "--command",
        command,
      ]);
    tab("web", "server", "bun serve.ts");
    const agents: [{ pane: number }, string | null][] = [
      [tab("api", "planner", "claude"), "stop"],
      [tab("api", "reviewer", "codex"), "block"],
      [tab("web", "frontend", "claude"), "stop"],
      [tab("docs", "writer", "codex"), null],
      [tab("infra", "ops", "claude"), null],
      [tab("mobile", "ios", "claude"), "stop"],
      [tab("billing", "invoices", "codex"), "stop"],
      [tab("search", "ranker", "claude"), null],
      [tab("auth", "sessions", "codex"), "block"],
    ];
    const ours = new Set([...made.values()].map(m => m.workspace));
    for (const w of before)
      if (!ours.has(w.id) && (w.model?.tabs?.length ?? 0) === 0) s.corgi(["workspace", "close", String(w.id)], false);
    // Each agent takes its word once it is at its prompt, typed: `pane send`
    // pastes, which the fakes read as review notes.
    for (const [{ pane }, word] of agents) {
      if (word === null) continue;
      if (!waitFor(s, pane)) {
        console.error(`corgi: the agent in pane ${pane} did not start; type ${word} there yourself`);
        continue;
      }
      s.run([s.exe, "pane", "keys", String(pane), ...word, "enter"]);
    }
  },

  intro(s) {
    return [
      "Nine workspaces above the rule, more than fit, and nine agents below it.",
      ...table([
        ["scroll", "the workspace list: its cut end trails off into the rule while more lie below"],
        ["drag", "the rule up or down to cut the list at another row"],
        [`${s.prefixName} w`, "focus the workspace list; ↑ ↓ move through it"],
      ]),
    ];
  },
};

/** Whether the agent in `pane` reached its prompt within a few seconds. */
function waitFor(s: Sandbox, pane: number): boolean {
  for (let tries = 0; tries < 50; tries++) {
    if (s.run([s.exe, "pane", "read", String(pane), "--lines", "20"], s.dir, undefined, false).includes(ready))
      return true;
    Bun.sleepSync(100);
  }
  return false;
}
