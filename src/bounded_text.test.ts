import { test, expect } from "bun:test";
import { BoundedText, truncateUtf8 } from "./bounded_text";
test("exact, truncated and ascii values", () => {
  const T = BoundedText(4);
  expect(() => T.init("hello")).toThrow("TooLong");
  expect(T.initTruncated("hello").text()).toBe("hell");
  expect(T.initTruncated("abcé").text()).toBe("abc");
  expect(T.ascii("a\tb\x7f").text()).toBe("a b ");
  expect(truncateUtf8(Buffer.from([97, 255, 98]), 4)).toBe("a");
});
test("equal text compares equal whatever was stored before", () => {
  const T = BoundedText(8),
    built = T.initTruncated("ab");
  built.append("cdefgh");
  const direct = T.initTruncated("abcdefgh");
  expect(built).toEqual(direct);
  expect(T.initTruncated("ab")).toEqual(T.initTruncated("ab"));
});
test("JSON is a plain string and a value that does not fit is rejected", () => {
  const T = BoundedText(8),
    wire = JSON.stringify({ name: T.initTruncated("corgi") });
  expect(wire).toBe('{"name":"corgi"}');
  expect(T.fromJSON(JSON.parse(wire).name).text()).toBe("corgi");
  expect(() => T.fromJSON(JSON.parse('{"name":"nine bytes"}').name)).toThrow("LengthMismatch");
  expect(T.jsonParseFromValue(JSON.parse(wire).name).text()).toBe("corgi");
  expect(T.jsonParse('"corgi"').text()).toBe("corgi");
  expect(() => T.fromJSON({ name: "corgi" })).toThrow("UnexpectedToken");
});
test("exact byte strings retain invalid UTF-8 in numeric JSON arrays", () => {
  const T = BoundedText(8),
    bytes = Buffer.from([104, 105, 255]);
  const text = T.init(bytes);
  expect(text.len).toBe(3);
  expect(JSON.stringify(text)).toBe("[104,105,255]");
  expect(T.fromJSON([104, 105, 255]).toJSON()).toEqual([104, 105, 255]);
  expect(() => T.fromJSON([256])).toThrow("Overflow");
  expect(() => T.fromJSON([1.5])).toThrow("UnexpectedToken");
  expect(T.initTruncated("abcé").text()).toBe("abcé");
});
