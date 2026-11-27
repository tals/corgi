import { Terminal } from "../../pane/terminal";
import type { Progress } from "../../startup";
import { rename } from "./screen";
import { selected } from "./presence";
import { validSession } from "./config";

/** agy exposes /fork only to its interactive composer. Open the source in a private PTY
 * and wait for the new process-owned session before handing it to the user's pane. */
export async function fork(bin: string, source: string, cwd: string, progress?: Progress) {
  if (!validSession(source)) throw Error("InvalidSession");
  const screen = Terminal.create(100, 30),
    env: NodeJS.ProcessEnv = { ...process.env, TERM: "xterm-256color" };
  delete env.CORGI_PANE;
  let child: Bun.Subprocess | null = null;
  try {
    child = Bun.spawn([bin, "--conversation", source], {
      env,
      cwd,
      terminal: {
        cols: 100,
        rows: 30,
        data(_tty, bytes) {
          screen.feed(bytes);
        },
      },
    });
    let stage: "open" | "typed" | "submitted" = "open";
    const until = Date.now() + 15000;
    while (Date.now() < until && child.exitCode === null && !child.signalCode) {
      if (progress?.quit.aborted) throw Error("Cancelled");
      if (stage === "open" && rename.empty(screen) && screen.liveText().includes("? for shortcuts")) {
        child.terminal!.write("/fork");
        stage = "typed";
      } else if (stage === "typed" && rename.holds(screen, "/fork")) {
        child.terminal!.write("\r");
        stage = "submitted";
      } else if (stage === "submitted" && screen.liveText().includes("To go back, use: /resume " + source)) {
        const id = await selected(child.pid, "");
        if (id && id !== source) return id;
      }
      await Bun.sleep(40);
    }
    throw Error("ForkUnavailable");
  } finally {
    if (child) {
      const process = child;
      process.kill("SIGTERM");
      const timeout = setTimeout(() => process.kill("SIGKILL"), 1000);
      try {
        await process.exited;
      } finally {
        clearTimeout(timeout);
        process.terminal?.close();
      }
    }
    screen.destroy();
  }
}
