import { expect, test } from "bun:test";
import * as dev from "./machine_deploy";

test("explicit dev deployments permit dirty iterations and detect other remote writers", () => {
  expect(() => dev.allowed(null, "first-remote", false)).not.toThrow();
  expect(() => dev.allowed("last-deployed", "last-deployed", false)).not.toThrow();
  expect(() => dev.allowed("last-deployed", "someone-elses-build", false)).toThrow("Remote changed");
  expect(() => dev.allowed("last-deployed", "", false)).toThrow("Remote changed");
  expect(() => dev.allowed("last-deployed", "someone-elses-build", true)).not.toThrow();
});
