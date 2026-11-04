import { expect, test } from "bun:test";
import { Claude } from "./claude/headless";
import { Codex } from "./codex/headless";
import { Stdio } from "./stdio";
import type { Host } from "./adapter";

const tool = { name: "corgi", description: "Runs Corgi", input: { type: "object" } };
for (const provider of ["claude", "codex"] as const) {
  const make = (io: Stdio) =>
    provider === "claude" ? new Claude(io, null, true) : new Codex(io, "/tmp", null, { tools: [tool] });
  const request = (id: number) =>
    provider === "claude"
      ? {
          type: "control_request",
          request_id: String(id),
          request: {
            subtype: "mcp_message",
            server_name: "corgi",
            message: { jsonrpc: "2.0", id, method: "tools/call", params: { name: "corgi" } },
          },
        }
      : { id, method: "item/tool/call", params: { tool: "corgi" } };
  test(`${provider} delivers every large tool result, including ones waiting across a handoff`, async () => {
    const io = new Stdio(),
      client = make(io),
      lines = [1, 2, 3, 4, 5].map(request),
      texts = ["a", "b", "c", "d", "\0"].map(c => c.repeat(256 * 1024)),
      received: { id: number; text: string }[] = [];
    let called = 0;
    io.read = () => lines.splice(0);
    client.serve({ tools: [tool], call: async () => ({ text: texts[called++], failed: false }) });
    const drain = (io: Stdio) => {
      for (const line of io.output.toString().split("\n").filter(Boolean)) {
        const value = JSON.parse(line),
          reply = provider === "claude" ? value.response.response.mcp_response : value;
        received.push({ id: reply.id, text: (reply.result.content ?? reply.result.contentItems)[0].text });
      }
      io.output = Buffer.alloc(0);
    };
    client.take();
    await Bun.sleep(0);
    drain(io);
    expect(received).toHaveLength(3);
    const saved = client.save(true),
      restored = provider === "claude" ? Claude.restore(saved, true) : Codex.restore(saved, true);
    restored.serve({
      tools: [tool],
      call: async () => {
        throw Error("Do not rerun a finished command");
      },
    });
    restored.adopt();
    for (let i = 0; i < 3; i++) {
      restored.take();
      drain(restored.io);
    }
    expect(called).toBe(5);
    expect(received).toEqual(texts.map((text, i) => ({ id: i + 1, text })));
    client.close();
    restored.close();
  });
  test(`${provider} cancels a hosted tool when its process exits`, async () => {
    const io = new Stdio(),
      client = make(io),
      lines = [request(1)];
    let finish!: (r: Awaited<ReturnType<Host["call"]>>) => void, signal: AbortSignal | undefined;
    io.read = () => lines.splice(0);
    client.serve({
      tools: [tool],
      call: (_name, _input, abort) => {
        signal = abort;
        return new Promise(resolve => (finish = resolve));
      },
    });
    client.take();
    io.exited = true;
    client.take();
    expect(signal?.aborted).toBe(true);
    finish({ text: "finished after exit", failed: false });
    await Bun.sleep(0);
    expect(io.output.length).toBe(0);
    client.close();
  });
}
