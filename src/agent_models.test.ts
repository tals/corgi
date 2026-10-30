import { adapter } from "./providers";
import { Quit } from "./subprocess";
import { expect, test, spyOn } from "bun:test";
import { Picker, Cache, read, type Choice } from "./agent_models";
import { Rect } from "./layout";
import { Writer } from "./text";
import { Terminal } from "./pane/terminal";
test("model arrows wrap between Auto and the last model", () => {
  const p = new Picker("");
  p.received([
    { id: "one", name: "One" },
    { id: "two", name: "Two" },
  ]);
  p.sequence("\x1b[A");
  expect(p.key(13)).toEqual({ model: "two" });
  p.sequence("\x1b[B");
  expect(p.key(13)).toEqual({ model: "" });
});

test("Auto is available while loading and selecting it clears the override", () => {
  const p = new Picker("old-model");
  expect(p.choices()).toEqual([
    { id: "", name: "Auto (last chosen)" },
    { id: "old-model", name: "old-model" },
  ]);
  expect(p.key(13)).toEqual({ model: "old-model" });
  p.sequence("\x1b[A");
  expect(p.key(13)).toEqual({ model: "" });
  p.received([], true);
  expect(p.choices()[1].id).toBe("old-model");
  expect(p.key(27)).toBe("close");
});

test("native model choices filter by name or ID and scroll to the keyboard selection", () => {
  const p = new Picker("model-14"),
    b = p.bounds(new Rect(0, 0, 50, 22), { x: 35, y: 19 });
  p.received(Array.from({ length: 20 }, (_, i) => ({ id: `model-${i}`, name: `Choice ${i}` })));
  expect(p.key(13)).toEqual({ model: "model-14" });
  const w = new Writer();
  p.draw(w, b);
  const terminal = new Terminal(50, 22);
  try {
    terminal.feed(w.s);
    expect(terminal.text()).toContain("✓ Choice 14");
    expect(terminal.text()).toContain("╭");
  } finally {
    terminal.destroy();
  }
  expect(p.key(13)).toEqual({ model: "model-14" });
  for (const byte of Buffer.from("model-19")) p.key(byte);
  expect(p.key(13)).toEqual({ model: "model-19" });
  expect(p.click(b, 0, 0)).toBe("close");
});

test("prefetch shares in-flight reads, caches by account, and refreshes stale values without clearing them", async () => {
  let now = 0,
    reads = 0;
  const finish: ((values: Choice[]) => void)[] = [];
  const cache = new Cache(
    () => {},
    () => {
      reads++;
      return new Promise(resolve => finish.push(resolve));
    },
    () => now,
  );
  const first = cache.get("codex", ""),
    same = cache.get("codex", "");
  cache.get("claude", "/work");
  const queued = cache.get("claude", "/personal");
  expect(first).toBe(same);
  expect(reads).toBe(2);
  expect(queued.pending).toBe(true);
  finish.shift()!([{ id: "a", name: "A" }]);
  await Bun.sleep(0);
  expect(reads).toBe(3);
  expect(cache.get("codex", "").values).toEqual([{ id: "a", name: "A" }]);
  expect(cache.get("codex", "").pending).toBe(false);
  now = Cache.fresh_ms;
  expect(cache.get("codex", "").pending).toBe(true);
  expect(cache.get("codex", "").values[0].id).toBe("a");
  finish.shift()!([]);
  finish.shift()!([]);
  await Bun.sleep(0);
  expect(reads).toBe(4);
  finish.shift()!([{ id: "b", name: "B" }]);
  await Bun.sleep(0);
  expect(first.values).toEqual([{ id: "b", name: "B" }]);
});

test("failed catalogs back off, and loading glimmers beneath Auto without becoming a choice", async () => {
  let now = 0,
    reads = 0;
  const cache = new Cache(
    () => {},
    async () => {
      reads++;
      throw Error("offline");
    },
    () => now,
  );
  const entry = cache.get("codex", "");
  await Bun.sleep(0);
  expect(entry.failed).toBe(true);
  cache.get("codex", "");
  expect(reads).toBe(1);
  now = Cache.retry_ms;
  cache.get("codex", "");
  await Bun.sleep(0);
  expect(reads).toBe(2);
  const p = new Picker(""),
    b = new Rect(0, 0, 60, 14),
    a = new Writer(),
    z = new Writer(),
    terminal = new Terminal(60, 14);
  try {
    p.draw(a, b, 0);
    p.draw(z, b, 500);
    expect(a.s).not.toBe(z.s);
    terminal.feed(a.s);
    const lines = terminal.text().split("\n");
    expect(lines[3]).toContain("Auto (last chosen)");
    expect(lines[4]).toContain("Reading models…");
    expect(p.click(b, 8, 4)).toBeNull();
    expect(p.key(13)).toEqual({ model: "" });
  } finally {
    terminal.destroy();
  }
});

