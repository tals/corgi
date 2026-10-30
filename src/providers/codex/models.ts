import * as effort from "../effort";
import type { InferenceModel } from "../adapter";
import type { Quit } from "../../subprocess";
import { AppServer, account as readAccount } from "./app_server";
import { field, str } from "../common";
import * as nativeModels from "../../inference/native_models";

export async function read(account: string, quit: Quit): Promise<InferenceModel[]> {
  if (quit.aborted) throw Error("Cancelled");
  const server = new AppServer(5000, null, account);
  const abort = () => server.close();
  quit.abortSignal.addEventListener("abort", abort, { once: true });
  try {
    const info = await readAccount(server, quit.abortSignal);
    if (info.signed_in !== true) return [];
    let configured: effort.Effort | null = null,
      config_read = false;
    try {
      const config = field(
        field(await server.request("config/read", { includeLayers: false }, quit.abortSignal), "result"),
        "config",
      );
      configured = effort.parse(field(config, "model_reasoning_effort"));
      config_read = true;
    } catch {
      if (quit.aborted) throw Error("Cancelled");
    }
    const entries: { id: string; name: string; efforts: effort.Effort[]; default_effort?: effort.Effort }[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 100; page++) {
      const reply = await server.request("model/list", { cursor, limit: 100 }, quit.abortSignal),
        result = field(reply, "result"),
        data = field(result, "data");
      if (!Array.isArray(data)) throw Error("InvalidModels");
      for (const entry of data) {
        const supported = field(entry, "supportedReasoningEfforts"),
          default_effort = config_read ? (configured ?? effort.parse(field(entry, "defaultReasoningEffort"))) : null;
        entries.push({
          id: str(entry, "model"),
          ...(default_effort ? { default_effort } : {}),
          name: str(entry, "displayName"),
          efforts: effort.list(Array.isArray(supported) ? supported.map(v => str(v, "reasoningEffort")) : []),
        });
      }
      const next = str(result, "nextCursor");
      if (!next) return nativeModels.options(entries, info);
      if (next === cursor) throw Error("InvalidModels");
      cursor = next;
    }
    throw Error("InvalidModels");
  } finally {
    quit.abortSignal.removeEventListener("abort", abort);
    server.close();
  }
}
