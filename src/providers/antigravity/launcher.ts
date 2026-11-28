import { join } from "node:path";
import type { InferenceModel, Launcher } from "../adapter";
import { str } from "../common";
import { directory, read } from "./config";
import { Client } from "./account";
import * as discovery from "../../discovery";
import { run, type Quit } from "../../subprocess";

export function catalog(output: string): InferenceModel[] {
  return output.split(/\r?\n/).flatMap(line => {
    const [id, name] = line.split("\t");
    if (!/^[\w.-]+$/.test(id) || !name?.trim() || /[\x00-\x1f\x7f]/.test(name)) return [];
    return [{ id, name: name.trim(), subscription: false, input_cost: null, output_cost: null }];
  });
}
export async function models(account: string, quit: Quit, cwd = "/tmp") {
  const bin = await discovery.resolve("antigravity", cwd),
    reply = await run([bin, "models"], {
      cwd,
      env: account ? { ...process.env, HOME: account } : process.env,
      quit,
      timeout_ms: 8000,
      max_output: 128 * 1024,
    });
  if (!reply.ok()) throw Error("ModelsUnavailable");
  return catalog(reply.stdout.toString());
}
export function open(account: string): Launcher {
  const file = join(directory(account), "settings.json"),
    client = new Client(account);
  return {
    account: (quit, max_age, cwd) => client.preview(quit, max_age, cwd),
    async model() {
      const model = str(await read(file), "model");
      return { model, source: model ? "User settings" : "Account default / provider selection" };
    },
    watches: () => [file, join(directory(account), "antigravity-oauth-token")],
    close: () => client.close(),
  };
}
