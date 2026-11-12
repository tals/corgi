import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Live } from "./live";
import type { LiveEvent } from "./live_events";
import { fallback, type Port, serve, View } from "./live_worker";
import * as term from "./term";

const plain = (text: string) => Bun.stripANSI(text);
const none = { totalMs: null, leftMs: null, aheadMs: null, last: null };
const begin = (o: Partial<Extract<LiveEvent, { t: "begin" }>> = {}): LiveEvent => ({
  t: "begin",
  command: "rebuild",
  branch: "integration",
  upstream: { name: "upstream/main", tip: "170454d", newCommits: 7 },
  stages: ["fetch", "merge", "verify"],
  items: { merge: ["left", "right"], verify: ["install", "typecheck", "test", "build"] },
  estimate: none,
  links: {},
  harness: null,
  harnessMedianMs: null,
  elapsedMs: 0,
  ...o,
});
const end = (o: Partial<Extract<LiveEvent, { t: "end" }>> = {}): Extract<LiveEvent, { t: "end" }> => ({
  t: "end",
  ok: true,
  code: 0,
  headline: "built dist/corgi-custom on upstream 170454d with 2 patches",
  lines: ["  report: /tmp/reports/1/report.md"],
  report: "/tmp/reports/1/report.md",
  ...o,
});

test("inline live renders frames and ends with the card", async () => {
  let out = "";
  const live = Live.start({
    inline: { write: s => void (out += s), rows: 30, cols: 100 },
    verbose: false,
    color: true,
  });
  live.sink(begin());
  live.sink({ t: "stage", stage: "fetch", state: "start" });
  await live.end(end());
  const hidden = out.indexOf("\x1b[?25l"),
    headline = out.indexOf("built dist/corgi-custom");
  expect(hidden).toBeGreaterThanOrEqual(0);
  expect(plain(out)).toContain("custom-build rebuild");
  expect(plain(out)).toContain("✓ built dist/corgi-custom on upstream 170454d with 2 patches");
  expect(plain(out)).toContain("  report: /tmp/reports/1/report.md");
  expect(hidden).toBeLessThan(headline);
  expect(out.lastIndexOf("\x1b[?25h")).toBeGreaterThan(headline);
  expect(out).toEndWith(term.restore());
});

test("a sink never throws, even after the end", async () => {
  const live = Live.start({
    inline: {
      write: () => {
        throw Error("closed");
      },
      rows: 30,
      cols: 100,
    },
    verbose: false,
    color: true,
  });
  expect(() => live.sink(begin())).not.toThrow();
  await live.end(end());
  expect(() => live.sink({ t: "log", text: "late\n" })).not.toThrow();
});

test("the run's own end is kept for the card", async () => {
  const live = Live.start({ inline: { write: () => {}, rows: 30, cols: 100 }, verbose: false, color: false });
  expect(live.received).toBeNull();
  live.sink(begin());
  live.sink(end({ activeMs: 5000 }));
  expect(live.received).toMatchObject({ t: "end", activeMs: 5000 });
  await live.end(live.received!);
});

test("a question suspends the view before it is asked and resumes after", async () => {
  let out = "";
  const live = Live.start({
    inline: { write: s => void (out += s), rows: 30, cols: 100 },
    verbose: false,
    color: true,
  });
  live.sink(begin());
  const answer = live.ask("Force-push 1 rebased branch to origin (mine)? [y/N] ", q => ((out += q), "n"));
  expect(answer).toBe("n");
  // The last: the notification before it names the question too.
  const asked = out.lastIndexOf("Force-push");
  expect(out.lastIndexOf("\x1b[?25h", asked)).toBeGreaterThanOrEqual(0);
  expect(out.slice(0, asked)).toContain(
    term.notify("custom-build: Force-push 1 rebased branch to origin (mine)? [y/N] (waiting)"),
  );
  live.sink({ t: "stage", stage: "fetch", state: "start" });
  await live.end(end());
  expect(out.indexOf("\x1b[?25l", asked)).toBeGreaterThan(asked);
});

