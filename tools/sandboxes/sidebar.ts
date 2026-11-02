/**
 * The sidebar sandbox: enough workspaces and agents to judge the workspace
 * tint on Visual flourishes, and the hover on workspace rows.
 *
 * - api: a Claude agent working and a Codex agent waiting for input.
 * - web: a small server listening on a port, and a Claude agent that finished.
 * - docs: an idle Codex agent.
 * - infra: an idle Claude agent.
 *
 * The readings row is on, so each workspace shows its three rows.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { table, type Sandbox, type World } from "../sandbox";

const repos = ["api", "web", "docs", "infra"] as const;
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
    // The readings row on, keeping what `prepareHome` wrote.
    const prefs = join(s.home, ".local/state/corgi/viewer.json");
    let saved: Record<string, unknown> = {};
    try {
      saved = JSON.parse(readFileSync(prefs, "utf8"));
    } catch {}
    s.write(prefs, JSON.stringify({ ...saved, resources: { enabled: true } }));
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
      [tab("api", "planner", "claude"), "work"],
      [tab("api", "reviewer", "codex"), "block"],
      [tab("web", "frontend", "claude"), "stop"],
      [tab("docs", "writer", "codex"), null],
      [tab("infra", "ops", "claude"), null],
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
      "Four workspaces above the rule and five agents below: working, waiting, finished and idle.",
      ...table([
        [`${s.prefixName} i`, "setup: Visual flourishes, then ↓ to Workspace tint"],
        ["← →", "steps the tint by 5; Home is Off, End is the strongest"],
        ["drag", "the bar: the sidebar follows before you let go"],
        ["hover", "a workspace: it sits between the section and the active row"],
        ["End", "then compare the active workspace with a hovered one"],
        ["light", "a terminal profile with a light background darkens the section instead"],
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
