import { expect, test } from "bun:test";
import type { Config } from "./config";
import { command, failedAgain, failureSummary, testFailures } from "./steps";

const config = (test?: string[]) =>
  ({ version: 1, branch: "custom", patches: [], steps: test ? { test } : {} }) as unknown as Config;
const vars = { outfile: "dist/out" };
const bunLog = [
  "$ bun test src",
  "src/bindings.test.ts:",
  "(pass) a preset loads [0.20ms]",
  "(fail) no preset binds a key twice [0.61ms]",
  "",
  "src/release.test.ts:",
  "(fail) an installed release runs the current release [60001.00ms]",
  "  ^ this test timed out after 60000ms.",
  "src/voice/link.test.ts:",
  "(fail) heartbeats renew the presence > on the watch connection [0.55ms]",
  "",
  "3 tests failed:",
  "(fail) no preset binds a key twice [0.61ms]",
  "(fail) an installed release runs the current release [60001.00ms]",
  "(fail) heartbeats renew the presence > on the watch connection [0.55ms]",
  "",
  " 10 pass",
  " 3 fail",
  "Ran 13 tests across 3 files. [61.00s]",
].join("\n");

test("failed tests carry their file and whether they timed out; bun's closing summary is skipped", () => {
  expect(testFailures(bunLog)).toEqual([
    { file: "src/bindings.test.ts", name: "no preset binds a key twice", timedOut: false },
    { file: "src/release.test.ts", name: "an installed release runs the current release", timedOut: true },
    {
      file: "src/voice/link.test.ts",
      name: "heartbeats renew the presence > on the watch connection",
      timedOut: false,
    },
  ]);
  expect(testFailures("$ bun test src\n 5 pass\n")).toEqual([]);
});

test("a failure summary names the failing tests and counts timeouts apart", () => {
  expect(failureSummary("test", bunLog)).toBe(
    "2 tests fail in 2 files (no preset binds a key twice, heartbeats renew the presence > on the watch connection); 1 timed out",
  );
  const one = bunLog.split("src/release.test.ts:")[0];
  expect(failureSummary("test", one)).toBe("1 test fails in src/bindings.test.ts (no preset binds a key twice)");
  expect(
    failureSummary(
      "typecheck",
      "src/voice/main.ts(187,55): error TS2353: …\nsrc/voice/tuning.ts(54,5): error TS2741: …\nsrc/voice/tuning.ts(97,5): error TS7053: …\n",
    ),
  ).toBe("3 type errors in src/voice/main.ts, src/voice/tuning.ts");
  expect(failureSummary("install", "error: lockfile had changes")).toBeNull();
  expect(failureSummary("test", "segfault")).toBeNull();
});

test("a failed test run is run again on only its failing files, when the command says where", () => {
  expect(command("test", config(), vars)).toEqual(["bun", "test", "src"]);
  expect(failedAgain("test", config(), vars, bunLog)).toEqual([
    ["bun", "build.ts", "--native-only"],
    ["bun", "test", "src/bindings.test.ts", "src/release.test.ts", "src/voice/link.test.ts"],
  ]);
  // A configured command runs again narrowed only with `{tests}` in it.
  const shell = config(["sh", "-c", "bun test {tests} --timeout 60000"]);
  expect(failedAgain("test", shell, vars, bunLog)).toEqual([
    ["sh", "-c", "bun test src/bindings.test.ts src/release.test.ts src/voice/link.test.ts --timeout 60000"],
  ]);
  expect(failedAgain("test", config(["sh", "-c", "bun test src"]), vars, bunLog)).toBeNull();
  // Nothing to narrow to: other steps, no failures named, or one without its file.
  expect(failedAgain("typecheck", config(), vars, bunLog)).toBeNull();
  expect(failedAgain("test", config(), vars, "$ bun test src\nsegfault\n")).toBeNull();
  // An error bun reports outside the failing tests, like a file it could not
  // load, is retried with everything: a narrowed run would never try it again.
  expect(
    failedAgain(
      "test",
      config(),
      vars,
      [
        "$ bun test src",
        "src/bindings.test.ts:",
        "(fail) no preset binds a key twice [0.61ms]",
        "",
        "src/broken.test.ts:",
        "# Unhandled error between tests",
        "-------------------------------",
        "error: Cannot find module './nope.ts' from 'src/broken.test.ts'",
        "-------------------------------",
        "",
        " 1 pass",
        " 1 fail",
        " 1 error",
        "Ran 2 tests across 2 files. [61.00s]",
      ].join("\n"),
    ),
  ).toBeNull();
  expect(failedAgain("test", config(), vars, "(fail) loose [1ms]\n")).toBeNull();
});
