import type { InferenceModel } from "../adapter";
import { Stdio } from "../stdio";
import { field, str } from "../common";
import { parse } from "../pi/models";
import { credentials } from "./accounts";
import { directory } from "./integration";
import { bare } from "./launcher";
import * as discovery from "../../discovery";
import type { Quit } from "../../subprocess";
/** omp lists only models whose provider it has a sign-in or key for. */
export async function read(account: string, quit: Quit): Promise<InferenceModel[]> {
  const executable = await discovery.resolve("omp", "/tmp");
  if (quit.aborted) throw Error("Cancelled");
  const root = directory(account),
    env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: root };
  delete env.CORGI_PANE;
  delete env.CORGI_SOCKET;
  const io = Stdio.spawn([executable, ...bare], { cwd: "/tmp", env });
  const abort = () => io.close();
  quit.abortSignal.addEventListener("abort", abort, { once: true });
  try {
    io.write({ id: "corgi-models", type: "get_available_models" });
    const deadline = Date.now() + 15000;
    while (!quit.aborted && Date.now() < deadline) {
      for (const v of io.read()) {
        if (str(v, "type") !== "response" || str(v, "id") !== "corgi-models") continue;
        if (field(v, "success") !== true) throw Error("ModelsUnavailable");
        // Pi's auth.json shape, from the first sign-in for each provider.
        const auth: Record<string, unknown> = {};
        for (const c of credentials(root))
          auth[c.provider] ??= { ...(c.data as object), type: c.type === "api_key" ? "api_key" : "oauth" };
        return parse(field(v, "data"), auth);
      }
      if (io.exited || io.closed) break;
      await io.wait(deadline);
    }
    throw Error("ModelsUnavailable");
  } finally {
    quit.abortSignal.removeEventListener("abort", abort);
    io.close();
  }
}
