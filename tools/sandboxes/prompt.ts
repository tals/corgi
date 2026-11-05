/**
 * The Corgi prompt's sandbox: a repository with a day of commits, a week of
 * Claude conversations about it, and a headless `claude` that answers two
 * questions for real: it searches those conversations with `corgi grep`, and
 * lists today's commits with links the prompt can preview and review.
 */
import { mkdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { table, type Sandbox, type World } from "../sandbox";

function paths(s: Sandbox) {
  const repos = join(s.dir, "repos");
  return { repos, app: join(repos, "app") };
}

const sidebar = `import * as palette from "./palette";
import type { Writer } from "./writer";

/** Draws the agent rows from \`top\`, two rows each. */
export function drawRows(w: Writer, rows: Row[], top: number, width: number) {
  let y = top;
  for (const row of rows) {
    for (let line = 0; line < 2; line++) {
      w.write(\`\\x1b[\${y + line + 1};1H\\x1b[2K\`);
      w.write(palette.row(row.state) + label(row, line).padEnd(width));
    }
    y += 2;
  }
}

export type Row = { name: string; state: "idle" | "working" | "done"; activity: string };

function label(row: Row, line: number): string {
  return line === 0 ? row.name : "  " + row.activity;
}
`;

const launcher = `import { readPrefs, writePrefs } from "./prefs";

export type Account = { provider: string; name: string };

/** The account a new agent starts on. */
export function defaultAccount(accounts: Account[]): Account | null {
  return accounts[0] ?? null;
}
`;

const tabs = `/** The tab bar redraws as the terminal resizes. */
export function onResize(bar: { draw(): void }, events: { cols: number }[]) {
  for (const _ of events) bar.draw();
}
`;

/** A Claude conversation in \`cwd\`: alternating user and assistant turns, its
 * AI title, and timestamps \`hours\` ago, a few minutes apart. */
function transcript(s: Sandbox, cwd: string, id: string, title: string, hours: number, turns: string[]) {
  const start = Date.now() - hours * 3_600_000,
    at = (i: number) => new Date(start + i * 4 * 60_000).toISOString(),
    lines = turns.map((text, i) =>
      JSON.stringify(
        i % 2 === 0
          ? {
              type: "user",
              cwd,
              sessionId: id,
              gitBranch: "main",
              timestamp: at(i),
              message: { role: "user", content: text },
            }
          : {
              type: "assistant",
              cwd,
              sessionId: id,
              timestamp: at(i),
              message: { role: "assistant", content: [{ type: "text", text }] },
            },
      ),
    );
  lines.push(JSON.stringify({ type: "ai-title", sessionId: id, aiTitle: title }));
  const file = join(s.home, ".claude/projects", cwd.replace(/[/.]/g, "-"), `${id}.jsonl`);
  s.write(file, lines.join("\n") + "\n");
  const last = new Date(start + (turns.length - 1) * 4 * 60_000);
  utimesSync(file, last, last);
}

export const world: World = {
  seed(s) {
    const { app } = paths(s);
    mkdirSync(app, { recursive: true });
    s.git(app, "init", "-q", "-b", "main");
    s.write(join(app, "src/sidebar.ts"), sidebar);
    s.write(join(app, "src/launcher.ts"), launcher);
    s.write(join(app, "src/tabs.ts"), tabs);
    s.write(join(app, "README.md"), "# app\n\nAgents, side by side.\n");
    s.dated(60 * 26);
    s.commit(app, "app: snapshot for the prompt sandbox");
    const base = s.git(app, "rev-parse", "--short", "HEAD").trim();

    s.dated(60 * 5);
    s.edit(
      join(app, "src/sidebar.ts"),
      `      w.write(\`\\x1b[\${y + line + 1};1H\\x1b[2K\`);
      w.write(palette.row(row.state) + label(row, line).padEnd(width));`,
      `      // One write per row: clearing first let a frame show a blank row.
      w.write(\`\\x1b[\${y + line + 1};1H\` + palette.row(row.state) + label(row, line).padEnd(width));`,
    );
    s.commit(app, "sidebar: write each agent row in one go");
    s.dated(60 * 3);
    s.edit(
      join(app, "src/launcher.ts"),
      `export function defaultAccount(accounts: Account[]): Account | null {
  return accounts[0] ?? null;
}`,
      `export function defaultAccount(accounts: Account[]): Account | null {
  const last = readPrefs().last_account;
  return accounts.find(a => a.name === last) ?? accounts[0] ?? null;
}

/** Remembers the account picked, for the next launch. */
export function picked(account: Account) {
  writePrefs({ last_account: account.name });
}`,
    );
    s.commit(app, "launcher: start on the account picked last");
    s.dated(60 * 2);
    s.edit(
      join(app, "src/tabs.ts"),
      `export function onResize(bar: { draw(): void }, events: { cols: number }[]) {
  for (const _ of events) bar.draw();
}`,
      `export function onResize(bar: { draw(): void }, events: { cols: number }[]) {
  // A drag sends a burst of sizes; only the last one shows.
  if (events.length) bar.draw();
}`,
    );
    s.commit(app, "tabs: redraw the tab bar once per resize");
    s.dated(40);
    s.edit(
      join(app, "src/sidebar.ts"),
      `export function drawRows(w: Writer, rows: Row[], top: number, width: number) {
  let y = top;`,
      `export function drawRows(w: Writer, rows: Row[], top: number, width: number, scroll = 0) {
  // Folding a group keeps the rows above it where they were.
  let y = top - scroll;`,
    );
    s.commit(app, "sidebar: keep the scroll position when a group folds");
    s.dated(null);
    const log = s
      .git(app, "log", "--format=%h %s", `${base}..HEAD`)
      .trim()
      .split("\n")
      .map(line => line.split(" ")[0])
      .reverse();
    const [flicker, account, resize, scroll] = log;

    // A week of conversations, three of them about a flicker.
    transcript(s, app, "4f1c2a90-6d1e-4b7a-9a52-3c1d8e2f7a01", "Fix sidebar flicker when tabs move", 30, [
      "The sidebar flickers when I drag a tab to another workspace. Rows blank out for a frame.",
      "Each row is cleared and then written in a second write, so a frame can land between them and show the row blank. Writing the row in one go fixes the flicker.",
      "Nice, the flicker is gone. Commit it.",
      "Committed as sidebar: write each agent row in one go.",
    ]);
    transcript(s, app, "8a2e7c13-0b9f-4d61-8e3a-5f7b2c9d1e02", "Tab bar flickers on resize", 52, [
      "Dragging the window edge makes the tab bar flicker in Ghostty.",
      "A drag sends a burst of resize events and the bar redraws for each one. Drawing once per burst stops the flicker.",
    ]);
    transcript(s, app, "c3d9b5e2-7a41-4f08-b6c2-9e1a4d7f3b03", "Sidebar scroll jumps after folding a group", 3, [
      "Folding a group in the sidebar jumps the scroll back to the top. It's not the flicker from before.",
      "Right, this one is the scroll offset: drawRows starts from the top every time. Passing the scroll position through keeps the rows above the fold in place.",
    ]);
    transcript(s, app, "1b7f4e28-93c5-4a2d-8f61-2d5c9b8a4e04", "Start new agents on the last account", 6, [
      "The launcher always starts agents on my first account. Can it remember the one I picked?",
      "It can save the account in the preferences when you pick one and start there next time.",
    ]);
    transcript(s, app, "e6a8d3f1-2c7b-4e95-a1d4-7b3f6c2e9a05", "Draft the 1.4 release notes", 80, [
      "Draft release notes for 1.4 from the merged PRs.",
      "Here's a first pass grouped by area: sidebar, launcher, tabs and docs.",
    ]);
    transcript(s, app, "5d2b9f7a-4e1c-4a83-9b26-8c4e1f5a7d06", "Debug the flaky launcher test", 120, [
      "launcher.test.ts times out about one run in ten on CI.",
      "It waits on a fixed sleep for the daemon socket; waiting for the socket itself makes it reliable.",
    ]);

    // Signed in, so the prompt offers Claude.
    s.write(
      join(s.home, ".claude/.claude.json"),
      JSON.stringify({
        oauthAccount: { emailAddress: "you@example.com", accountUuid: "you@example.com" },
        hasCompletedOnboarding: true,
      }),
    );
    s.write(
      join(s.home, "prompt-replies.json"),
      JSON.stringify(
        [
          {
            when: "flicker|talk(ed)? about|conversations?",
            example: "what did we say about the flicker?",
            steps: [
              { run: `corgi grep --workspace '${app}' --max-age 7d -i 'flicker'` },
              {
                say: [
                  "Three conversations this week:",
                  "",
                  "- **Fix sidebar flicker when tabs move**: rows were cleared and written in two writes, so a frame could show one blank. Fixed by writing each row in one go.",
                  "- **Tab bar flickers on resize**: the bar redrew for every resize event in a drag; now it draws once per burst.",
                  "- **Sidebar scroll jumps after folding a group**: not the same bug. That one was the scroll offset.",
                ].join("\n"),
              },
            ],
          },
          {
            when: "commit|landed|today|changed",
            example: "what landed today?",
            steps: [
              { run: "git log --oneline -4" },
              {
                say: [
                  "Four commits on main today:",
                  "",
                  `- [Write each sidebar row in one go](${flicker}@.): the flicker fix`,
                  `- [Start on the account picked last](${account}@.)`,
                  `- [Redraw the tab bar once per resize](${resize}@.)`,
                  `- [Keep the scroll position when a group folds](${scroll}@.)`,
                  "",
                  `${flicker} and ${scroll} both change \`src/sidebar.ts\`. [All of today](${base}..main@.) reads as one diff.`,
                ].join("\n"),
              },
            ],
          },
        ],
        null,
        2,
      ),
    );
  },
  arrange(s) {
    const { app } = paths(s);
    const before: { id: number; model?: { tabs?: unknown[] } }[] = s.corgi(["workspace", "list"])?.workspaces ?? [];
    const made: { workspace: number; tab: number } = s.corgi(["workspace", "new", "app", "--cwd", app]);
    s.corgi(["tab", "rename", String(made.tab), "shell"]);
    s.corgi([
      "tab",
      "new",
      "--workspace",
      String(made.workspace),
      "--name",
      "Sidebar scroll",
      "--cwd",
      app,
      "--command",
      "claude",
    ]);
    for (const w of before)
      if (w.id !== made.workspace && (w.model?.tabs?.length ?? 0) === 0) s.corgi(["workspace", "close", String(w.id)]);
  },
  intro(s) {
    return [
      "A repository with four commits today, a week of Claude conversations, and a headless",
      "Claude that knows two questions.",
      ...table([
        [`${s.prefixName} Space`, "open the Corgi prompt"],
        ["", "ask “what did we say about the flicker?”: a live conversation search"],
        ["", "ask “what landed today?”: commit links; hover one, click to review"],
        ["/", "commands; @ adds context; Ctrl+O moves the chat to a pane"],
      ]),
    ];
  },
};