test("closing the viewer cancels active model readers and drops queued work", async () => {
  let reads = 0,
    notifications = 0;
  const cache = new Cache(
    () => notifications++,
    async (_provider, _account, quit) => {
      reads++;
      await new Promise<void>(resolve => quit.abortSignal.addEventListener("abort", () => resolve(), { once: true }));
      throw Error("Cancelled");
    },
  );
  cache.get("codex", "");
  cache.get("claude", "");
  cache.get("omp", "");
  cache.close();
  await Bun.sleep(0);
  cache.get("pi", "");
  expect(reads).toBe(2);
  expect(notifications).toBe(0);
});

test("effort is hidden until Edit; arrows wrap and Auto removes the override", () => {
  const p = new Picker("astra", "high");
  p.received([{ id: "astra", name: "Astra", efforts: ["low", "medium", "high", "xhigh"] }]);
  expect(p.editing).toBeNull();
  expect(p.key(13)).toEqual({ model: "astra", effort: "high" });
  p.sequence("\x1b[C");
  expect(p.editing?.id).toBe("astra");
  p.sequence("\x1b[B");
  expect(p.key(13)).toEqual({ model: "astra", effort: "xhigh" });
  p.sequence("\x1b[B");
  expect(p.key(13)).toEqual({ model: "astra" });
  expect(p.key(27)).toBeNull();
  expect(p.editing).toBeNull();
  expect(p.key(13)).toEqual({ model: "astra", effort: "high" });
});

test("clicking Edit opens effort and changing model does not reuse another model's effort", () => {
  const p = new Picker("astra", "high"),
    b = new Rect(0, 0, 62, 14);
  p.received([
    { id: "astra", name: "Astra", efforts: ["low", "high"] },
    { id: "other", name: "Other", efforts: ["low"] },
  ]);
  expect(p.click(b, 55, 5)).toBeNull();
  expect(p.editing?.id).toBe("astra");
  expect(p.click(b, 10, 4)).toEqual({ model: "astra", effort: "low" });
  p.key(27);
  p.sequence("\x1b[B");
  expect(p.key(13)).toEqual({ model: "other" });
});

test("effort labels sit on the right beside Edit, with native defaults when known", () => {
  const p = new Picker("astra", "high"),
    b = new Rect(0, 0, 62, 14),
    terminal = new Terminal(64, 16);
  p.received([
    { id: "astra", name: "Astra", efforts: ["low", "high"] },
    { id: "sol", name: "Sol", efforts: ["low", "high"], default_effort: "low" },
  ]);
  try {
    const w = new Writer();
    p.draw(w, b);
    terminal.feed(w.s);
    const rows = terminal.text().split("\n"),
      astra = rows.find(r => r.includes("Astra"))!,
      sol = rows.find(r => r.includes("Sol"))!;
    expect(astra).toMatch(/Astra +High  Edit ›/);
    expect(sol).toMatch(/Sol +Default \(Low\)  Edit ›/);
    expect(astra.indexOf("Edit")).toBe(sol.indexOf("Edit"));
    p.sequence("\x1b[B");
    p.sequence("\x1b[C");
    const edit = new Writer();
    p.draw(edit, b);
    terminal.feed(edit.s);
    expect(terminal.text()).toContain("Default (Low)");
  } finally {
    terminal.destroy();
  }
});

test("launcher discovery uses the read-only catalog rather than inference probes", async () => {
  const provider = adapter("opencode2"),
    catalog = spyOn(provider.launch, "models").mockResolvedValue([
      { id: "test/model", name: "Test model", subscription: true, input_cost: 0, output_cost: 0 },
    ]),
    inference = spyOn(provider.inference, "models").mockRejectedValue(Error("MustNotProbe"));
  try {
    expect(await read("opencode2", "", new Quit())).toEqual([{ id: "test/model", name: "Test model" }]);
    expect(catalog).toHaveBeenCalledTimes(1);
    expect(inference).not.toHaveBeenCalled();
  } finally {
    catalog.mockRestore();
    inference.mockRestore();
  }
});
