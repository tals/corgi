/** Workspace auto-order with short thresholds: busy workspaces on top, quiet ones sinking and fading. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { table, type World } from "../sandbox";

/** Each workspace, and what its agent or program does. */
const workspaces: { name: string; agent: string; does: "work" | "stop" | "block" | "serve" }[] = [
  { name: "api", agent: "Stream build logs", does: "work" },
  { name: "web", agent: "Fix login redirect", does: "work" },
  { name: "billing", agent: "Retry failed invoices", does: "stop" },
  { name: "docs", agent: "Update the setup guide", does: "stop" },
  { name: "mobile", agent: "Cache API responses", does: "stop" },
  { name: "site", agent: "dev server", does: "serve" },
  { name: "infra", agent: "Rotate deploy keys", does: "block" },
];

export const world: World = {
  configure(s) {
    // Short thresholds, kept once setup changes them.
    const file = join(s.env.CORGI_ENV_DIR, "state/corgi/settings.json");
    const saved = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    if (saved.workspace_auto_order !== undefined) return;
    s.write(
      file,
      JSON.stringify({
        ...saved,
        workspace_auto_order: true,
        workspace_pause_after: 1,
        workspace_stale_after: 3,
        workspace_archive_after: 60,
      }),
    );
  },
  seed(s) {
    for (const w of workspaces)
      s.write(join(s.dir, w.name, "README.md"), `# ${w.name}\n\nA workspace for auto-order.\n`);
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
    const quiet: number[] = [];
    for (const w of workspaces) {
      const cwd = join(s.dir, w.name),
        made = s.corgi(["workspace", "new", w.name, "--cwd", cwd]),
        command =
          w.does === "serve"
            ? "sleep 86400"
            : `claude --sandbox-name '${w.agent}' --sandbox-state ${w.does === "block" ? "idle" : "working"}`;
      const pane = s.corgi([
        "tab",
        "new",
        "--workspace",
        String(made.workspace),
        "--name",
        w.agent,
        "--cwd",
        cwd,
        "--command",
        command,
      ]).pane as number;
      if (w.does === "stop") quiet.push(pane);
      if (w.does === "block") {
        // Working at first, then stuck on a permission prompt.
        s.corgi(["pane", "keys", String(pane), "w", "o", "r", "k", "enter"]);
        s.corgi(["pane", "keys", String(pane), "b", "l", "o", "c", "k", "enter"]);
      }
    }
    // The quiet ones stop one a minute apart, so they go stale in turn.
    // Keys from the CLI aren't typing, so they don't wake their workspaces.
    const script = quiet.map(pane => `sleep 60; "${s.exe}" pane keys ${pane} s t o p enter`).join("; ");
    Bun.spawn(["sh", "-c", script], { cwd: s.dir, env: s.env, stdio: ["ignore", "ignore", "ignore"] }).unref();
    for (const ws of before)
      if ((ws.model?.tabs?.length ?? 0) === 0) s.corgi(["workspace", "close", String(ws.id)], false);
  },
  intro(s) {
    return [
      "Auto-order is on: pause after 1 min, stale after 3 min, archive after 1 h.",
      '"api" and "web" keep working; "billing", "docs" and "mobile" go quiet a minute apart;',
      '"site" runs a program and "infra" waits on a permission prompt, so neither is archived.',
      ...table([
        ["watch", "after 3 min the quiet ones sink below and fade, the earliest lowest"],
        ["type", "in a stale workspace's pane: it rejoins the end of the active group"],
        ["drag", "a stale workspace, or one below the first stale row: it snaps back"],
        ["setup", "Corgi setup → Workspace order switches it and changes the thresholds"],
      ]),
    ];
  },
};
