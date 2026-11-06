import { expect, spyOn, test } from "bun:test";
import * as service from "./startup_service";
import * as os from "./os";
import * as native from "./trackers/resource_os";
import { Runtime, Pane } from "./runtime";
import { Terminal } from "./pane/terminal";

test("mise after exec reports installation, is killed by process identity, and clears on exec or PID reuse", () => {
  const runtime = new Runtime(),
    terminal = new Terminal(80, 24),
    pane = new Pane(1, terminal, "/tmp"),
    path = spyOn(os, "processPath").mockReturnValue("/tools/mise"),
    counters = spyOn(native, "counters").mockReturnValue({
      start: 42n,
      cpu_ns: 0n,
      memory: 0n,
      read: null,
      written: null,
    }),
    group = spyOn(os, "processGroup").mockReturnValue(6789),
    kill = spyOn(process, "kill").mockReturnValue(true);
  runtime.panes.push(pane);
  terminal.pid = 1234;
  try {
    terminal.feed("mise pi@1.5.0 downloading\r\n");
    service.observe(runtime, pane, { pgid: 6789, program: null, job: { pid: 6789, provider: "pi" } });
    expect(runtime.startup_waits[0]).toMatchObject({ pane: 1, provider: "pi", phase: "agent", detail: "" });
    terminal.feed("$ pi\r\n");
    service.observe(runtime, pane, { pgid: 6789, program: null, job: { pid: 6789, provider: "pi" } });
    expect(runtime.startup_waits[0].phase).toBe("agent");
    terminal.feed("mise pi@1.5.0 extracting archive\r\n");
    service.observe(runtime, pane, { pgid: 6789, program: null, job: { pid: 6789, provider: "pi" } });
    expect(runtime.startup_waits[0].phase).toBe("installing");
    const id = runtime.startup_waits[0].id;
    service.collect(runtime, []);
    expect(runtime.startup_waits).toHaveLength(1);
    service.kill(runtime, id);
    expect(kill).toHaveBeenCalledWith(-6789, "SIGKILL");
    path.mockReturnValue("/tools/pi");
    expect(() => service.kill(runtime, id)).toThrow("NoProcess");
    expect(kill).toHaveBeenCalledTimes(1);
    service.collect(runtime, []);
    expect(runtime.startup_waits).toEqual([]);
    path.mockReturnValue("/tools/mise");
    service.observe(runtime, pane, { pgid: 6789, program: null, job: { pid: 6789, provider: "pi" } });
    counters.mockReturnValue({ start: 43n, cpu_ns: 0n, memory: 0n, read: null, written: null });
    expect(() => service.kill(runtime, id)).toThrow("NoProcess");
    service.collect(runtime, []);
    expect(runtime.startup_waits).toEqual([]);
  } finally {
    path.mockRestore();
    counters.mockRestore();
    group.mockRestore();
    kill.mockRestore();
    terminal.pid = -1;
    runtime.destroy();
  }
});
