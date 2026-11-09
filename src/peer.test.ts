import { test, expect } from "bun:test";
import * as peer from "./peer";
import * as client_socket from "./fixtures/client_socket";

/** A client that answers each request with `respond`. */
function client(respond: (cl: peer.Client, value: any) => void = () => {}) {
  const recorder = new client_socket.Recorder(),
    received: any[] = [];
  const cl = new peer.Client(
    recorder,
    (client, value) => {
      received.push(client.take());
      respond(client, value);
      client.done();
    },
    () => {},
  );
  return { cl, recorder, received };
}
test("replies queue as lines and an oversized one drops the client without a partial line", () => {
  const { cl, recorder } = client();
  cl.queue({ ok: true });
  cl.queue({ n: 1 });
  const before = '{"ok":true}\n{"n":1}\n';
  expect(recorder.text).toBe(before);
  cl.queue({ text: "x".repeat(4 * 1024 * 1024) });
  expect(cl.dead).toBe(true);
  expect(recorder.closed).not.toBeNull();
  expect(recorder.text).toBe(before);
});
test("a connection's bytes are JSON lines however they're split, and a bad line is answered", () => {
  const { cl, recorder, received } = client(cl => cl.queue({ ok: true }));
  cl.read(Buffer.from('{"op":"pi'));
  cl.read(Buffer.from('ng"}\n{x}\n{"op":"hello"}\n'));
  expect(received).toEqual([{ op: "ping" }, { op: "hello" }]);
  expect(recorder.lines()).toEqual([{ ok: true }, { err: "InvalidJson" }, { ok: true }]);
  expect(cl.dead).toBe(false);
});
test("an HTTP request is one envelope, answered once, after which the client is gone", () => {
  const answers: unknown[] = [],
    received: any[] = [];
  let gone = false;
  const cl = new peer.Client(
    null,
    client => {
      received.push(client.take());
      client.queue({ ok: true });
      client.queue({ ok: "again" });
      client.done();
    },
    () => (gone = true),
    true,
    () => {},
    reply => answers.push(reply),
  );
  cl.request({ op: "hook", protocol: 2, provider: "claude", pane: 3 });
  expect(received).toEqual([{ op: "hook", protocol: 2, provider: "claude", pane: 3 }]);
  expect(answers).toEqual([{ ok: true }]);
  expect(cl.http).toBe(true);
  expect(gone).toBe(true);
});
test("a paused client holds its requests until it resumes", () => {
  const { cl, received } = client();
  cl.pause();
  cl.read(Buffer.from('{"op":"ping"}\n'));
  expect(received).toEqual([]);
  expect(cl.waiting).toBe(true);
  cl.resume();
  expect(received).toEqual([{ op: "ping" }]);
  expect(cl.waiting).toBe(false);
});
test("a request whose job hasn't taken it yet is still waiting", () => {
  // A reload hands it on: the daemon's queue never reaches that job.
  const cl = new peer.Client(
    new client_socket.Recorder(),
    () => {},
    () => {},
  );
  cl.read(Buffer.from('{"op":"ping"}\n'));
  expect(cl.waiting).toBe(true);
  expect(cl.take()).toEqual({ op: "ping" });
  expect(cl.waiting).toBe(false);
});
test("only a connection's first request, alone, may switch it to compression", () => {
  const ready: boolean[] = [];
  const answer = (cl: peer.Client) => {
    ready.push(cl.canCompress);
    cl.queue({ ok: true });
  };
  client(answer).cl.read(Buffer.from('{"op":"hello"}\n'));
  expect(ready).toEqual([true]);
  ready.length = 0;
  client(answer).cl.read(Buffer.from('{"op":"ping"}\n{"op":"hello"}\n'));
  expect(ready).toEqual([false, false]);
});
