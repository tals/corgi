import { clone } from "../json";
import { n } from "../native_bridge";
import { test, expect } from "bun:test";
import { resolve } from "node:path";
import { Pool } from "./harness";
const fixture = resolve(import.meta.dir, "../../tests/inference_harness.ts");
function pool(provider: "codex" | "claude", timeout_ms = 3000) {
  return new Pool({ config: { provider, executable: fixture, timeout_ms } });
}
test("native inference reuses each harness conversation and keeps targets separate", async () => {
  for (const provider of ["codex", "claude"] as const) {
    using p = pool(provider);
    const r = {
      instructions: "Return JSON",
      content: "snapshot",
      conversation: "pane-a",
    };
    const first = JSON.parse((await p.infer(r)).text()),
      second = JSON.parse((await p.infer(r)).text()),
      other = JSON.parse((await p.infer({ ...r, conversation: "pane-b" })).text());
    expect(first.pid).toBe(second.pid);
    expect(first.turn).toBe(1);
    expect(second.turn).toBe(2);
    expect(other.turn).toBe(1);
    const thirdResponse = await p.infer(r);
    expect(JSON.parse(thirdResponse.text()).turn).toBe(3);
    expect(p.system_usage.meter.value.tokens.total()).toBe(4040n);
    expect(p.system_usage.meter.value.tokens.cached_input).toBe(2400n);
    expect(thirdResponse.fresh).toBe(false);
    expect(thirdResponse.usage).toMatchObject({
      input: 1000n,
      cached_input: 600n,
      output: 10n,
    });
  }
});
test("native inference rotates retained histories and uses fresh recovery input", async () => {
  using p = pool("codex");
  const r = {
    instructions: "Return JSON",
    content: "live",
    fresh_content: "fresh",
    conversation: "a",
  };
  for (let i = 0; i < 32; i++) expect((await p.infer(r)).fresh).toBe(i === 0);
  expect((await p.infer(r)).fresh).toBe(true);
});
test("native inference rejects oversize output and recovers after failure", async () => {
  for (const provider of ["codex", "claude"] as const) {
    using p = pool(provider);
    await expect(p.infer({ instructions: "x", content: "oversize", conversation: "a" })).rejects.toThrow(
      "OutputTooLarge",
    );
    expect((await p.infer({ instructions: "x", content: "ok", conversation: "a" })).fresh).toBe(true);
  }
});
test("native inference timeout destroys the failed conversation", async () => {
  using p = pool("codex", 150);
  await expect(p.infer({ instructions: "x", content: "hang" })).rejects.toThrow("Timeout");
  expect(p.slots.every(s => !s)).toBe(true);
});
test("configured metadata creates no model turn", async () => {
  using p = pool("codex");
  expect((await p.configuredModel("/tmp")).text()).toBe("fixture-codex");
  const info = await p.configuredAccount();
  expect(info.account.text()).toBe("codex@example.com");
  expect(info.plan.text()).toBe("Pro 200");
  expect(await p.listThreads(null)).toMatchObject({ result: { data: [] } });
  expect(p.started).toBe(false);
});

test("closing a pool cancels a provider that is still initializing", async () => {
  using p = pool("codex");
  const pending = p.metadata();
  p.close();
  await expect(pending).rejects.toThrow("Cancelled");
  expect(p.slots.every(s => s === null)).toBe(true);
  // Closing resets a pool; changing providers may open it again.
  expect((await p.configuredModel("/tmp")).text()).toBe("fixture-codex");
});

test("concurrent metadata readers share one starting provider", async () => {
  using p = pool("codex");
  const [first, second] = await Promise.all([p.metadata(), p.metadata()]);
  expect(first).toBe(second);
  expect(p.slots.filter(Boolean)).toHaveLength(1);
});

test("cancelled metadata cannot restart a closed pool", async () => {
  using p = pool("codex");
  const abort = new AbortController();
  await p.configuredModel("/tmp", abort.signal);
  abort.abort();
  p.close();
  await expect(p.configuredAccount(abort.signal)).rejects.toThrow("Cancelled");
  expect(p.slots.every(s => s === null)).toBe(true);
});

test("fresh content replaces content only when the conversation starts", async () => {
  for (const provider of ["codex", "claude"] as const) {
    using p = pool(provider);
    const request = {
      instructions: "Return JSON",
      content: "oversize",
      fresh_content: "snapshot",
      conversation: "pane-a",
    };
    expect((await p.infer(request)).fresh).toBe(true);
    await expect(p.infer(request)).rejects.toThrow("OutputTooLarge");
    expect((await p.infer(request)).fresh).toBe(true);
  }
});

