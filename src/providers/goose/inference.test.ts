import { test, expect } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GooseInference } from "./inference";
/** A script standing in for `goose run`: invoked with `run -t <combined>`, it runs `body`. */
async function withScript(body: string, run: (path: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "corgi-goose-inference-"));
  try {
    const path = join(dir, "goose");
    writeFileSync(path, "#!/bin/sh\n" + body + "\n");
    chmodSync(path, 0o755);
    await run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
test("goose inference runs on prompt and reports turn end", async () => {
  await withScript('echo "args: $@"', async path => {
    const client = GooseInference.start(
      { cwd: "/tmp", account: "", executable: path },
      { instructions: "Summarize this", model: null, schema: null },
    );
    expect(client.processes?.() ?? []).toEqual([]);
    client.send({ kind: "prompt", text: "Conversation text" });
    await client.wait(Date.now() + 5000);
    const events = client.take();
    expect(events).toHaveLength(3);
    const [message, turn, ended] = events;
    if (message?.kind !== "message") throw new Error("expected first event to be a message");
    expect(message.text).toContain("-t");
    expect(message.text).toContain("--no-profile");
    expect(message.text).toContain("Summarize this");
    expect(message.text).toContain("Conversation text");
    expect(turn).toEqual({ kind: "turn", session: "", turn: "", phase: "ended", outcome: "completed" });
    expect(ended).toEqual({ kind: "ended" });
    client.close();
  });
});
test("goose inference reports failure when the run exits nonzero", async () => {
  await withScript("exit 1", async path => {
    const client = GooseInference.start(
      { cwd: "/tmp", account: "", executable: path },
      { instructions: "Summarize this", model: null, schema: null },
    );
    client.send({ kind: "prompt", text: "Conversation text" });
    await client.wait(Date.now() + 5000);
    expect(client.take()).toEqual([
      { kind: "turn", session: "", turn: "", phase: "ended", outcome: "failed" },
      { kind: "ended" },
    ]);
    client.close();
  });
});
test("goose inference runs again cleanly on a second prompt", async () => {
  await withScript('echo "args: $@"', async path => {
    const client = GooseInference.start(
      { cwd: "/tmp", account: "", executable: path },
      { instructions: "Summarize this", model: null, schema: null },
    );
    client.send({ kind: "prompt", text: "First" });
    await client.wait(Date.now() + 5000);
    expect(client.take().length).toBe(3);
    client.send({ kind: "prompt", text: "Second" });
    await client.wait(Date.now() + 5000);
    const events = client.take();
    expect(events).toHaveLength(3);
    const [message, turn, ended] = events;
    if (message?.kind !== "message") throw new Error("expected first event to be a message");
    expect(message.text).toContain("Summarize this");
    expect(message.text).toContain("Second");
    expect(turn).toEqual({ kind: "turn", session: "", turn: "", phase: "ended", outcome: "completed" });
    expect(ended).toEqual({ kind: "ended" });
    client.close();
  });
});
