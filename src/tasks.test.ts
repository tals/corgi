import { expect, test } from "bun:test";
import { transport } from "./fixtures/transport";
import { Tasks } from "./tasks";

/** A daemon whose replies wait until the test lets each one go. */
function slow() {
  const sent: string[] = [];
  const replies = new Map<string, () => void>();
  const daemon = transport(async op => {
    sent.push(op);
    await new Promise<void>(resolve => replies.set(op, resolve));
    return { ok: true };
  });
  return { daemon, sent, replies };
}

test("tasks start at once, in order, and a slow one holds up no other", async () => {
  const { daemon, sent, replies } = slow();
  const failures: unknown[] = [];
  const tasks = new Tasks(
    () => daemon,
    error => failures.push(error),
  );
  const done: string[] = [];
  tasks.start(async lane => {
    await lane.call("ping");
    done.push("ping");
  });
  tasks.start(async lane => {
    await lane.call("hello");
    done.push("hello");
  });
  // Both requests went out in the order asked, before either reply.
  expect(sent).toEqual(["ping", "hello"]);
  replies.get("hello")!();
  await Bun.sleep(0);
  expect(done).toEqual(["hello"]);
  replies.get("ping")!();
  await tasks.idle();
  expect(done).toEqual(["hello", "ping"]);
  expect(failures).toEqual([]);
});

test("a failed task is reported, never thrown at the caller, and the rest carry on", async () => {
  const failures: string[] = [];
  const daemon = transport(async op => (op === "ping" ? { err: "NoPane" } : { ok: true }));
  const tasks = new Tasks(
    () => daemon,
    error => failures.push((error as Error).message),
  );
  let after = false;
  tasks.start(async lane => {
    await lane.call("ping");
  });
  const finished = tasks.run(async lane => {
    await lane.call("hello");
    after = true;
  });
  await finished;
  await tasks.idle();
  expect(failures).toEqual(["NoPane"]);
  expect(after).toBe(true);
});

test("idle waits for tasks that other tasks started", async () => {
  const daemon = transport(async () => ({ ok: true }));
  const tasks = new Tasks(
    () => daemon,
    () => {},
  );
  const done: string[] = [];
  tasks.start(async lane => {
    await lane.call("ping");
    tasks.start(async lane => {
      await lane.call("hello");
      done.push("inner");
    });
  });
  await tasks.idle();
  expect(done).toEqual(["inner"]);
});
