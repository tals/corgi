import { expect, test } from "bun:test";
import * as logSyntax from "./log_syntax";

const marked = (line: string) => logSyntax.spans(line).map(([s, e, k]) => [line.slice(s, e), k]);

test("colors a log line's time, level, fields, strings and numbers", () => {
  expect(marked('2026-11-08T14:02:32.004Z ERROR saved-state write failed err="ENOSPC" ms=12')).toEqual([
    ["2026-11-08T14:02:32.004Z", "comment"],
    ["ERROR", "error"],
    ["err", "property"],
    ['"ENOSPC"', "string"],
    ["ms", "property"],
    ["12", "number"],
  ]);
  expect(marked("[14:02:31.904] WARN  review spans slow lines=2924")).toEqual([
    ["[14:02:31.904]", "comment"],
    ["WARN", "warn"],
    ["lines", "property"],
    ["2924", "number"],
  ]);
  expect(marked("Nov  8 14:02:31 host sshd[812]: info: accepted")).toEqual([
    ["Nov  8 14:02:31", "comment"],
    ["812", "number"],
    ["info", "info"],
  ]);
});

test("finds levels as fields, in brackets and in JSON", () => {
  expect(logSyntax.levelOf("time=1 level=error msg=boom")).toBe("error");
  expect(logSyntax.levelOf("[debug] cache warm")).toBe("debug");
  expect(logSyntax.levelOf('{"level":"warn","msg":"slow"}')).toBe("warn");
  // A level word in the message's middle, past the head, isn't the line's.
  expect(logSyntax.levelOf("x".repeat(120) + " ERROR")).toBeNull();
  expect(logSyntax.levelOf("the error was handled")).toBe("error");
});

test("leaves apostrophes in prose alone", () => {
  expect(marked("can't open it, won't retry")).toEqual([]);
  expect(marked("got 'quoted' 3 times")).toEqual([
    ["'quoted'", "string"],
    ["3", "number"],
  ]);
});

test("takes a long word in time that grows with it, not with its square", () => {
  const line = `INFO token=${"a".repeat(1 << 20)} rows=48`;
  const started = performance.now();
  expect(marked(line).map(([, kind]) => kind)).toEqual(["info", "property", "property", "number"]);
  expect(performance.now() - started).toBeLessThan(200);
});
