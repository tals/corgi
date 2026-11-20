import { expect, test } from "bun:test";
import * as dev from "./machine_deploy";

test("explicit dev deployments permit dirty iterations and detect other remote writers", () => {
  expect(dev.allowed(null, "first-remote", false)).toBe(true);
  expect(dev.allowed("last-deployed", "last-deployed", false)).toBe(true);
  expect(dev.allowed("last-deployed", "someone-elses-build", false)).toBe(false);
  expect(dev.allowed("last-deployed", "", false)).toBe(false);
  expect(dev.allowed("last-deployed", "someone-elses-build", true)).toBe(true);
});
