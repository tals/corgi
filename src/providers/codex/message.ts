//! Sends a Codex thread a prompt through the app server that runs it.
import * as socket from "./socket";
import * as errors from "../../errors";
/** Starts a turn on thread `id` with `text`; on a running turn, the app
 * server steers that turn with it instead. Throws MessageUnavailable when the
 * server never took the prompt, and DeliveryUnknown when it went unanswered,
 * as it may still have started the turn. */
export async function send(path: string, id: string, text: string) {
  let client: socket.Client;
  try {
    client = await socket.Client.open(path);
  } catch (error) {
    if (unanswered(error) || errors.is(error, "ConnectFailed") || errors.is(error, "RpcError"))
      throw Error("MessageUnavailable");
    throw error;
  }
  try {
    await client.call("turn/start", { threadId: id, input: [{ type: "text", text }] }, 3000);
  } catch (error) {
    if (errors.is(error, "RpcError")) throw Error("MessageUnavailable");
    if (unanswered(error)) throw Error("DeliveryUnknown");
    throw error;
  } finally {
    client.close();
  }
}
function unanswered(error: unknown) {
  return errors.is(error, "Timeout") || errors.is(error, "Disconnected");
}
