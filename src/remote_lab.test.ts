import { expect, test } from "bun:test";
import { Local, Policy, Shaper } from "./remote_lab";

test("recurring hangs run on a start-to-start cadence and can be disabled mid-hang", () => {
  const policy = new Policy();
  policy.apply({ hang_seconds: 5, hang_every_seconds: 30 }, 1000);
  expect(policy.tick(30999)).toBe(false);
  expect(policy.tick(31000)).toBe(true);
  expect(policy.state.outage_until).toBe(36000);
  expect(policy.tick(36000)).toBe(false);
  expect(policy.tick(61000)).toBe(true);
  policy.apply({ hang_every_seconds: 0 }, 62000);
  expect(policy.tick(62000)).toBe(false);
  expect(policy.state.next_hang_at).toBe(0);
  expect(policy.tick(91000)).toBe(false);
});

test("manual outages overlap recurring hangs, and delayed ticks skip missed cycles", () => {
  const policy = new Policy();
  policy.apply({ hang_seconds: 5, hang_every_seconds: 30 }, 0);
  policy.apply({ outage_seconds: 10 }, 28000);
  expect(policy.tick(35000)).toBe(true);
  expect(policy.tick(38000)).toBe(false);
  expect(policy.tick(122000)).toBe(true);
  expect(policy.state.outage_until).toBe(125000);
  expect(policy.state.next_hang_at).toBe(150000);
  policy.apply({ hang_every_seconds: 0, outage_seconds: 0 }, 123000);
  expect(policy.tick(123000)).toBe(false);
});

test("a shaper holds bytes for the lag, keeps their order, and withholds them through an outage", async () => {
  const policy = new Policy();
  policy.apply({ latency_ms: 40 });
  const shaper = new Shaper(policy),
    out: string[] = [];
  shaper.on("data", (chunk: Buffer) => out.push(chunk.toString()));
  shaper.write("a");
  policy.apply({ latency_ms: 0 });
  shaper.write("b");
  await Bun.sleep(10);
  expect(out).toEqual([]);
  await Bun.sleep(50);
  expect(out).toEqual(["a", "b"]);
  policy.apply({ outage_seconds: 1 });
  shaper.write("c");
  await Bun.sleep(30);
  expect(out).toEqual(["a", "b"]);
  policy.apply({ outage_seconds: 0 });
  await Bun.sleep(150);
  expect(out).toEqual(["a", "b", "c"]);
  shaper.destroy();
});

test("turning a machine's faults on or off reconnects it, and only on puts shapers in its path", () => {
  const local = new Local(),
    dropped: string[] = [];
  const before = local.connect("work", () => dropped.push("before"));
  expect("up" in before).toBe(false);
  local.enable("work", true);
  expect(dropped).toEqual(["before"]);
  before.done();
  const during = local.connect("work", () => dropped.push("during"));
  expect("up" in during).toBe(true);
  local.connect("other", () => dropped.push("other"));
  local.apply({ machine: "work", latency_ms: 300 });
  expect(local.faults()).toEqual({ work: expect.objectContaining({ latency_ms: 300, accepted: 1 }) });
  local.apply({ machine: "work", drop: true });
  expect(dropped).toEqual(["before", "during"]);
  local.enable("work", false);
  expect(local.faults()).toEqual({});
});

test("a machine that forwards a socket drops its faults until a bridged connection", () => {
  const local = new Local();
  local.enable("old", true);
  local.forwards("old");
  expect(local.shapes("old")).toBe(false);
  expect(local.enabled("old")).toBe(false);
  local.connect("old", () => {}).done();
  expect(local.shapes("old")).toBe(true);
});