test("verbose keeps the question and the answer for the log it replays", async () => {
  let out = "";
  const live = Live.start({
    inline: { write: s => void (out += s), rows: 30, cols: 100 },
    verbose: true,
    color: false,
  });
  live.sink(begin());
  live.sink({ t: "log", text: "custom-build: fetching upstream main\n" });
  live.ask("Push? [y/N] ", () => "y");
  await live.end(end());
  const replay = out.slice(out.lastIndexOf("\x1b[H"));
  expect(replay).toContain("custom-build: fetching upstream main\nPush? [y/N] \ny\n");
});

test("verbose falls back to the inline layout on a short terminal", async () => {
  let out = "";
  const live = Live.start({
    inline: { write: s => void (out += s), rows: 11, cols: 100 },
    verbose: true,
    color: false,
  });
  live.sink(begin());
  await live.end(end());
  expect(out).not.toContain("\x1b[r\x1b[H");
  expect(out).not.toMatch(/\x1b\[\d+;\d+r/);
});

/** A view at a fake clock, writing into `out`. */
function view(o: { verbose?: boolean; rows?: number } = {}) {
  const out: string[] = [],
    clock = { now: 1_000_000 };
  const v = new View({
    write: s => out.push(s),
    rows: () => o.rows ?? 30,
    cols: () => 100,
    verbose: o.verbose ?? false,
    color: true,
    now: () => clock.now,
  });
  return { v, out, clock, all: () => out.join("") };
}

test("a view on 24 rows draws a frame that fits, footer and running item included", () => {
  const ids = Array.from({ length: 12 }, (_, i) => `patch-${i + 1}`);
  for (const verbose of [false, true]) {
    const { v, out } = view({ rows: 24, verbose });
    v.event(begin({ items: { merge: ids, verify: ["install", "typecheck", "test", "build"] } }));
    v.event({ t: "stage", stage: "merge", state: "start" });
    for (const id of ids.slice(0, 8)) {
      v.event({ t: "item", stage: "merge", id, state: "start" });
      v.event({ t: "item", stage: "merge", id, state: "done", outcome: "merged" });
    }
    v.event({ t: "item", stage: "merge", id: "patch-9", state: "start" });
    v.tick();
    const raw = out.at(-1)!,
      drawn = plain(raw);
    expect(drawn).toContain("✦ harness");
    expect(drawn).toContain("↻ retries");
    expect(drawn).toMatch(/patch-9 /);
    // Inline every line ends in a newline; pinned every line is placed on its row.
    const lines = verbose ? raw.split(/\x1b\[\d+;1H\x1b\[2K/).length - 1 : raw.split("\n").length - 1;
    expect(lines).toBeGreaterThan(10);
    expect(lines).toBeLessThanOrEqual(verbose ? 19 : 23);
  }
});

test("tab progress follows the estimate, or the stages done without one", () => {
  const timed = view();
  timed.v.event(begin({ estimate: { totalMs: 100_000, leftMs: 100_000, aheadMs: null, last: null } }));
  timed.clock.now += 25_000;
  timed.v.tick();
  expect(timed.all()).toContain(term.tabProgress("on", 25));

  const counted = view();
  counted.v.event(begin());
  counted.v.event({ t: "stage", stage: "fetch", state: "start" });
  counted.v.event({ t: "stage", stage: "fetch", state: "done" });
  counted.clock.now += 1000;
  counted.v.tick();
  expect(counted.all()).toContain(term.tabProgress("on", 33));
});

test("a stop sets the tab's error state, and the end clears it", () => {
  const { v, all } = view();
  v.event(begin());
  v.event({ t: "item", stage: "merge", id: "right", state: "failed", outcome: "stopped" });
  v.finish(end({ ok: false, code: 2, headline: "stopped: merge conflict in right", lines: [] }));
  const text = all();
  expect(text).toContain("\x1b]9;4;2;");
  expect(text.lastIndexOf(term.tabProgress("off"))).toBeGreaterThan(text.indexOf("\x1b]9;4;2;"));
});

test("the end notifies only after more than a minute of this invocation", () => {
  const quick = view();
  quick.v.event(begin({ elapsedMs: 300_000 }));
  quick.v.finish(end({ activeMs: 300_000 + 60_000 }));
  expect(quick.all()).not.toContain("\x1b]9;custom-build");

  const slow = view();
  slow.v.event(begin({ elapsedMs: 300_000 }));
  slow.v.finish(end({ activeMs: 300_000 + 61_000 }));
  expect(slow.all()).toContain(
    term.notify("custom-build: built dist/corgi-custom on upstream 170454d with 2 patches in 6:01"),
  );

  const stopped = view();
  stopped.v.event(begin());
  stopped.clock.now += 90_000;
  stopped.v.finish(end({ ok: false, code: 2, headline: "stopped: merge conflict in right", lines: [] }));
  expect(stopped.all()).toContain(term.notify("custom-build stopped: merge conflict in right"));
});

test("redraws at most every 100 ms", () => {
  const { v, out, clock } = view();
  v.event(begin());
  const frames = () => out.filter(s => s.startsWith(term.sync(true))).length,
    first = frames();
  v.event({ t: "stage", stage: "fetch", state: "start" });
  v.event({ t: "log", text: "custom-build: fetching\n" });
  expect(frames()).toBe(first);
  clock.now += 100;
  v.tick();
  expect(frames()).toBe(first + 1);
  clock.now += 100;
  v.event({ t: "stage", stage: "fetch", state: "done" });
  expect(frames()).toBe(first + 2);
});

test("an end without a begin shows the outcome as a card", () => {
  const { v, all } = view();
  v.finish(end({ ok: false, code: 1, headline: "a run is stopped or in progress", lines: [], report: null }));
  expect(plain(all())).toContain("✗ a run is stopped or in progress\n");
});

test("restore sequence is written on exit", () => {
  const live = join(import.meta.dir, "live.ts");
  const script = `
    const { Live } = await import(${JSON.stringify(live)});
    const live = Live.start({ verbose: false, color: true });
    live.sink(${JSON.stringify(begin())});
    await Bun.sleep(300);
    process.exit(130);
  `;
  const p = Bun.spawnSync(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const out = p.stdout.toString();
  expect(p.exitCode).toBe(130);
  expect(plain(out)).toContain("custom-build rebuild");
  expect(out).toEndWith(term.restore());
});

test("a signal with no other listener restores the terminal and exits like the harness does", async () => {
  const live = join(import.meta.dir, "live.ts");
  const script = `
    const { Live } = await import(${JSON.stringify(live)});
    const live = Live.start({ verbose: false, color: true });
    live.sink(${JSON.stringify(begin())});
    console.error("ready");
    await Bun.sleep(10_000);
  `;
  const p = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const reader = p.stderr.getReader();
  while (!new TextDecoder().decode((await reader.read()).value).includes("ready"));
  await Bun.sleep(200);
  p.kill("SIGINT");
  const [code, out] = await Promise.all([p.exited, new Response(p.stdout).text()]);
  expect(code).toBe(130);
  expect(plain(out)).toContain("custom-build rebuild");
  expect(out).toEndWith(term.restore());
});

test("signal listeners exist only while a terminal view is live", () => {
  const live = join(import.meta.dir, "live.ts");
  // In its own process: the worker draws on that process's stdout.
  const script = `
    const { Live } = await import(${JSON.stringify(live)});
    const count = () => ["SIGINT", "SIGTERM", "SIGHUP", "exit"].map(s => process.listenerCount(s));
    const counts = [count()];
    const inline = Live.start({ inline: { write: () => {}, rows: 30, cols: 100 }, verbose: false, color: true });
    counts.push(count());
    await inline.end(${JSON.stringify(end())});
    const live = Live.start({ verbose: false, color: false });
    counts.push(count());
    await live.end(${JSON.stringify(end())});
    counts.push(count());
    console.error(JSON.stringify(counts));
  `;
  const p = Bun.spawnSync(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
  expect(p.exitCode).toBe(0);
  const [before, withInline, withWorker, after] = JSON.parse(p.stderr.toString()) as number[][];
  expect(withInline).toEqual(before);
  expect(withWorker).toEqual(before.map(n => n + 1));
  expect(after).toEqual(before);
});

const failing = () => {
  throw Error("card failed");
};
test("a card that fails is replaced by the restore and the plain outcome", async () => {
  let out = "";
  const live = Live.start({
    inline: { write: s => void (out += s), rows: 30, cols: 100, card: failing },
    verbose: false,
    color: true,
  });
  live.sink(begin());
  const e = end({ lines: ["  push: git push origin mine", "  report: /tmp/reports/1/report.md"] });
  await live.end(e);
  expect(out).toEndWith(
    `${term.restore()}\ncustom-build: built dist/corgi-custom on upstream 170454d with 2 patches\n  push: git push origin mine\n  report: /tmp/reports/1/report.md\n`,
  );
  expect(out).toEndWith(fallback(e, null));
});

test("the worker reports a card that failed, and one that didn't", async () => {
  for (const [card, ok] of [
    [failing, false],
    [undefined, true],
  ] as const) {
    const posted: unknown[] = [],
      port = { postMessage: m => void posted.push(m) } as Port;
    serve(port, o => new View({ ...o, write: () => {}, wait: async () => {}, ...(card ? { card } : {}) }));
    const send = (m: unknown) => port.onmessage({ data: m } as MessageEvent);
    await send({ t: "init", shared: new SharedArrayBuffer(12), verbose: false, color: true });
    await send({ t: "event", e: begin(), at: Date.now() });
    await send({ t: "finish", e: end() });
    expect(posted).toEqual([{ t: "finished", ok }]);
  }
});

test("a worker whose card failed leaves the plain outcome after the restore", () => {
  const dir = mkdtempSync(join(tmpdir(), "live-test-")),
    fake = join(dir, "worker.ts");
  writeFileSync(
    fake,
    `self.onmessage = ({ data }) => { if (data.t === "finish") postMessage({ t: "finished", ok: false }); };\n`,
  );
  const live = join(import.meta.dir, "live.ts"),
    e = end();
  const script = `
    const { Live } = await import(${JSON.stringify(live)});
    const live = Live.start({ verbose: false, color: true, script: new URL(${JSON.stringify(pathToFileURL(fake).href)}) });
    live.sink(${JSON.stringify(begin())});
    await live.end(${JSON.stringify(e)});
    console.error(process.listenerCount("exit"));
  `;
  const p = Bun.spawnSync(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
  expect(p.exitCode).toBe(0);
  expect(p.stdout.toString()).toBe(fallback(e, null));
  expect(p.stderr.toString().trim()).toBe("0");
});

test("an end without a begin names its report once", () => {
  const { v, all } = view();
  v.finish(end({ ok: false, code: 2, headline: "stopped", lines: ["  report: /tmp/reports/1/report.md"] }));
  expect(plain(all()).split("/tmp/reports/1/report.md").length).toBe(2);
  expect(plain(all())).toContain("   report  /tmp/reports/1/report.md\n");
});

test("an interrupted git call under a live view stops there and restores the terminal", () => {
  const script = `
    const { Live } = await import(${JSON.stringify(join(import.meta.dir, "live.ts"))});
    const git = await import(${JSON.stringify(join(import.meta.dir, "git.ts"))});
    const live = Live.start({ verbose: false, color: true });
    live.sink(${JSON.stringify(begin())});
    await Bun.sleep(200);
    git.git(process.cwd(), ["-c", "alias.boom=!kill -INT $PPID", "boom"]);
    console.error("went on");
  `;
  const p = Bun.spawnSync(["bun", "-e", script], { stdout: "pipe", stderr: "pipe", cwd: import.meta.dir });
  expect(p.exitCode).toBe(130);
  expect(p.stderr.toString()).not.toContain("went on");
  expect(p.stdout.toString()).toEndWith(term.restore());
});

test("a run that fully succeeded ends with fireworks above its card; any other ends at once", async () => {
  const show = async (o: { finale?: boolean; color?: boolean; e?: Partial<Extract<LiveEvent, { t: "end" }>> }) => {
    let out = "",
      frames = 0;
    const view = new View({
      write: s => void (out += s),
      rows: () => 40,
      cols: () => 80,
      verbose: false,
      color: o.color ?? true,
      finale: o.finale ?? true,
      wait: async () => void frames++,
    });
    view.event(begin(), 0);
    await view.finishShow(end(o.e));
    return { frames, out: out.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, "") };
  };
  const shown = await show({});
  expect(shown.frames).toBeGreaterThan(10);
  // The embers stay above the card.
  const card = shown.out.slice(shown.out.lastIndexOf("✓ built"));
  expect(shown.out.slice(0, shown.out.lastIndexOf("✓ built"))).toMatch(/✧[^│]*$/);
  expect(card).toContain("report");
  for (const o of [{ finale: false }, { color: false }, { e: { ok: false, code: 3, headline: "stopped" } }])
    expect((await show(o)).frames).toBe(0);
});
