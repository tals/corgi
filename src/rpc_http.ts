import * as http from "node:http";
import * as json from "./json";
import * as errors from "./errors";
import * as protocol from "./protocol";
import * as rpc_legacy from "./rpc_legacy";

const timeout_ms = 45_000;
function remaining(started: number, limit_ms: number): number {
  const left = limit_ms - (performance.now() - started);
  if (left <= 0) throw Error("RequestTimedOut");
  return left;
}
/** Uncompressed, one envelope per POST on the daemon's existing Unix socket. */
export function post(path: string, value: unknown, limit_ms = timeout_ms): Promise<unknown> {
  const body = Buffer.from(json.stringify(json.object(value)));
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error?: Error, reply?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      request.destroy();
      if (error) reject(error);
      else resolve(reply);
    };
    const request = http.request(
      {
        socketPath: path,
        method: "POST",
        path: "/rpc",
        agent: false,
        headers: { "Content-Type": "application/json", "Content-Length": body.length, Connection: "close" },
      },
      response => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("error", () => finish(Error("IncompleteHttpReply")));
        response.on("data", (chunk: Buffer) => {
          if (done) return;
          size += chunk.length;
          if (size > 64 * 1024 * 1024) finish(Error("MessageTooLarge"));
          else chunks.push(chunk);
        });
        response.on("end", () => {
          if (done) return;
          if (response.statusCode !== 200 && response.statusCode !== 400) return finish(Error("UnexpectedHttpStatus"));
          try {
            finish(undefined, json.parse(Buffer.concat(chunks, size).toString()));
          } catch (error) {
            finish(error as Error);
          }
        });
      },
    );
    const timer = setTimeout(() => finish(Error("RequestTimedOut")), limit_ms);
    request.on("error", error => finish(error));
    request.end(body);
  });
}
export interface Discovery {
  transport: "http" | "stream";
  hello: protocol.Response<"hello">;
}
/** Only the read-only probe may fall back. Do not cache across daemon handoffs. */
export async function discover(path: string, limit_ms = 10_000): Promise<Discovery> {
  const query = protocol.envelope("hello"),
    started = performance.now();
  let value: unknown,
    transport: Discovery["transport"] = "http";
  try {
    value = await post(path, query, Math.min(limit_ms, 1000));
  } catch (error) {
    if (!rpc_legacy.probeAfter(error)) throw error;
    transport = "stream";
    value = await rpc_legacy.request(path, query, remaining(started, limit_ms));
  }
  const hello = json.object(value);
  if (typeof hello.err !== "string" && !(hello.type === "hello" && Number.isSafeInteger(hello.protocol)))
    throw Error("UnexpectedReply");
  return { transport, hello: hello as protocol.Response<"hello"> };
}
/** Select transport before sending the caller's request; never replay it on failure. */
export async function rawRequest(path: string, value: unknown, limit_ms = timeout_ms): Promise<unknown> {
  const message = json.object(value),
    started = performance.now();
  const found = await discover(path, limit_ms);
  const left = remaining(started, limit_ms);
  return rpc_legacy.needsStream(message.op, found.hello, found.transport)
    ? rpc_legacy.request(path, message, left)
    : post(path, message, left);
}
export async function call<K extends protocol.Op>(
  path: string,
  op: K,
  ...args: protocol.Arguments<K>
): Promise<protocol.Reply<K>> {
  const reply = (
    op === "hello" && args[0] === undefined
      ? (await discover(path)).hello
      : json.object(await rawRequest(path, protocol.envelope(op, args[0])))
  ) as protocol.Response<K>;
  if ("err" in reply) throw errors.fromReply(reply);
  return reply;
}
