import { expect, setSystemTime, spyOn, test } from "bun:test";
import { toBuffer, type Pointer } from "bun:ffi";
import { answerClipboard, waitTime, close } from "./viewer";
import { State, type Result } from "./host_clipboard";
import { n } from "./native_ffi";
import { Controller } from "./controller";
import { transport } from "./fixtures/transport";
import { Terminal } from "./pane/terminal";
import { Probe } from "./terminal_info";

function output() {
  const bytes: string[] = [];
  const native = n as unknown as { probe_write(fd: number, data: Pointer, length: number): number };
  const write = spyOn(native, "probe_write").mockImplementation((_fd, data, length) => {
    bytes.push(toBuffer(data, 0, length).toString());
    return length;
  });
  return { bytes, close: () => write.mockRestore() };
}

test("an idle clipboard stays synchronous while expiring probes and flushing requests", () => {
  const clipboard = new State(),
    out = output();
  const view = {
    pasteEvent: async () => {
      throw Error("UnexpectedEvent");
    },
    pasteResult: async () => {
      throw Error("UnexpectedResult");
    },
    notice: () => {
      throw Error("UnexpectedNotice");
    },
  };
  try {
    clipboard.start(0);
    expect(answerClipboard(view, clipboard)).toBeUndefined();
    expect(clipboard.support).toBe("unsupported");
    expect(out.bytes.join("")).toContain("\x1b[?5522$p");
    expect(clipboard.out).toBe("");
    expect(answerClipboard(view, clipboard)).toBeUndefined();
    expect(out.bytes).toHaveLength(1);
  } finally {
    out.close();
  }
});

test("clipboard events settle before taking results and flushing their generated output", async () => {
  const clipboard = new State(),
    out = output(),
    events: unknown[] = [];
  let release!: () => void;
  const pending = new Promise<void>(resolve => (release = resolve));
  clipboard.event = { phase: "ready", pw: "", listing: "text/plain" };
  clipboard.result = { text: "before event" };
  const view = {
    pasteEvent: async (listing: string) => {
      events.push(listing);
      await pending;
      clipboard.result = { text: "after event" };
      clipboard.out += "event output";
    },
    pasteResult: async (result: Result) => {
      events.push(result);
      clipboard.out += "result output";
    },
    notice: (message: string) => events.push(message),
  };
  try {
    const delivery = answerClipboard(view, clipboard);
    expect(delivery).toBeInstanceOf(Promise);
    expect(events).toEqual(["text/plain"]);
    expect(clipboard.result).toEqual({ text: "before event" });
    expect(out.bytes).toHaveLength(0);
    release();
    await delivery;
    expect(events).toEqual(["text/plain", { text: "after event" }]);
    expect(clipboard.result).toBeNull();
    expect(out.bytes).toEqual(["event outputresult output"]);
  } finally {
    release();
    out.close();
  }
});

test("clipboard delivery reports failures and still processes the following result", async () => {
  const clipboard = new State(),
    out = output(),
    notices: string[] = [];
  clipboard.event = { phase: "ready", pw: "", listing: "image/png" };
  clipboard.result = { failed: "denied" };
  clipboard.out = "cleanup";
  try {
    await answerClipboard(
      {
        pasteEvent: async () => {
          throw Error("EventFailed");
        },
        pasteResult: async () => {
          throw Error("ResultFailed");
        },
        notice: message => notices.push(message),
      },
      clipboard,
    );
    expect(notices).toEqual(["EventFailed", "ResultFailed"]);
    expect(clipboard.result).toBeNull();
    expect(out.bytes).toEqual(["cleanup"]);
  } finally {
    out.close();
  }
});

test("a clipboard read timeout enters asynchronous result delivery", async () => {
  const clipboard = new State(),
    out = output(),
    results: Result[] = [];
  try {
    setSystemTime(new Date(100000));
    clipboard.request("text/plain", 0);
    const delivery = answerClipboard(
      {
        pasteEvent: async () => {},
        pasteResult: async result => {
          results.push(result);
        },
        notice: () => {},
      },
      clipboard,
    );
    expect(delivery).toBeInstanceOf(Promise);
    await delivery;
    expect(results).toEqual([{ failed: "timed_out" }]);
    expect(clipboard.reading).toBeNull();
  } finally {
    setSystemTime();
    out.close();
  }
});

