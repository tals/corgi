import { expect, test } from "bun:test";
import { Prediction, timeout_ms } from "./instant_input";
import * as composer from "./instant_composer";
import type { Provider } from "./providers";
import type { Surface, View } from "./pane/surface";
import { Terminal as Mirror } from "./mirror";
import { Terminal } from "./pane/terminal";
import { transport } from "./fixtures/transport";

interface Fixture {
  provider: Provider;
  version: string;
  cases: { input: string; draft: string; surface: Surface }[];
}
const fixtures: Fixture[] = await Promise.all(
  ["codex", "claude"].map(p => Bun.file(new URL(`./fixtures/instant-${p}.json`, import.meta.url)).json()),
);
function view(surface: Surface, revision = 1n): View {
  return {
    surface,
    stamp: { identity: 1n, revision, offset: null },
    bottom: 0,
    offset: 0,
    modes: {
      bracketed_paste: true,
      cursor_keys: false,
      keypad_keys: false,
      backarrow: false,
      numlock: true,
      alt_escape: true,
      modify_other: false,
      kitty: 0,
      mouse_event: "none",
      mouse_format: "sgr",
      paste_events: false,
    },
  };
}
function setup(provider: Provider = "codex") {
  const fixture = fixtures.find(f => f.provider === provider)!;
  const prediction = new Prediction();
  prediction.configure(provider, "session-1");
  prediction.receive(view(fixture.cases[0].surface), 0);
  prediction.input("e", 10);
  expect(prediction.surface(10)).not.toBeNull();
  prediction.receive(view(fixture.cases[1].surface, 2n), 100);
  return { prediction, fixture, shape: composer.inspect(fixture.cases[1].surface, provider)! };
}

for (const fixture of fixtures) {
  test(`${fixture.provider} ${fixture.version}: wrapping and backspace agree with captured native screens`, () => {
    for (const frame of fixture.cases) {
      if (!frame.draft) continue; // Empty input displays the app's placeholder.
      const shape = composer.inspect(frame.surface, fixture.provider);
      expect(shape, frame.draft).not.toBeNull();
      expect(composer.matches(shape!, { text: frame.draft, cursor: frame.draft.length }), frame.draft).toBe(true);
    }
  });
  test(`${fixture.provider}: projected word wraps and unwraps agree with native composer geometry`, () => {
    for (let i = 1; i < fixture.cases.length; i++) {
      const previous = fixture.cases[i - 1],
        current = fixture.cases[i];
      if (current.input === "\x15") continue;
      const shape = composer.inspect(previous.surface, fixture.provider)!;
      const surface = composer.project(shape, { text: current.draft, cursor: current.draft.length });
      expect(surface, current.draft).not.toBeNull();
      expect(surface!.cursor, current.draft).toEqual(current.surface.cursor);
      const result = composer.inspect(surface!, fixture.provider)!;
      expect(result.lines, current.draft).toEqual(composer.inspect(current.surface, fixture.provider)!.lines);
      if (previous.draft)
        expect(surface!.lines.map(Bun.stripANSI), current.draft).toEqual(current.surface.lines.map(Bun.stripANSI));
    }
  });
}

for (const provider of ["codex", "claude"] as const) {
  const edits: Fixture & { cases: { input: string; draft: string; cursor: number; surface: Surface }[] } =
    await Bun.file(new URL(`./fixtures/instant-${provider}-edits.json`, import.meta.url)).json();
  test(`${provider}: first character, lateral editing and literal punctuation match captured agent screens`, () => {
    const prediction = new Prediction();
    prediction.configure(provider, "session-1");
    prediction.receive(view(edits.cases[0].surface), 0);
    let previews = 0;
    for (let i = 1; i < edits.cases.length; i++) {
      const previous = edits.cases[i - 1],
        current = edits.cases[i];
      const draft = { text: current.draft, cursor: current.cursor };
      expect(composer.edit({ text: previous.draft, cursor: previous.cursor }, current.input), String(i)).toEqual(draft);
      const shape = composer.inspect(current.surface, provider)!;
      expect(composer.matches(shape, draft), String(i)).toBe(true);
      prediction.input(current.input, i * 300);
      const preview = prediction.surface(i * 300);
      if (preview) {
        previews++;
        expect(preview.cursor, String(i)).toEqual(current.surface.cursor);
        expect(composer.matches(composer.inspect(preview, provider)!, draft), String(i)).toBe(true);
        expect(composer.inspect(preview, provider)!.top, String(i)).toBe(shape.top);
      }
      prediction.receive(view(current.surface, BigInt(i + 1)), i * 300 + 240);
    }
    // Only the popup, indistinguishable cursor positions, no-ops, and Claude's
    // unstyled empty placeholder need remote output in this editing sequence.
    expect(previews).toBeGreaterThan(edits.cases.length - 9);
  });
}

