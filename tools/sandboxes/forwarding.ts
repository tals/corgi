/**
 * The forwarding sandbox: links to a remote machine's localhost, opened here.
 *
 * `devbox` stands in for an SSH machine: a second Corgi on this computer,
 * reached through a fake `ssh` that runs its commands here and relays
 * `ssh -W` to its servers. Those listen 20000 ports above the ports they
 * print, so this computer's own ports stay free, as with a real remote.
 *
 * - devbox › dev server: a Vite-style banner with localhost links, and a
 *   docs link on a port this computer also serves, so it forwards one up.
 * - devbox › sign in: a CLI login that opens its page through $BROWSER and
 *   waits for the browser to come back to localhost:1455 on devbox.
 * - devbox › shell: try `$BROWSER http://localhost:5173/` yourself.
 * - here › devbox: runs devbox; keep it open.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { shellQuote } from "../../src/os";
import { table, type World } from "../sandbox";
import { devbox, devboxEnv, offset, ports } from "../forwarding_sandbox";

const lab = join(import.meta.dir, "..", "forwarding_sandbox.ts");

export const world: World = {
  seed(s) {
    const real = Bun.which("ssh");
    if (!real) throw Error("the forwarding sandbox needs ssh, for machines other than devbox");
    const env = devboxEnv(s.dir, {});
    const exports = Object.entries(env)
      .map(([key, value]) => `${key}=${shellQuote(value!)}`)
      .join(" ");
    s.write(
      join(s.home, "bin/ssh"),
      [
        "#!/bin/sh",
        "# devbox runs here; any other host goes to the real ssh.",
        'target=""; seen=0; prev=""; forward=""; control=""; quiet=0; last=""',
        'for arg in "$@"; do',
        '  if [ "$seen" = 1 ] && [ -z "$target" ]; then target="$arg"; fi',
        '  [ "$arg" = "--" ] && seen=1',
        '  [ "$prev" = "-W" ] && forward="$arg"',
        '  [ "$prev" = "-O" ] && control="$arg"',
        '  [ "$arg" = "-N" ] && quiet=1',
        '  prev="$arg"; last="$arg"',
        "done",
        `[ "$target" = devbox ] || exec ${shellQuote(real)} "$@"`,
        // No master to check or start: each command runs here.
        '[ -n "$control" ] && exit 0',
        '[ "$quiet" = 1 ] && exit 0',
        `[ -n "$forward" ] && exec ${shellQuote(process.execPath)} ${shellQuote(lab)} relay "\${forward##*:}"`,
        '[ "$last" = devbox ] && { echo "devbox: this sandbox runs commands, not logins" >&2; exit 1; }',
        `exec env ${exports} sh -c "$last"`,
        "",
      ].join("\n"),
    );
    s.run(["chmod", "700", join(s.home, "bin/ssh")]);
  },

  /** This computer's workspace runs devbox; devbox lays out its own. */
  async arrange(s) {
    const before: { id: number; model?: { tabs?: unknown[] } }[] = s.corgi(["workspace", "list"])?.workspaces ?? [];
    const made: { workspace: number; tab: number } = s.corgi(["workspace", "new", "here", "--cwd", s.dir]);
    s.corgi(["tab", "rename", String(made.tab), "shell"]);
    const supervisor = s.corgi([
      "tab",
      "new",
      "--workspace",
      String(made.workspace),
      "--name",
      "devbox",
      "--cwd",
      s.dir,
      "--command",
      [process.execPath, lab, "serve", s.dir, s.exe].map(shellQuote).join(" "),
    ]);
    s.corgi(["tab", "move", String(made.tab), "--after", String(supervisor.tab)]);
    for (const w of before)
      if (w.id !== made.workspace && (w.model?.tabs?.length ?? 0) === 0)
        s.corgi(["workspace", "close", String(w.id)], false);
    // The viewer reads the machine list as it starts.
    const catalog = join(s.env.XDG_STATE_HOME, "corgi/remote/machines.json"),
      until = Date.now() + 30_000;
    while (!existsSync(catalog) || !existsSync(devbox(s.dir).auth)) {
      const log = join(devbox(s.dir).root, "supervisor.log");
      if (existsSync(log)) throw Error(readFileSync(log, "utf8"));
      if (Date.now() >= until) throw Error("devbox didn't start; see the devbox tab or devbox/server.log");
      await Bun.sleep(100);
    }
  },

  async shutdown(s) {
    const box = devbox(s.dir);
    if (!existsSync(box.socket)) return;
    Bun.spawnSync([s.exe, "shutdown"], { env: devboxEnv(s.dir, s.env) as Record<string, string> });
    const until = Date.now() + 15_000;
    while (existsSync(box.socket) && Date.now() < until) await Bun.sleep(50);
  },

  intro() {
    return [
      `devbox stands in for an SSH machine: a second Corgi here, its servers ${offset} ports up.`,
      ...table([
        ["Hover", `a localhost link on devbox: it points here (the bottom line says where)`],
        ["Cmd+click", "opens it forwarded; a click or Ctrl+click does too"],
        ["Header", "hover devbox's header: Forwarded ports; click one to hold the card"],
        ["  ↑↓ ↵ x", "select, open again, stop forwarding; Esc closes"],
        ["Docs", `devbox's :${ports.docs} is served here too, so it opens on :${ports.docs + 1}`],
        ["Sign in", `devbox › sign in, Enter: $BROWSER opens it; the callback reaches :${ports.callback} there`],
        ["$BROWSER", `devbox › shell: $BROWSER http://localhost:${ports.app}/`],
      ]),
    ];
  },
};
