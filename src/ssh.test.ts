import { expect, test } from "bun:test";
import * as ssh from "./ssh";

test("pane data and control cannot share an SSH master, while each lane reuses its own", () => {
  const control = ssh.args("example", false, false),
    data = ssh.args("example", false, false, "data");
  const socket = (args: string[]) => args[args.indexOf("-S") + 1];
  expect(socket(control)).not.toBe(socket(data));
  // A command, interactive or not, rides the viewer's control master.
  expect(socket(control)).toBe(socket(ssh.args("example", true)));
  expect(socket(data)).toBe(socket(ssh.args("example", false, false, "data")));
  expect(control).toContain("Compression=yes");
  expect(data).toContain("Compression=no");
  for (const lane of ["control", "data"] as const) {
    const fresh = ssh.args("example", false, true, lane);
    expect(socket(fresh)).toBe("none");
    expect(fresh).toContain("ControlMaster=no");
  }
});