test("enabling on a fresh existing surface predicts the very first key", () => {
  const prediction = new Prediction();
  prediction.configure(null, "session-1");
  prediction.receive(view(fixtures[0].cases[0].surface), 0);
  prediction.configure("codex", "session-1");
  prediction.input("e");
  expect(composer.inspect(prediction.surface()!, "codex")!.lines).toEqual(["he"]);
});

test("a completion popup pauses a known wrapped draft and closing it resumes without retraining", () => {
  const { prediction, shape } = setup();
  const text = "hello there this is a test of wrapping some words ";
  prediction.input(text.slice(2), 110);
  prediction.receive(view(composer.project(shape, { text, cursor: text.length })!, 3n), 350);
  prediction.input("@", 360);
  expect(prediction.surface(361)).toBeNull();
  const popup = structuredClone(shape.surface);
  popup.lines[shape.top + shape.height + 1] = "enter to select";
  prediction.receive(view(popup, 4n), 400);
  prediction.input("unknown ", 410);
  expect(prediction.surface(411)).toBeNull();
  const completed = text + "@unknown ";
  prediction.receive(view(composer.project(shape, { text: completed, cursor: completed.length })!, 5n), 650);
  prediction.input("and more", 660);
  expect(composer.inspect(prediction.surface(661)!, "codex")!.lines.join(" ")).toContain("@unknown and more");
});

test("identical wrap cursor pixels pause confirmation without losing the known editing offsets", () => {
  const { prediction, shape } = setup();
  const text = "hello there this is a tes of wrapping some words";
  prediction.input(text.slice(2), 110);
  prediction.receive(view(composer.project(shape, { text, cursor: text.length })!, 3n), 200);
  for (let i = text.length; i > 37; i--) prediction.input("\x1b[D", 210);
  prediction.receive(view(composer.project(shape, { text, cursor: 37 })!, 4n), 300);
  expect(prediction.surface(301)).toBeNull();
  prediction.input("Z", 310);
  const edited = text.slice(0, 37) + "Z" + text.slice(37);
  prediction.receive(view(composer.project(shape, { text: edited, cursor: 38 })!, 5n), 400);
  prediction.input("Q", 410);
  expect(prediction.surface(411)).not.toBeNull();
  expect(composer.inspect(prediction.surface(411)!, "codex")!.lines.join(" ")).toContain("ZQ");
});

test("no-op navigation does not add ambiguous pending edits", () => {
  const { prediction, shape } = setup();
  prediction.input("\x1b[C", 110);
  prediction.input("l", 120);
  prediction.receive(view(composer.project(shape, { text: "hel", cursor: 3 })!, 3n), 220);
  prediction.input("l", 230);
  expect(prediction.surface(231)).not.toBeNull();
});

test("typing appears before a remote frame and coalesced confirmations retain only the remaining suffix", () => {
  const { prediction, shape } = setup();
  prediction.input("l", 110);
  prediction.input("l", 120);
  prediction.input("o", 130);
  expect(composer.inspect(prediction.surface(131)!, "codex")!.lines).toEqual(["hello"]);
  prediction.receive(view(composer.project(shape, { text: "hell", cursor: 4 })!, 3n), 220);
  expect(composer.inspect(prediction.surface(221)!, "codex")!.lines).toEqual(["hello"]);
  prediction.receive(view(composer.project(shape, { text: "hello", cursor: 5 })!, 4n), 230);
  expect(prediction.surface(231)).toBeNull();
  prediction.input("!", 240);
  expect(composer.inspect(prediction.surface(241)!, "codex")!.lines).toEqual(["hello!"]);
});

