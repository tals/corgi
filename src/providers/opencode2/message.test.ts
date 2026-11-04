import { test, expect } from "bun:test";
import { send } from "./message";
import type { API } from "./api";
test("a prompt the service refused can be typed instead; one it never answered may have arrived", async () => {
  const requests: { path: string; body: unknown }[] = [];
  let answer: () => Promise<Response> = async () => new Response(null, { status: 204 });
  const api = {
    request: async (path: string, init: RequestInit) => {
      requests.push({ path, body: JSON.parse(String(init.body)) });
      return answer();
    },
  } as unknown as API;
  await send(api, "ses_1", "review this");
  expect(requests).toEqual([{ path: "/api/session/ses_1/prompt", body: { text: "review this", delivery: "steer" } }]);
  answer = async () => new Response("no such session", { status: 404 });
  await expect(send(api, "ses_1", "x")).rejects.toThrow("MessageUnavailable");
  answer = async () => {
    throw Object.assign(Error("refused"), { code: "ECONNREFUSED" });
  };
  await expect(send(api, "ses_1", "x")).rejects.toThrow("MessageUnavailable");
  answer = async () => {
    throw Object.assign(Error("timed out"), { name: "TimeoutError" });
  };
  await expect(send(api, "ses_1", "x")).rejects.toThrow("DeliveryUnknown");
});
