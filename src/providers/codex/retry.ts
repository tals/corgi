//! Codex turns that failed on a condition that may pass, and starting one
//! again through the app server that runs its thread.
import { field, str } from "../common";
import * as socket from "./socket";
import * as errors from "../../errors";
import type { Retried } from "../adapter";
/** The `codexErrorInfo` codes of failures a later attempt may get past. */
const passing = ["serverOverloaded"];
/** When `turn`, as the app server lists it, failed on a passing condition,
 * in Unix seconds; 0 otherwise. */
export function transient(turn: unknown) {
  if (str(turn, "status") !== "failed" || !passing.includes(str(field(turn, "error"), "codexErrorInfo"))) return 0;
  const at = field(turn, "completedAt");
  return Number.isInteger(at) && at > 0 ? at : 0;
}
/** Starts `session`'s failed turn `turn` again, with no new input, through
 * the server listening at `path`, if that turn is still the thread's latest,
 * nothing runs, and `clear` still says so just before it starts. */
export async function retry(path: string, session: string, turn: string, clear: () => boolean): Promise<Retried> {
  let client: socket.Client;
  try {
    client = await socket.Client.open(path);
  } catch (error) {
    if (errors.is(error, "ConnectFailed") || errors.is(error, "Timeout")) return "declined";
    throw error;
  }
  try {
    const read = await client.call("thread/read", { threadId: session, includeTurns: false }),
      status = str(field(field(field(read, "result"), "thread"), "status"), "type");
    if (status !== "idle" && status !== "systemError") return "declined";
    const turns = await client.call("thread/turns/list", {
        threadId: session,
        limit: 1,
        sortDirection: "desc",
        itemsView: "summary",
      }),
      data = field(field(turns, "result"), "data"),
      latest = Array.isArray(data) ? data[0] : null;
    if (str(latest, "id") !== turn || !transient(latest)) return "declined";
    // turn/start has no precondition, and on a running turn it steers that
    // turn instead. A prompt typed into the pane since the checks may not show
    // yet, so ask last; `call` sends before anything else runs.
    if (!clear()) return "held";
    await client.call("turn/start", { threadId: session, input: [] });
    return "started";
  } catch (error) {
    switch (errors.name(error)) {
      case "RpcError":
      case "Timeout":
      case "Disconnected":
      case "BadResponse":
        return "declined";
    }
    throw error;
  } finally {
    client.close();
  }
}