test("unrelated output retains a prediction; a changed composer corrects it immediately", () => {
  const { prediction, fixture, shape } = setup();
  prediction.input("l", 110);
  const update = structuredClone(fixture.cases[1].surface);
  update.lines[0] = "background output";
  prediction.receive(view(update, 3n), 120);
  expect(prediction.surface(121)?.lines[0]).toBe("background output");
  prediction.receive(view(composer.project(shape, { text: "HE", cursor: 2 })!, 4n), 130);
  expect(prediction.surface(131)).toBeNull();
  prediction.input("ignored locally", 140);
  expect(prediction.surface(141)).toBeNull();
});

test("type then backspace returning to the same pixels cannot falsely confirm queued input", () => {
  const { prediction, fixture } = setup();
  prediction.input("x", 110);
  prediction.input("\x7f", 120);
  prediction.receive(view(fixture.cases[1].surface, 3n), 130);
  expect(prediction.surface(131)).toBeNull();
});

test("deleting the final character clears the native box locally before the remote placeholder returns", () => {
  for (const provider of ["codex", "claude"] as const) {
    const { prediction, fixture } = setup(provider);
    prediction.input("\x7f", 110);
    prediction.receive(view(fixture.cases[0].surface, 3n), 120);
    prediction.input("\x7f", 130);
    const empty = prediction.surface(131);
    expect(empty).not.toBeNull();
    expect(composer.inspect(empty!, provider)?.lines).toEqual([""]);
    expect(empty!.cursor?.x).toBe(2);
    // Placeholder wording belongs to the app, so wait for its authoritative decoration.
    prediction.receive(view(fixture.cases[25].surface, 4n), 200);
    expect(prediction.surface(201)).toBeNull();
  }
});

for (const [name, key] of [
  ["Ctrl+C", "\x03"],
  ["Ctrl+U", "\x15"],
]) {
  test(`${name}: an empty redraw cannot erase typing while its echo is still in flight`, () => {
    const { prediction, fixture, shape } = setup();
    prediction.input(key, 110);
    const empty = fixture.cases[25].surface;
    prediction.receive(view(empty, 3n), 200);
    prediction.input("h", 210);
    expect(composer.inspect(prediction.surface(211)!, "codex")!.lines).toEqual(["h"]);
    const redraw = structuredClone(empty);
    redraw.lines[0] = "unrelated output after clearing";
    prediction.receive(view(redraw, 4n), 250);
    expect(prediction.surface(251)).not.toBeNull();
    expect(composer.inspect(prediction.surface(251)!, "codex")!.lines).toEqual(["h"]);
    expect(prediction.surface(251)!.lines[0]).toBe(redraw.lines[0]);
    prediction.input("i", 260);
    prediction.receive(view(fixture.cases[0].surface, 5n), 300);
    expect(composer.inspect(prediction.surface(301)!, "codex")!.lines).toEqual(["hi"]);
    prediction.receive(view(composer.project(shape, { text: "hi", cursor: 2 })!, 6n), 350);
    expect(prediction.surface(351)).toBeNull();
  });
}

test("empty redraws do not acknowledge pending typing or extend its timeout", () => {
  const { prediction, fixture } = setup();
  prediction.input("\x15", 110);
  prediction.receive(view(fixture.cases[25].surface, 3n), 200);
  prediction.input("h", 210);
  prediction.receive(view(fixture.cases[25].surface, 4n), 210 + timeout_ms - 1);
  expect(prediction.surface(210 + timeout_ms - 1)).not.toBeNull();
  expect(prediction.surface(210 + timeout_ms)).toBeNull();
});

test("only a recognizable empty placeholder matches an empty draft", () => {
  const empty = fixtures[0].cases[25].surface;
  const shape = composer.inspect(empty, "codex")!;
  const draft = { text: "", cursor: 0 };
  expect(composer.seed(shape)).toEqual(draft);
  expect(composer.matches(shape, draft)).toBe(true);
  const unstyled = structuredClone(empty);
  unstyled.lines[shape.top] = Bun.stripANSI(unstyled.lines[shape.top]);
  const unknown = composer.inspect(unstyled, "codex")!;
  expect(composer.seed(unknown)).toBeNull();
  expect(composer.matches(unknown, draft)).toBe(false);
  const text = composer.inspect(fixtures[0].cases[0].surface, "codex")!;
  expect(composer.matches(text, draft)).toBe(false);
});

