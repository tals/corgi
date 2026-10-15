import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jobIn, attachCommand } from "./daemon";
import { Text } from "../common";
test("a session attaches only to the live background job that holds it", () => {
  const directory = mkdtempSync(join(tmpdir(), "corgi-daemon-"));
  try {
    for (const [i, record] of [
      { sessionId: "bg", pid: process.pid, kind: "bg", jobId: "19e909c5" },
      { sessionId: "terminal", pid: process.pid, kind: "interactive" },
      { sessionId: "exited", pid: 2147483647, kind: "bg", jobId: "5c926aa7" },
      { sessionId: "no-job", pid: process.pid, kind: "bg" },
      { sessionId: "unsafe", pid: process.pid, kind: "bg", jobId: "a;rm" },
      {
        sessionId: "future",
        pid: process.pid,
        kind: "remote",
        jobId: "0a1b2c3d",
      },
    ].entries())
      writeFileSync(join(directory, `${i + 100}.json`), JSON.stringify(record));
    writeFileSync(join(directory, "7.json"), '{"pid":');
    expect(jobIn(directory, "BG")?.text()).toBe("19e909c5");
    for (const session of ["terminal", "exited", "no-job", "unsafe", "future", "missing"])
      expect(jobIn(directory, session)).toBeNull();
    expect(jobIn("/nonexistent/sessions", "bg")).toBeNull();
    expect(attachCommand(new Text("19e909c5"))).toBe("claude attach 19e909c5");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
