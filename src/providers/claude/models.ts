import type { InferenceModel } from "../adapter";
import type { Quit } from "../../subprocess";
import { Client } from "./account";
import { vocabulary } from "./info";
import * as effort from "../effort";
import { configHome, field, str } from "../common";
import { cached } from "../command_line";
import * as nativeModels from "../../inference/native_models";

export async function read(account: string, quit: Quit): Promise<InferenceModel[]> {
  if (quit.aborted) throw Error("Cancelled");
  const env = account ? { ...process.env, [vocabulary.config_env]: account } : process.env,
    client = new Client(env);
  const abort = () => client.close();
  quit.abortSignal.addEventListener("abort", abort, { once: true });
  try {
    const { info, models } = await client.models(quit);
    if (!Array.isArray(models)) throw Error("InvalidModels");
    const configured = effort.parse(
      field(cached(configHome(env, vocabulary.config_env, ".claude"), "settings.json"), "effortLevel"),
    );
    return nativeModels.options(
      models.map(entry => ({
        efforts: effort.list(field(entry, "supportedEffortLevels")),
        ...(configured && effort.list(field(entry, "supportedEffortLevels")).includes(configured)
          ? { default_effort: configured }
          : {}),
        id: str(entry, "resolvedModel") || str(entry, "value"),
        name: str(entry, "value") === "default" ? "" : str(entry, "displayName"),
      })),
      info,
    );
  } finally {
    quit.abortSignal.removeEventListener("abort", abort);
    client.close();
  }
}
