//! What the launcher shows about Codex: its account, usage and effective
//! model, read through its app server.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Launcher } from "../adapter";
import { Cache, cooldown } from "../../usage/account_cache";
import { getLogger } from "../../log";
import { Failure } from "../../failure";
import * as errors from "../../errors";
import * as discovery from "../../discovery";
import { configDir } from "./index";
import { identity } from "./info";
import * as appServer from "./app_server";
const log = getLogger("codex.account");
/** What the launcher shows about `account`, "" for the default. */
export function open(account = ""): Launcher {
  const failure = new Failure();
  let opened: appServer.AppServer | null = null;
  const server = async (cwd: string) => {
    const executable = await discovery.resolve("codex", cwd);
    if (opened?.executable !== executable) {
      opened?.close();
      opened = new appServer.AppServer(5000, executable, account);
    }
    return opened;
  };
  /** When this folder may try again after its read failed. */
  let retry_at = 0;
  return {
    async account(quit, max_age, cwd = process.cwd()) {
      const root = account || configDir();
      // Folders signed in to one account share its reading.
      let login = identity(root)?.id;
      if (!login)
        try {
          login = readFileSync(join(root, "auth.json"), "utf8");
        } catch {
          login = root;
        }
      const cache = await Cache.open("codex", login + "\n" + (process.env.OPENAI_API_KEY ?? ""));
      try {
        const now = Math.floor(Date.now() / 1000);
        if (max_age > 0 && (now < retry_at || now - cache.state.info.usage_fetched_at < max_age))
          return cache.state.display(now);
        const started = Date.now();
        try {
          const fresh = await appServer.account(await server(cwd), quit.abortSignal);
          cache.state.update(fresh, Math.floor(Date.now() / 1000));
          if (fresh.usage_error.len) retry_at = now + cooldown;
          if (failure.clear()) log.info("Account read recovered", { account, ms: Date.now() - started });
        } catch (e) {
          retry_at = now + cooldown;
          cache.state.failed(errors.is(e, "Timeout") ? "request timed out" : "account read failed");
          if (!errors.is(e, "Cancelled") && failure.changed(e))
            log.warn("Account read failed", { account, ms: Date.now() - started, err: e });
        }
        cache.save();
        return cache.state.display(Math.floor(Date.now() / 1000));
      } finally {
        cache.close();
      }
    },
    async model(cwd, quit) {
      try {
        return {
          model: (await appServer.model(await server(cwd), cwd, quit.abortSignal)).text(),
          source: "Effective Codex settings",
        };
      } catch {
        return { model: "", source: "Model resolved by Codex at startup" };
      }
    },
    close() {
      opened?.close();
      opened = null;
    },
  };
}