function waitingViewer() {
  const view = new Controller(
      transport(async () => {
        throw Error("UnexpectedRequest");
      }),
    ),
    source = new Terminal(72, 29),
    probe = new Probe(),
    summaries = spyOn(view.review_summaries, "want").mockImplementation(() => {});
  setSystemTime(new Date(10000));
  view.width = 100;
  view.height = 30;
  view.prefs.corgi_intensity = 0;
  view.receiveSnapshot({
    workspaces: [
      {
        id: 1,
        name: "workspace",
        cwd: "",
        model: { nodes: [{ pane: 1 }], tabs: [{ id: 1, root: 0, title: "tab" }], revision: 0 },
      },
    ],
    panes: [
      {
        id: 1,
        workspace: 1,
        tab: 1,
        cols: 72,
        rows: 29,
        agent: { provider: "claude", state: "working", observation: { completed: 0, read: 0 } },
      },
    ],
    conversations: [],
    headless_sessions: [],
  });
  const compose = (text: string) => {
    source.feed("\x1b[H" + text);
    view.runtime.panes[0].terminal.receive(source.surface(1));
    view.compose();
    view.dirty = false;
  };
  probe.info.status = "done";
  probe.badge.status = "unavailable";
  probe.clipboard.support = "unsupported";
  return {
    view,
    probe,
    compose,
    wait: (next = Date.now() + 500, pane = Infinity, settled = true, active = true) =>
      waitTime(view, probe, active, next, pane, settled),
    close() {
      summaries.mockRestore();
      source.destroy();
      close(view);
      setSystemTime();
    },
  };
}

test("normal frame waits keep pane settling and the original animation deadline", () => {
  const f = waitingViewer();
  try {
    expect(f.wait()).toBe(16);
    f.compose("first frame");
    expect(f.view.compositionDeadline()).toBe(10075);
    expect(f.wait(10075)).toBe(75);
    expect(f.wait(10075, 10002)).toBe(2);
    setSystemTime(new Date(10050));
    f.compose("pane update before animation");
    expect(f.view.compositionDeadline()).toBe(10075);
    expect(f.wait(f.view.compositionDeadline())).toBe(25);
    expect(f.wait(10050)).toBe(1);
    expect(f.wait(10550, Infinity, true, false)).toBe(500);
    expect(f.wait(10550, 10058, true, false)).toBe(8);
  } finally {
    f.close();
  }
});

test("input, pointer and held frames retain the fast heartbeat", () => {
  const f = waitingViewer();
  try {
    f.compose("normal");
    expect(f.wait()).toBe(75);
    f.view.input_state.keybuf = [27];
    expect(f.wait()).toBe(16);
    f.view.input_state.keybuf = [];
    f.view.input_state.paste = { pane: 1 };
    expect(f.wait()).toBe(16);
    f.view.input_state.paste = null;
    expect(f.wait(Date.now() + 500, Infinity, false)).toBe(16);
    f.view.pointer = { x: 10, y: 5 };
    expect(f.wait()).toBe(16);
    f.view.pointer = null;
    f.view.prefix = true;
    expect(f.wait()).toBe(16);
    f.view.prefix = false;
    f.view.dirty = true;
    expect(f.wait()).toBe(16);
    f.compose("normal again");
    expect(f.wait()).toBe(75);
    const frame = spyOn(f.view, "frameDelay").mockReturnValue(8);
    try {
      expect(f.wait()).toBe(8);
      frame.mockReturnValue(30);
      expect(f.wait()).toBe(16);
    } finally {
      frame.mockRestore();
    }
  } finally {
    f.close();
  }
});

test("host fragments and clipboard timeout delivery settle before slower waits", () => {
  const f = waitingViewer();
  try {
    f.compose("normal");
    expect(f.probe.feed("\x1b[", 10000)).toHaveLength(0);
    expect(f.wait()).toBe(16);
    expect(f.probe.expire(10099)).toHaveLength(0);
    expect(f.wait()).toBe(16);
    expect(f.probe.expire(10100).toString()).toBe("\x1b[");
    expect(f.wait()).toBe(75);
    f.probe.clipboard.request("text/plain", 10000);
    expect(f.wait()).toBe(16);
    f.probe.clipboard.tick(20000);
    expect(f.wait()).toBe(16);
    expect(f.probe.clipboard.takeResult()).toEqual({ failed: "timed_out" });
    f.probe.clipboard.takeOutput();
    expect(f.wait()).toBe(75);
    f.probe.measure(30, 10000);
    expect(f.wait()).toBe(16);
    f.probe.expire(15000);
    expect(f.wait()).toBe(75);
    f.probe.badge.status = "confirming";
    expect(f.wait()).toBe(16);
    f.probe.badge.status = "ready";
    expect(f.wait()).toBe(75);
  } finally {
    f.close();
  }
});
