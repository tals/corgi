import { test, expect } from "bun:test";
import { quote, foregroundPid, tail } from "./tmux_resume";
test("restart suggestions preserve arguments and refuse shell input controls", () => {
  expect(quote(["tig", "a b", "a'b", "a\\b", "$(touch nope)", ""])).toBe(
    "tig a\\ b a\\'b a\\\\b \\$\\(touch\\ nope\\) ''",
  );
  for (const args of [["fish"], ["tig", "bad\rcommand"], ["tig", "bad\x1bcommand"]]) expect(quote(args)).toBe("");
  expect(foregroundPid(" 12 77\n 77 77\n", 12)).toBe(77);
  expect(foregroundPid("12 -1\n", 12)).toBe(null);
});
test("scrollback tail keeps recent complete lines within its wire budget", () => {
  expect(tail("old\nnew\n\n", 7)).toBe("new");
  expect(tail("new", 0)).toBe("");
  expect(tail("éé", 3)).toBe("é");
  expect(tail("one\ntwo", 12)).toBe("one\ntwo");
});
