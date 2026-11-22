import { expect, test } from "bun:test";
import * as jobs from "./jobs";

const owner = {},
  other = {};
/** Work that counts to `to`, a step a tick, with a word of progress each. */
function counting(to: number, emit = true) {
  return async (job: jobs.Job) => {
    for (let i = 1; i <= to; i++) {
      await Bun.sleep(1);
      if (job.signal.aborted) throw job.signal.reason;
      job.progress({ at: i });
      if (emit) job.emit(i);
    }
    return "end";
  };
}

test("a job answers its start with its id and first news, then polls bring the rest once each", async () => {
  const all = new jobs.Jobs();
  const first = await all.begin(owner, counting(3), 50);
  expect(first.job).toBe(1);
  expect(first.results.length).toBeGreaterThan(0);
  const got = [...first.results];
  let news = first;
  while (!news.done) {
    news = { job: 1, ...(await all.poll(owner, 1, 50)) };
    got.push(...news.results);
  }
  expect(got).toEqual([1, 2, 3, "end"]);
  expect(news.progress).toEqual({ at: 3 });
  expect(news.error).toBeNull();
  // Its last news delivered, it's gone.
  expect(all.size).toBe(0);
  expect(all.poll(owner, 1)).rejects.toThrow("UnknownJob");
});

test("progress alone waits out the poll; a result or the end cuts it short", async () => {
  const all = new jobs.Jobs();
  const { job } = await all.begin(owner, counting(150, false));
  const started = performance.now();
  const quiet = await all.poll(owner, job, 60);
  expect(performance.now() - started).toBeGreaterThanOrEqual(50);
  expect(quiet.done).toBe(false);
  expect(quiet.results).toEqual([]);
  expect((quiet.progress as { at: number }).at).toBeGreaterThan(0);
  const last = await all.poll(owner, job, 2000);
  expect([last.done, last.results]).toEqual([true, ["end"]]);
});

test("a cancel, a lost connection or the daemon stopping ends a job, which its work sees", async () => {
  const all = new jobs.Jobs();
  const stops: string[] = [];
  const run = (job: jobs.Job) =>
    new Promise<void>((_, reject) =>
      job.signal.addEventListener("abort", () => {
        stops.push((job.signal.reason as Error).message);
        reject(job.signal.reason);
      }),
    );
  const a = await all.begin(owner, run),
    b = await all.begin(owner, run),
    c = await all.begin(other, run),
    d = await all.begin(other, run);
  all.cancel(owner, a.job);
  // Not the owner's to cancel.
  all.cancel(owner, c.job);
  expect(stops).toEqual(["Cancelled"]);
  all.drop(owner);
  expect(stops).toEqual(["Cancelled", "ConnectionClosed"]);
  expect(all.size).toBe(2);
  // A poll waiting on it hears that it ended.
  const waiting = all.poll(other, c.job, 2000);
  all.close();
  expect(stops).toEqual(["Cancelled", "ConnectionClosed", "ServerShutdown", "ServerShutdown"]);
  expect(await waiting).toMatchObject({ done: true, error: "ServerShutdown" });
  expect(all.size).toBe(0);
  expect(all.poll(owner, b.job)).rejects.toThrow("UnknownJob");
  expect(all.poll(other, d.job)).rejects.toThrow("UnknownJob");
});

test("a job nobody polls dies after the idle time, and one that fails says why", async () => {
  const all = new jobs.Jobs(20);
  const { job } = await all.begin(owner, () => new Promise(() => {}));
  await Bun.sleep(60);
  expect(all.size).toBe(0);
  expect(all.poll(owner, job)).rejects.toThrow("UnknownJob");
  const failed = await all.begin(
    owner,
    async () => {
      throw Error("EIO");
    },
    50,
  );
  expect(failed).toMatchObject({ done: true, error: "EIO", results: [] });
  const second = await all.poll(owner, job + 1, 2000).catch(error => error.message);
  expect(second).toBe("UnknownJob");
});

test("a viewer follows a job through its daemon, and an abort cancels it there", async () => {
  const all = new jobs.Jobs();
  const asked: string[] = [];
  const call: jobs.Call = async (op, payload) => {
    asked.push(op);
    if (op === "job.poll") return all.poll(owner, payload.job, payload.wait);
    all.cancel(owner, payload.job);
    return {};
  };
  const progress: unknown[] = [],
    results: unknown[] = [];
  await jobs.follow(call, () => all.begin(owner, counting(4), 0), {
    progress: p => progress.push(p),
    result: r => results.push(r),
    wait: 50,
  });
  expect(results).toEqual([1, 2, 3, 4, "end"]);
  expect(progress.at(-1)).toEqual({ at: 4 });
  expect(asked.filter(op => op === "job.poll").length).toBeGreaterThan(0);
  expect(asked).not.toContain("job.cancel");
  // Leaving partway through.
  const abort = new AbortController();
  const stops: unknown[] = [];
  const left = jobs.follow(
    call,
    () =>
      all.begin(owner, job => {
        job.signal.addEventListener("abort", () => stops.push((job.signal.reason as Error).message));
        return new Promise(() => {});
      }),
    { signal: abort.signal, wait: 2000 },
  );
  await Bun.sleep(5);
  abort.abort();
  expect(left).rejects.toThrow("Aborted");
  await Bun.sleep(5);
  expect(asked.at(-1)).toBe("job.cancel");
  expect(stops).toEqual(["Cancelled"]);
  expect(all.size).toBe(0);
  // Leaving before the start is answered: the job is cancelled once its id comes.
  const early = new AbortController();
  let answer!: () => void;
  const slow = jobs.follow(
    call,
    async () => {
      await new Promise<void>(resolve => (answer = resolve));
      return all.begin(owner, job => {
        job.signal.addEventListener("abort", () => stops.push((job.signal.reason as Error).message));
        return new Promise(() => {});
      });
    },
    { signal: early.signal, wait: 2000 },
  );
  early.abort();
  expect(slow).rejects.toThrow("Aborted");
  answer();
  await Bun.sleep(5);
  expect(stops).toEqual(["Cancelled", "Cancelled"]);
  expect(all.size).toBe(0);
  // A job that fails on the daemon fails the follow with its error.
  expect(
    jobs.follow(call, () =>
      all.begin(owner, async () => {
        throw Error("ENOENT");
      }),
    ),
  ).rejects.toThrow("ENOENT");
});
