//! Sends a Codex thread a prompt through the app server that runs it.
import * as socket from "./socket";
import * as errors from "../../errors";
/** Starts a turn on thread `id` with `text`; on a running turn, the app
 * server steers that turn with it instead. */
export async function message(path: string, id: string, text: string) {
  const client = await socket.Client.open(path);
  try {
    await client.call("turn/start", { threadId: id, input: [{ type: "text", text }] });
  } catch (error) {
    if (errors.is(error, "RpcError")) throw Error("MessageUnavailable");
    throw error;
  } finally {
    client.close();
  }
}
