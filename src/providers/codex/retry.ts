//! Codex turns that failed on a condition that may pass, and starting one
//! again through the app server that runs its thread.
import { field, str } from "../common";
import * as socket from "./socket";
import * as errors from "../../errors";
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
 * the server listening at `path`, if that turn is still the thread's latest
 * and nothing runs; whether it did. */
export async function retry(path: string, session: string, turn: string) {
  let client: socket.Client;
  try {
    client = await socket.Client.open(path);
  } catch (error) {
    if (errors.is(error, "ConnectFailed") || errors.is(error, "Timeout")) return false;
    throw error;
  }
  try {
    const read = await client.call("thread/read", { threadId: session, includeTurns: false }),
      status = str(field(field(field(read, "result"), "thread"), "status"), "type");
    if (status !== "idle" && status !== "systemError") return false;
    const turns = await client.call("thread/turns/list", {
        threadId: session,
        limit: 1,
        sortDirection: "desc",
        itemsView: "summary",
      }),
      data = field(field(turns, "result"), "data"),
      latest = Array.isArray(data) ? data[0] : null;
    if (str(latest, "id") !== turn || !transient(latest)) return false;
    await client.call("turn/start", { threadId: session, input: [] });
    return true;
  } catch (error) {
    switch (errors.name(error)) {
      case "RpcError":
      case "Timeout":
      case "Disconnected":
      case "BadResponse":
        return false;
    }
    throw error;
  } finally {
    client.close();
  }
}
