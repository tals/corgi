import * as setup from "./inference/setup";
import { Model } from "./providers/model";
import type { Server } from "./server";
import type { Client } from "./peer";
import type { Request } from "./protocol";
/** Sets who answers, what they are asked for, or both; each part it names is saved. */
export async function configure(server: Server, client: Client, query: Request<"inference.configure">) {
  const worker = server.summaries;
  if (!worker) throw Error("InferenceUnavailable");
  const uses: Partial<setup.Uses> = {};
  for (const use of setup.uses) if (query[use] !== null) uses[use] = query[use];
  worker.configure(query.choice, uses);
  let saved = false;
  try {
    const file = setup.path(server.socket);
    if (query.choice !== null && query.choice !== "off") setup.save(file, query.choice);
    // The switches go in the file once it wouldn't bring them back as they
    // are: after a change, or after an older Corgi's "off".
    if (JSON.stringify(setup.loadUses(file)) !== JSON.stringify(worker.uses)) setup.saveUses(file, worker.uses);
    saved = true;
  } catch {}
  const status = worker.status();
  server.runtime.inference = status;
  server.runtime.system_model = Model.resolve(status.model);
  server.runtime.changed();
  server.dirty = true;
  client.reply("inference.configure", { saved, inference: status });
}
