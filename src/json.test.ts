import { test, expect } from "bun:test";
import * as json from "./json";
test("json accessors read a missing or mistyped key as the default", () => {
  const v = json.parse('{"s":"x","n":-3,"u":7,"f":1.5,"b":true,"a":[1,2],"o":{"s":"y"},"e":"","t":"z"}');
  expect(json.str(v, "s")).toBe("x");
  for (const key of ["missing", "n"]) expect(json.str(v, key)).toBe("");
  expect(json.str(null, "s")).toBe("");
  expect(json.str(json.field(v, "o"), "s")).toBe("y");
  expect(json.field(v, "missing")).toBeNull();
  expect(json.uint(v, "u")).toBe(7);
  for (const key of ["n", "s", "missing"]) expect(json.uint(v, key)).toBeNull();
  expect(json.int(v, "n")).toBe(-3);
  for (const key of ["f", "missing"]) expect(json.int(v, key)).toBeNull();
  expect(json.float(v, "f")).toBe(1.5);
  expect(json.float(v, "u")).toBe(7);
  expect(json.float(v, "s")).toBeNull();
  expect(json.boolean(v, "b")).toBe(true);
  for (const key of ["s", "missing"]) expect(json.boolean(v, key)).toBe(false);
  expect(json.list(v, "a")).toHaveLength(2);
  expect(json.list(v, "o")).toHaveLength(0);
  expect(json.firstStr(v, ["missing", "e", "t", "s"])).toBe("z");
  expect(json.firstStr(v, ["missing", "e"])).toBe("");
});
test("json decode keeps defaults for missing and mistyped fields", () => {
  const { readers: r } = json,
    usage = { input: { default: 0, read: r.integer(64) }, output: { default: 0, read: r.integer(64) } };
  const shape = {
    type: { default: null, read: r.enum(["user", "assistant"] as const) },
    id: { default: "", read: r.string },
    count: { default: 9, read: r.integer(32) },
    ratio: { default: 0, read: r.float },
    live: { default: false, read: r.boolean },
    usage: { default: { input: 0, output: 0 }, read: r.object(usage) },
    raw: { default: null, read: r.raw },
  };
  expect(
    json.decode(
      shape,
      json.parse(
        '{"type":"system","id":5,"count":-1,"ratio":2,"live":true,"usage":{"input":3,"output":"x"},"raw":[1],"extra":1}',
      ),
    ),
  ).toEqual({ type: null, id: "", count: 9, ratio: 2, live: true, usage: { input: 3, output: 0 }, raw: [1] });
  const k = json.decode(shape, { type: "user", id: "a" });
  expect(k.type).toBe("user");
  expect(k.id).toBe("a");
  expect(k.count).toBe(9);
  expect(json.decode(shape, null).count).toBe(9);
});
