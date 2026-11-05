import { test, expect } from "bun:test";
import { OpenCode2 } from "./headless";
test("an OpenCode 2 session runs only on the default account its service uses", () => {
  expect(() => OpenCode2.start({ cwd: "/tmp", account: "/accounts/work", executable: "opencode" }, null)).toThrow(
    "HeadlessAccountUnsupported",
  );
});