test("fresh Codex histories reuse the process and rotated histories are bounded", async () => {
  using p = pool("codex");
  const request = { instructions: "Return JSON", content: "snapshot" };
  const first = JSON.parse((await p.infer(request)).text());
  const second = JSON.parse((await p.infer(request)).text());
  expect(first.pid).toBe(second.pid);
  expect(second.turn).toBe(1);
  for (let i = 0; i < 5; i++) await p.infer({ ...request, conversation: `pane-${i}` });
  expect(JSON.parse((await p.infer({ ...request, conversation: "pane-0" })).text()).turn).toBe(1);
  expect(p.system_usage.meter.value.tokens.total()).toBe(8080n);
});

test("structured inference uses provider output and rejects invalid schemas before launch", async () => {
  using p = pool("claude");
  const response = await p.infer({
    instructions: "Return a label",
    content: "snapshot",
    schema: JSON.stringify({
      type: "object",
      properties: { label: { type: "string" } },
      required: ["label"],
    }),
  });
  expect(response.text()).toBe('{"label":"Tracing pane focus"}');
  await expect(
    p.infer({
      instructions: "Return JSON",
      content: "snapshot",
      schema: "[]",
    }),
  ).rejects.toThrow("InvalidSchema");
});

test("native inference failures kill the affected conversation and recover", async () => {
  for (const provider of ["codex", "claude"] as const) {
    using p = pool(provider);
    for (const content of ["crash", "fail", "oversize"]) {
      await expect(
        p.infer({
          instructions: "Return JSON",
          content,
          conversation: "same",
        }),
      ).rejects.toThrow();
      const recovered = JSON.parse(
        (
          await p.infer({
            instructions: "Return JSON",
            content: "snapshot",
            conversation: "same",
          })
        ).text(),
      );
      expect(recovered.turn).toBe(1);
    }
    p.config.timeout_ms = 200;
    await expect(
      p.infer({
        instructions: "Return JSON",
        content: "hang",
        conversation: "same",
      }),
    ).rejects.toThrow("Timeout");
    await expect(
      p.infer({ instructions: "Return JSON", content: "snapshot" }, {
        value: true,
      } as any),
    ).rejects.toThrow("Cancelled");
  }
});

test("live inference checkpoint continues the same process and conversation", async () => {
  for (const provider of ["codex", "claude"] as const) {
    const p = pool(provider);
    const imported = new Pool();
    try {
      const request = {
        instructions: "Return JSON",
        content: "snapshot",
        conversation: "reload",
      };
      const first = JSON.parse((await p.infer(request)).text());
      const saved = clone(p.capture());
      for (const connection of saved.slots) {
        if (!connection) continue;
        connection.stdin = n.probe_dup_above(connection.stdin, 3);
        connection.stdout = n.probe_dup_above(connection.stdout, 3);
        expect(connection.stdin).toBeGreaterThanOrEqual(3);
        expect(connection.stdout).toBeGreaterThanOrEqual(3);
      }
      imported.restore(saved);
      const second = JSON.parse((await imported.infer(request)).text());
      expect(second.pid).toBe(first.pid);
      expect(second.turn).toBe(2);
      expect(imported.system_usage.meter.value.tokens.total()).toBe(2020n);
    } finally {
      imported.close();
      p.close();
    }
  }
});

test("harnesses from every pool share one cap", async () => {
  const first = pool("codex");
  const second = pool("codex");
  try {
    for (let i = 0; i < 4; i++)
      await first.infer({
        instructions: "Return JSON",
        content: "snapshot",
        conversation: `first-${i}`,
      });
    for (let i = 0; i < 2; i++)
      await second.infer({
        instructions: "Return JSON",
        content: "snapshot",
        conversation: `second-${i}`,
      });
    await expect(
      second.infer({
        instructions: "Return JSON",
        content: "snapshot",
        conversation: "second-2",
      }),
    ).rejects.toThrow("TooManyHarnesses");
    expect(first.slots.filter(Boolean).length + second.slots.filter(Boolean).length).toBe(6);
  } finally {
    first.close();
    second.close();
  }
});

test.skipIf(!process.env.CORGI_TEST_LIVE_INFERENCE)(
  "opt-in live native inference preserves a conversation",
  async () => {
    const provider = process.env.CORGI_TEST_LIVE_INFERENCE;
    if (provider !== "codex" && provider !== "claude") throw Error("InvalidProvider");
    const p = new Pool({
      config: {
        provider,
        model: process.env.CORGI_INFERENCE_MODEL,
        timeout_ms: 60000,
      },
    });
    try {
      const instructions = "Reply only with the requested single word. Do not use tools.";
      const first = await p.infer({
        instructions,
        content: "Remember the word Marigold. Reply with that word.",
        conversation: "live-test",
      });
      expect(first.text().trim().replace(/\.$/, "")).toBe("Marigold");
      const second = await p.infer({
        instructions,
        content: "What word did I ask you to remember? Reply with it.",
        conversation: "live-test",
      });
      expect(second.text().trim().replace(/\.$/, "")).toBe("Marigold");
    } finally {
      p.close();
    }
  },
);
