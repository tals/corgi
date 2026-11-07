import { test, expect } from "bun:test";
import * as text from "./text";

test("clean strips fillers and keeps the rest as heard", () => {
  expect(text.clean("um, uh, let's add tests")).toBe("let's add tests");
  expect(text.clean(" Refactor the parser module.\n")).toBe("Refactor the parser module.");
  expect(text.clean("let's um add tests")).toBe("let's add tests");
  expect(text.clean("add tests, um.")).toBe("add tests.");
  expect(text.clean("Hmm.")).toBeNull();
  expect(text.clean("error handling")).toBe("error handling");
  expect(text.clean("ahead of time")).toBe("ahead of time");
});

test("clean drops non-speech markers and lone hallucinations", () => {
  expect(text.clean("[BLANK_AUDIO]")).toBeNull();
  expect(text.clean("(music)")).toBeNull();
  expect(text.clean("**laughs**")).toBeNull();
  expect(text.clean("♪ la la ♪")).toBeNull();
  for (const sound of ["*clap*", "*BEEP*", "*Mario plays*"]) expect(text.clean(sound)).toBeNull();
  // A sound beside speech leaves the speech.
  expect(text.clean("*BEEP* Okay.")).toBe("Okay.");
  expect(text.clean("Okay. *clap*")).toBe("Okay.");
  expect(text.clean("[music] let's go")).toBe("let's go");
  expect(text.clean("**laughs** sure")).toBe("sure");
  expect(text.clean("*clap* thank you")).toBeNull();
  // Spoken parentheses and arithmetic stay.
  expect(text.clean("add tests (unit only)")).toBe("add tests (unit only)");
  expect(text.clean("2 * 3 * 4")).toBe("2 * 3 * 4");
  expect(text.clean("Thank you.")).toBeNull();
  expect(text.clean("Um, thank you.")).toBeNull();
  expect(text.clean("Subtitles by the Amara.org community")).toBeNull();
  expect(text.clean("thank you for the fix")).toBe("thank you for the fix");
  expect(text.clean("   ")).toBeNull();
});

test("clean removes escape sequences and control characters", () => {
  expect(text.clean("\x1b[31mred\x1b[0m")).toBe("red");
  expect(text.clean("a\x1b[201~b\rc")).toBe("a b c");
  expect(text.clean("title\x1b]0;evil\x07 here")).toBe("title here");
  expect(text.clean("x\x9b2Jy\x00z")).toBe("x y z");
});
