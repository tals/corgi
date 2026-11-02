import { clone } from "../json";
import { n } from "../native_bridge";
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Pool } from "./harness";
import * as appServer from "../providers/codex/app_server";
import * as sim from "../providers/sim";
const fixture = resolve(import.meta.dir, "../../tests/inference_harness.ts");
function pool(provider: "codex" | "claude", timeout_ms = 3000) {
  return new Pool({ config: { provider, executable: fixture, timeout_ms } });
}
test("inference starts in the selected account and old handoffs default to the original account", async () => {
  const unregister = sim.register(),
    start = sim.adapter.inference.start;
  using p = new Pool({ config: { provider: sim.sim, account: "/private/pi-work" } });
  let account = "";
  sim.adapter.inference.start = (_request, place) => {
    account = place.account;
    throw Error("FixtureStop");
  };
  try {
    await expect(p.infer({ instructions: "Name a conversation", content: "request" })).rejects.toThrow("FixtureStop");
    expect(account).toBe("/private/pi-work");
    const saved = p.capture();
    delete (saved.config as Partial<typeof saved.config>).account;
    using restored = new Pool();
    restored.restore(saved);
    expect(restored.config.account).toBe("");
  } finally {
    sim.adapter.inference.start = start;
    unregister();
  }
});

test("inference reuses each harness conversation and keeps targets separate", async () => {
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
test("inference rotates retained histories and uses fresh recovery input", async () => {
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
test("inference rejects oversize output and recovers after failure", async () => {
  for (const provider of ["codex", "claude"] as const) {
    using p = pool(provider);
    await expect(p.infer({ instructions: "x", content: "oversize", conversation: "a" })).rejects.toThrow(
      "OutputTooLarge",
    );
    expect((await p.infer({ instructions: "x", content: "ok", conversation: "a" })).fresh).toBe(true);
  }
});
test("inference timeout destroys the failed conversation", async () => {
  using p = pool("codex", 150);
  await expect(p.infer({ instructions: "x", content: "hang" })).rejects.toThrow("Timeout");
  expect(p.slots.every(s => !s)).toBe(true);
});
test("Codex metadata reads its own app server, not a summary", async () => {
  const server = new appServer.AppServer(3000, fixture);
  try {
    expect((await appServer.model(server, "/tmp")).text()).toBe("fixture-codex");
    const info = await appServer.account(server);
    expect(info.account.text()).toBe("codex@example.com");
    expect(info.plan.text()).toBe("Pro 200");
    expect(await appServer.threads(server, null)).toMatchObject({ result: { data: [] } });
  } finally {
    server.close();
  }
});

test("closing an app server cancels a request still waiting for it to start", async () => {
  const server = new appServer.AppServer(3000, fixture);
  try {
    const pending = appServer.model(server, "/tmp");
    server.close();
    await expect(pending).rejects.toThrow("Cancelled");
    // Closing resets it; the next request opens it again.
    expect((await appServer.model(server, "/tmp")).text()).toBe("fixture-codex");
  } finally {
    server.close();
  }
});

test("closing an app server stops one still starting", async () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-app-server-")),
    started = join(root, "started"),
    executable = join(root, "codex");
  // A Codex that never answers initialize.
  writeFileSync(executable, `#!/bin/sh\n: > '${started}'\nexec /bin/sleep 60\n`, { mode: 0o755 });
  const server = new appServer.AppServer(30000, executable);
  try {
    const pending = appServer.model(server, "/tmp"),
      deadline = Date.now() + 2500;
    while (!existsSync(started) && Date.now() < deadline) await Bun.sleep(5);
    expect(existsSync(started)).toBe(true);
    const closed = Date.now();
    server.close();
    await expect(pending).rejects.toThrow("Cancelled");
    expect(Date.now() - closed).toBeLessThan(1000);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an error reply leaves the app server open", async () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-app-server-")),
    starts = join(root, "starts"),
    executable = join(root, "codex");
  writeFileSync(executable, `#!/bin/sh\necho "$$" >> '${starts}'\nexec '${process.execPath}' '${fixture}' "$@"\n`, {
    mode: 0o755,
  });
  const server = new appServer.AppServer(3000, executable);
  try {
    await expect(server.request("fixture/reject", {})).rejects.toThrow("HarnessRejected");
    expect((await appServer.model(server, "/tmp")).text()).toBe("fixture-codex");
    expect(readFileSync(starts, "utf8").trim().split("\n")).toHaveLength(1);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent metadata readers share one starting app server", async () => {
  const server = new appServer.AppServer(3000, fixture);
  try {
    const [first, second] = await Promise.all([appServer.model(server, "/tmp"), appServer.model(server, "/tmp")]);
    expect([first.text(), second.text()]).toEqual(["fixture-codex", "fixture-codex"]);
  } finally {
    server.close();
  }
});

test("a cancelled metadata request opens nothing", async () => {
  const server = new appServer.AppServer(3000, fixture);
  const abort = new AbortController();
  abort.abort();
  await expect(appServer.account(server, abort.signal)).rejects.toThrow("Cancelled");
  server.close();
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

test("inference failures kill the affected conversation and recover", async () => {
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
      for (const slot of saved.slots) {
        if (!slot) continue;
        slot.client.handles = slot.client.handles.map((fd: number) => n.probe_dup_above(fd, 3));
        for (const fd of slot.client.handles) expect(fd).toBeGreaterThanOrEqual(3);
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
  const pools = [pool("codex"), pool("codex"), pool("codex")];
  const open = (p: Pool, name: string) =>
    p.infer({ instructions: "Return JSON", content: "snapshot", conversation: name });
  try {
    // The summaries' four, worktree briefs' four, and two more.
    for (const [p, count] of [
      [pools[0], 4],
      [pools[1], 4],
      [pools[2], 2],
    ] as const)
      for (let i = 0; i < count; i++) await open(p, `${pools.indexOf(p)}-${i}`);
    await expect(open(pools[2], "2-2")).rejects.toThrow("TooManyHarnesses");
    expect(pools.reduce((n, p) => n + p.slots.filter(Boolean).length, 0)).toBe(10);
  } finally {
    for (const p of pools) p.close();
  }
});

test.skipIf(!process.env.CORGI_TEST_LIVE_INFERENCE)("opt-in live inference preserves a conversation", async () => {
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
});
