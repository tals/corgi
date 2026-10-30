import { expect, spyOn, test } from "bun:test";
import * as os from "./os";
import { n } from "./native_ffi";
import { Pane } from "./runtime";
import type { Terminal } from "./pane/terminal";

function pane() {
  const out = new Pane(1, { fd: 7, pid: 103, exited: false } as Terminal, "/previous");
  out.detection.pid = 101;
  return out;
}

test("a detected process's readable CWD needs no foreground query", () => {
  const p = pane(),
    cwd = spyOn(os, "processCwd").mockReturnValue("/detected"),
    front = spyOn(n, "probe_foreground").mockReturnValue(102);
  try {
    p.refreshCwd();
    expect(p.cwd).toBe("/detected");
    expect(cwd.mock.calls).toEqual([[101]]);
    expect(front).not.toHaveBeenCalled();
  } finally {
    cwd.mockRestore();
    front.mockRestore();
  }
});

test("CWD fallback keeps detected, foreground, shell priority and stops at success", () => {
  const p = pane(),
    cwd = spyOn(os, "processCwd").mockImplementation(pid => (pid === 102 ? "/foreground" : null)),
    front = spyOn(n, "probe_foreground").mockReturnValue(102);
  try {
    p.refreshCwd();
    expect(p.cwd).toBe("/foreground");
    expect(cwd.mock.calls).toEqual([[101], [102]]);
    expect(front.mock.calls).toEqual([[7]]);
    cwd.mockClear();
    cwd.mockImplementation(pid => (pid === 103 ? "/shell" : null));
    p.refreshCwd();
    expect(cwd.mock.calls).toEqual([[101], [102], [103]]);
    expect(p.cwd).toBe("/shell");
  } finally {
    cwd.mockRestore();
    front.mockRestore();
  }
});

test("CWD fallback retries a repeated PID rather than caching a failed lookup", () => {
  const p = pane(),
    cwd = spyOn(os, "processCwd").mockReturnValueOnce(null).mockReturnValueOnce("/raced"),
    front = spyOn(n, "probe_foreground").mockReturnValue(101);
  try {
    p.refreshCwd();
    expect(cwd.mock.calls).toEqual([[101], [101]]);
    expect(p.cwd).toBe("/raced");
  } finally {
    cwd.mockRestore();
    front.mockRestore();
  }
});

test("CWD failures keep the prior directory and nonpositive candidates are skipped", () => {
  const p = pane(),
    cwd = spyOn(os, "processCwd").mockImplementation(pid => {
      if (pid === 101) throw Error("PermissionDenied");
      return null;
    }),
    front = spyOn(n, "probe_foreground").mockReturnValue(102);
  try {
    p.refreshCwd();
    expect(cwd.mock.calls).toEqual([[101], [102], [103]]);
    expect(p.cwd).toBe("/previous");
    cwd.mockClear();
    p.detection.pid = 0;
    front.mockReturnValue(-1);
    p.refreshCwd();
    expect(cwd.mock.calls).toEqual([[103]]);
    expect(p.cwd).toBe("/previous");
  } finally {
    cwd.mockRestore();
    front.mockRestore();
  }
});

test("an exited pane never refreshes its CWD", () => {
  const p = pane(),
    cwd = spyOn(os, "processCwd").mockReturnValue("/unexpected"),
    front = spyOn(n, "probe_foreground").mockReturnValue(102);
  p.terminal.exited = true;
  try {
    p.refreshCwd();
    expect(cwd).not.toHaveBeenCalled();
    expect(front).not.toHaveBeenCalled();
    expect(p.cwd).toBe("/previous");
  } finally {
    cwd.mockRestore();
    front.mockRestore();
  }
});
