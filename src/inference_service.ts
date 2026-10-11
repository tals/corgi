import * as setup from "./inference/setup";
import { Model } from "./providers/model";
import type { Server } from "./server";
import type { Client } from "./peer";
import type { Request } from "./protocol";
export async function configure(server: Server, client: Client, query: Request<"inference.configure">) {
  const worker = server.summaries;
  if (!worker) throw Error("InferenceUnavailable");
  worker.configure(query.choice);
  let saved = false;
  try {
    await setup.save(setup.path(server.socket), query.choice);
    saved = true;
  } catch {}
  const status = worker.status();
  server.runtime.inference = status;
  server.runtime.system_model = Model.resolve(status.model);
  server.runtime.changed();
  server.dirty = true;
  client.reply("inference.configure", { saved, inference: status });
}