test("a blackhole expires from the oldest unconfirmed edit even while typing continues", () => {
  const { prediction } = setup();
  prediction.input("l", 110);
  prediction.input("l", 110 + timeout_ms - 1);
  expect(prediction.surface(110 + timeout_ms - 1)).not.toBeNull();
  expect(prediction.surface(110 + timeout_ms)).toBeNull();
  prediction.input("o", 110 + timeout_ms + 1);
  expect(prediction.surface(110 + timeout_ms + 1)).toBeNull();
});

test("submit, history, paste, completion and wide or combining text immediately remove prediction", () => {
  for (const input of ["\r", "\x1b", "\x1b[A", "\x1b[200~", "\x1b[97;5u", " @", " $", "界", "e\u0301", "👨‍👩‍👧"]) {
    const { prediction } = setup();
    prediction.input("l", 110);
    expect(prediction.surface(110), input).not.toBeNull();
    prediction.input(input, 120);
    expect(prediction.surface(120), input).toBeNull();
  }
});

test("off, a pane binding change, reconnect and resize discard speculative state", () => {
  for (const kind of ["off", "binding", "reconnect", "resize"] as const) {
    const { prediction, fixture } = setup();
    prediction.input("l", 110);
    const next = view(structuredClone(fixture.cases[1].surface), 3n);
    switch (kind) {
      case "off":
        prediction.configure(null);
        break;
      case "binding":
        prediction.configure("codex", "session-2");
        break;
      case "reconnect":
        next.stamp.identity++;
        prediction.receive(next, 120);
        break;
      case "resize":
        next.surface.cols--;
        prediction.receive(next, 120);
        break;
    }
    expect(prediction.surface(121), kind).toBeNull();
  }
});

test("prediction is bounded when a stream stops confirming edits", () => {
  const { prediction } = setup();
  for (let i = 0; i < 129; i++) prediction.input("a", 110);
  expect(prediction.surface(111)).toBeNull();
});

test("a preexisting multiline draft, hidden cursor, overlay or uncertain wrap cannot start prediction", () => {
  for (const fixture of fixtures) {
    const multiline = fixture.cases[4].surface;
    expect(composer.seed(composer.inspect(multiline, fixture.provider)!)).toBeNull();
    expect(composer.inspect({ ...multiline, cursor: null }, fixture.provider)).toBeNull();
    const overlay = structuredClone(multiline);
    overlay.lines[overlay.lines.length - 1] = "enter to confirm";
    expect(composer.inspect(overlay, fixture.provider)).toBeNull();
    const shape = composer.inspect(fixture.cases[1].surface, fixture.provider)!;
    expect(composer.project(shape, { text: "a-path/".repeat(10), cursor: 70 })).toBeNull();
  }
});

test("visual prediction cannot enter copy, authoritative state, or input replay", async () => {
  const sent: unknown[] = [];
  const conn = {
    ...transport(async (_op, fields) => {
      sent.push(fields);
      throw Error("ConnectionClosed");
    }),
    remote: true,
  };
  const terminal = new Mirror(conn, 1, 40, 24);
  const host = new Terminal(40, 24);
  const fixture = fixtures[0];
  try {
    terminal.instant("codex", "session-1");
    terminal.receive(view(fixture.cases[0].surface));
    terminal.send("e");
    terminal.receive(view(fixture.cases[1].surface, 2n));
    terminal.send("l");
    host.feed(terminal.rows(1, 0, 0, 40, 24, false, null));
    expect(host.text()).toContain("› hel");
    expect(terminal.inner.text()).toContain("› he ");
    expect(terminal.known).toEqual({ identity: 1n, revision: 2n, offset: null });
    await expect(terminal.flush()).rejects.toThrow("ConnectionClosed");
    terminal.resetPrediction();
    await terminal.flush();
    expect(sent).toEqual([{ command: { "pane.input": { target: 1, data: "el" } } }]);
    host.feed(terminal.rows(1, 0, 0, 40, 24, false, null));
    expect(host.text()).toContain("› he ");
  } finally {
    terminal.destroy();
    host.destroy();
  }
});
