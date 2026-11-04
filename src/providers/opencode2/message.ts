//! Sends an OpenCode session a prompt through the service that holds it.
import { field } from "../common";
import * as errors from "../../errors";
import type { API } from "./api";
/** Steers `session`'s running turn with `text`, or starts one. Throws
 * MessageUnavailable when the service refused or never got the request, and
 * DeliveryUnknown when it went unanswered, as it may have started the turn. */
export async function send(api: API, session: string, text: string) {
  let reply: Response;
  try {
    reply = await api.request(`/api/session/${session}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, delivery: "steer" }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    const code = field(error, "code"),
      refused = code === "ConnectionRefused" || code === "ECONNREFUSED";
    throw Error(refused || errors.is(error, "OpenCodeServiceUnavailable") ? "MessageUnavailable" : "DeliveryUnknown");
  }
  await reply.body?.cancel();
  if (!reply.ok) throw Error("MessageUnavailable");
}
