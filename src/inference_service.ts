import * as setup from "./inference/setup";
import { Model } from "./providers/model";
import type { Server } from "./server";
import { Reply, type Client } from "./peer";
import type { Request } from "./protocol";
import { Provider, adapter } from "./providers";
import { Selection } from "./inference/models";
import * as accounts from "./accounts";
/** Sets who answers, what they are asked for, or both; each part it names is saved. */
export async function configure(
  server: Server,
  client: Client,
  query: Request<"inference.configure">,
  reply = new Reply(client),
) {
  const worker = server.summaries;
  if (!worker) throw Error("InferenceUnavailable");
  const uses: Partial<setup.Uses> = {};
  for (const use of setup.uses) if (query[use] !== null) uses[use] = query[use];
  const provider = Provider.parse(query.choice);
  const refresh =
    query.choice === null && query.model === null && query.account === null && Object.keys(uses).length === 0;
  let selected: Selection | undefined;
  if (refresh) void worker.catalog.refresh();
  if (
    query.model !== null ||
    query.account !== null ||
    (provider && adapter(provider).inference.models && adapter(provider).inference.catalog !== "native")
  ) {
    if (!provider) throw Error("InvalidModel");
    if (!adapter(provider).inference.models || adapter(provider).inference.catalog === "native") {
      selected = Selection.parse({
        provider,
        model: query.model || setup.model(provider),
        account: query.account ?? "",
      });
      if (!selected.provider || (selected.account && !accounts.find(provider, selected.account)))
        throw Error("ModelUnavailable");
    } else {
      const option = worker.catalog.available.find(
        m =>
          m.provider === provider && (!query.model || (m.model === query.model && m.account === (query.account ?? ""))),
      );
      if (!option) throw Error("ModelUnavailable");
      selected = Object.assign(new Selection(), {
        provider,
        model: query.model ? option.model : "",
        account: query.model ? option.account : "",
      });
    }
  } else if (provider && worker.selected.provider !== null) {
    selected = new Selection();
  }
  if (!refresh) worker.configure(query.choice, uses, selected);
  let saved = false;
  try {
    const file = setup.path(server.socket);
    if (query.choice !== null && query.choice !== "off") setup.save(file, query.choice);
    if (selected) setup.saveSelection(file, selected);
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
  reply.ok({ saved, inference: status });
}
