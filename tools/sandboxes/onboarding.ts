/**
 * First-run import against a private tmux server with two sessions. Herdr and
 * cmux have nothing here, so onboarding leaves them out; with tmux stopped too,
 * it skips the import step.
 */
import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { table, type Sandbox, type World } from "../sandbox";

/** tmux's socket directory: apart from your own tmux, and short enough for a socket path. */
const tmuxDir = (s: Sandbox) => `/tmp/corgi-onboarding-${createHash("sha256").update(s.dir).digest("hex").slice(0, 8)}`;
/** The world's server, where tmux in its panes finds it. Each command names it: shutdown runs before configure. */
const socketDir = (s: Sandbox) => join(tmuxDir(s), `tmux-${process.getuid?.() ?? 0}`);
const tmux = (s: Sandbox, ...args: string[]) => s.run(["tmux", "-S", join(socketDir(s), "default"), ...args]);

function running(s: Sandbox): boolean {
  try {
    tmux(s, "has-session");
    return true;
  } catch {
    return false;
  }
}

export const world: World = {
  configure(s) {
    mkdirSync(socketDir(s), { recursive: true, mode: 0o700 });
    s.env.TMUX_TMPDIR = tmuxDir(s);
    // The cmux app, if installed, answers on its own socket; this world's has nothing.
    s.env.CMUX_SOCKET_PATH = join(s.dir, "run", "cmux.sock");
    if (!Bun.which("tmux")) throw Error("the onboarding sandbox needs tmux");
    if (running(s)) return;
    for (const [session, windows] of [
      ["api", ["server", "tests"]],
      ["site", ["dev"]],
    ] as const) {
      tmux(s, "new-session", "-d", "-s", session, "-n", windows[0], "-c", s.home);
      for (const name of windows.slice(1)) tmux(s, "new-window", "-d", "-t", session, "-n", name, "-c", s.home);
      tmux(s, "send-keys", "-t", `${session}:${windows[0]}`, `echo ${session} is running`, "Enter");
    }
  },
  seed() {},
  arrange(s) {
    const workspace = String(s.corgi(["workspace", "list"]).workspaces[0].id);
    s.corgi(["workspace", "edit", workspace, "--name", "onboarding", "--cwd", s.home]);
  },
  shutdown(s) {
    if (running(s)) tmux(s, "kill-server");
    rmSync(tmuxDir(s), { recursive: true, force: true });
  },
  intro() {
    return table([
      ["corgi onboard", "opens onboarding; Enter goes on to the import step"],
      ["tmux kill-server", "leaves nothing to import, so onboarding skips that step"],
    ]);
  },
};
