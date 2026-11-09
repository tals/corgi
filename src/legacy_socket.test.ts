import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import { ReadyLoop } from "./native_bridge";
import * as legacy_socket from "./legacy_socket";
import * as os from "./os";
import * as peer from "./peer";
import * as protocol from "./protocol";
import * as rpc_http from "./rpc_http";
import type * as socket_server from "./socket_server";

/** A listener on a fresh socket whose clients answer each request with its op;
 * `finishing` says whether the update is still waiting on the older updater. */
function fixture(finishing = () => true) {
  const root = fs.mkdtempSync("/tmp/corgi-legacy-"),
    socket = root + "/s",
    loop = new ReadyLoop();
  const answer = (client: peer.Client) => {
    const value = client.take();
    client.queue({ ok: true, op: value.op });
    client.done();
  };
  const accept: socket_server.Accept = {
    connection: transport => new peer.Client(transport, answer, () => {}),
    request: (value, respond) => {
      const client = new peer.Client(
        null,
        answer,
        () => {},
        true,
        () => {},
        respond,
      );
      client.request(value);
      return client;
    },
  };
  const listener = new legacy_socket.Listener(os.listen(socket), loop, accept, finishing);
  return {
    socket,
    listener,
    [Symbol.dispose]() {
      listener.close();
      loop.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("an older build's listener answers JSON lines", async () => {
  using f = fixture();
  const connection = net.connect(f.socket);
  connection.write('{"op":"hello"}\n{"op":"server.reload"}\n');
  let received = "";
  for await (const chunk of connection) {
    received += chunk;
    if (received.split("\n").length > 2) break;
  }
  connection.destroy();
  expect(received).toBe('{"ok":true,"op":"hello"}\n{"ok":true,"op":"server.reload"}\n');
});

test("an older build's listener answers an HTTP POST once", async () => {
  using f = fixture();
  expect(await new rpc_http.Client(f.socket).post({ op: "hook" })).toEqual({ ok: true, op: "hook" });
});

test("a new client's hello hears the update isn't done", async () => {
  using f = fixture();
  expect(await new rpc_http.Client(f.socket).post(protocol.envelope("hello"))).toEqual({ err: "UpdateIncomplete" });
});

test("once the update is done, a new client's hello is answered", async () => {
  using f = fixture(() => false);
  expect(await new rpc_http.Client(f.socket).post(protocol.envelope("hello"))).toEqual({ ok: true, op: "hello" });
});
