import { expect, test } from "bun:test";
import { Prediction, timeout_ms } from "./instant_input";
import * as composer from "./instant_composer";
import type { Provider } from "./providers";
import type { Surface, View } from "./pane/surface";
import { Terminal as Mirror } from "./mirror";
import { Terminal } from "./pane/terminal";
import { transport } from "./fixtures/transport";
import * as palette from "./palette";

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

test("Claude's painted caret enables prediction without leaving a second block behind", () => {
  const { shape } = setup("claude");
  // Current Claude hides DECTCEM and draws inverse video on the character at its caret.
  const colors = /^\x1b\[0;38;2;(\d+;\d+;\d+);48;2;(\d+;\d+;\d+)m/.exec(shape.surface.lines[shape.top])!;
  const normal = colors[0],
    inverse = `\x1b[0;38;2;${colors[2]};48;2;${colors[1]}m`;
  const surface = structuredClone(shape.surface);
  surface.cursor = null;
  surface.lines[shape.top] = normal + "❯ h" + inverse + "e" + normal + " ".repeat(surface.cols - 4) + "\x1b[0m";
  const inspected = composer.inspect(surface, "claude")!;
  expect(inspected.cursor).toEqual({ x: 1, y: 0 });
  expect(composer.seed(inspected)).toEqual({ text: "he", cursor: 1 });
  const prediction = new Prediction();
  prediction.configure("claude");
  prediction.receive(view(surface), 0);
  prediction.input("X", 1);
  const preview = prediction.surface(1)!;
  expect(composer.inspect(preview, "claude")!.lines).toEqual(["hXe"]);
  expect(preview.cursor).toEqual({ x: 4, y: shape.top });
  expect(preview.lines[shape.top]).not.toContain(inverse);
  expect(surface.lines[shape.top]).toContain(inverse); // Authoritative pixels stay untouched.

  // A selection or multiple inverted cells do not identify an insertion point.
  for (const highlight of [inverse + "he" + normal, inverse + "h" + normal + inverse + "e" + normal]) {
    surface.lines[shape.top] = normal + "❯ " + highlight + " ".repeat(surface.cols - 4);
    expect(composer.inspect(surface, "claude")).toBeNull();
  }
});

for (const provider of ["codex", "claude"] as const) {
  test(`${provider}: raw, Kitty and modifyOtherKeys Ctrl+J all insert a draft newline`, () => {
    for (const input of ["\n", "\x1b[106;5u", "\x1b[27;5;106~"]) {
      expect(composer.edit({ text: "ab", cursor: 1 }, input)).toEqual({ text: "a\nb", cursor: 2 });
      expect(composer.edit({ text: "ab", cursor: 1 }, input, false)).toBeNull();
    }
  });
  test(`${provider}: Ctrl+J predicts a newline and keeps accepting edits while old frames arrive`, () => {
    const { prediction, shape } = setup(provider);
    prediction.input("\n", 110);
    prediction.input("x", 120);
    const expected = { text: "he\nx", cursor: 4 };
    expect(composer.matches(composer.inspect(prediction.surface(121)!, provider)!, expected)).toBe(true);
    prediction.receive(view(composer.project(shape, { text: "he\n", cursor: 3 })!, 3n), 200);
    expect(composer.matches(composer.inspect(prediction.surface(201)!, provider)!, expected)).toBe(true);
    prediction.receive(view(composer.project(shape, expected)!, 4n), 300);
    expect(prediction.surface(301)).toBeNull();
    prediction.input("\x7f", 310);
    prediction.input("\x7f", 320);
    expect(composer.inspect(prediction.surface(321)!, provider)!.lines).toEqual(["he"]);
  });
}

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

test("identical wrap cursor pixels retain the latest preview without confirming editing offsets", () => {
  const { prediction, shape } = setup();
  const text = "hello there this is a tes of wrapping some words";
  prediction.input(text.slice(2), 110);
  prediction.receive(view(composer.project(shape, { text, cursor: text.length })!, 3n), 200);
  for (let i = text.length; i > 37; i--) prediction.input("\x1b[D", 210);
  prediction.receive(view(composer.project(shape, { text, cursor: 37 })!, 4n), 300);
  expect(prediction.surface(301)!.cursor).toEqual(composer.project(shape, { text, cursor: 37 })!.cursor);
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
  expect(composer.inspect(prediction.surface(131)!, "codex")!.lines).toEqual(["he"]);
  prediction.input("y", 140);
  prediction.receive(
    view(composer.project(composer.inspect(fixture.cases[1].surface, "codex")!, { text: "hex", cursor: 3 })!, 4n),
    150,
  );
  expect(composer.inspect(prediction.surface(151)!, "codex")!.lines).toEqual(["hey"]);
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

test("slow-link deadlines survive remote echo latency and cannot be extended by later samples", () => {
  let budget = 6500;
  const prediction = new Prediction(() => budget);
  prediction.configure("codex", "slow");
  prediction.receive(view(fixtures[0].cases[0].surface), 0);
  prediction.input("e", 10);
  expect(prediction.surface(4010)).not.toBeNull();
  prediction.receive(view(fixtures[0].cases[1].surface, 2n), 4010);
  prediction.input("l", 4020);
  budget = 30000;
  prediction.input("o", 5000);
  expect(prediction.surface(10519)).not.toBeNull();
  expect(prediction.surface(10520)).toBeNull();
});

function shell(line = "$ ", revision = 1n, cursor = line.length): View {
  return view({ pane: 1, cols: 80, rows: 3, lines: ["", line, ""], cursor: { x: cursor, y: 1 } }, revision);
}

test("terminal insert, arrows and repeated deletion states retain the latest trajectory until convergence", () => {
  const prediction = new Prediction();
  prediction.configure("terminal");
  prediction.receive(shell(), 0);
  prediction.input("a", 10);
  prediction.receive(shell("$ a", 2n), 20);
  const steps: [string, string, number][] = [
    ["b", "ab", 2],
    ["c", "abc", 3],
    ["\x1b[D", "abc", 2],
    ["\x7f", "ac", 1],
    ["b", "abc", 2],
    ["\x1b[3~", "ab", 2],
    ["\x1b[D", "ab", 1],
    ["X", "aXb", 2],
    ["\x7f", "ab", 1],
    ["Z", "aZb", 2],
  ];
  for (const [key, draft, cursor] of steps) {
    prediction.input(key, 30);
    expect(Bun.stripANSI(prediction.surface(31)!.lines[1]).trimEnd()).toBe("$ " + draft);
    expect(prediction.surface(31)!.cursor).toEqual({ x: cursor + 2, y: 1 });
  }
  for (const [i, [, draft, cursor]] of steps.entries()) {
    const frame = shell("$ " + draft, BigInt(i + 3), cursor + 2);
    prediction.receive(frame, 50 + i);
    const shown = prediction.surface(60) ?? frame.surface;
    expect(Bun.stripANSI(shown.lines[1]).trimEnd()).toBe("$ aZb");
    expect(shown.cursor).toEqual({ x: 4, y: 1 });
  }
  expect(prediction.surface(61)).toBeNull();
});

test("a surface received before the first pane binding can train terminal echo", () => {
  const prediction = new Prediction();
  prediction.receive(shell());
  prediction.configure(null, "first-binding");
  prediction.configure("terminal", "first-binding");
  prediction.input("a");
  prediction.receive(shell("$ a", 2n));
  prediction.input("b");
  expect(prediction.surface()).not.toBeNull();
});

for (const target of ["terminal", "claude", "codex"] as const) {
  test(`${target}: plain echoed prompts train once and predict without changing authoritative pixels`, () => {
    const prediction = new Prediction(() => 6500);
    prediction.configure(target, "shell");
    prediction.receive(shell(), 0);
    prediction.input("a", 10);
    expect(prediction.surface(11)).toBeNull();
    prediction.receive(shell("$ a", 2n), 2010);
    prediction.input("bc", 2020);
    expect(Bun.stripANSI(prediction.surface(2021)!.lines[1]).trimEnd()).toBe("$ abc");
    expect(prediction.surface(4020)).not.toBeNull();
    prediction.receive(shell("$ ab", 3n), 4030);
    expect(Bun.stripANSI(prediction.surface(4031)!.lines[1]).trimEnd()).toBe("$ abc");
    prediction.receive(shell("$ abc", 4n), 4040);
    expect(prediction.surface(4041)).toBeNull();
    prediction.input("\x7f", 4050);
    expect(Bun.stripANSI(prediction.surface(4051)!.lines[1]).trimEnd()).toBe("$ ab");
    prediction.receive(shell("$ ab", 5n), 4060);
    prediction.input("\r", 4070);
    prediction.input("secret", 4080);
    expect(prediction.surface(4081)).toBeNull();
    prediction.receive(shell("Password: ", 6n), 6000);
    prediction.input("secret", 6010);
    prediction.receive(shell("Password: ", 7n), 6020);
    expect(prediction.surface(6021)).toBeNull();
  });
}

test("terminal prediction corrects mismatches, retrains on controls and expires on silence", () => {
  const prediction = new Prediction();
  prediction.configure("terminal");
  prediction.receive(shell(), 0);
  prediction.input("a", 10);
  prediction.receive(shell("$ a", 2n), 20);
  prediction.input("b", 30);
  prediction.receive(shell("new prompt> ", 3n), 40);
  expect(prediction.surface(41)).toBeNull();
  prediction.input("x", 50);
  expect(prediction.surface(51)).toBeNull();
  prediction.receive(shell("new prompt> x", 4n), 60);
  prediction.input("y", 70);
  expect(prediction.surface(71)).not.toBeNull();
  prediction.input("z", 70 + timeout_ms - 1);
  expect(prediction.surface(70 + timeout_ms)).toBeNull();
});

test("terminal prediction preserves styled Unicode prompts during cursor edits and stops at unknown wraps", () => {
  const prediction = new Prediction();
  prediction.configure("terminal");
  const prompt = "\x1b[32m❯ \x1b[0m";
  prediction.receive(shell(prompt, 1n, 2), 0);
  prediction.input("a", 10);
  prediction.receive(shell(prompt + "a", 2n, 3), 20);
  prediction.input("b", 30);
  expect(prediction.surface(31)!.lines[1]).toStartWith("\x1b[32m❯ ");
  prediction.input("\x1b[D", 40);
  expect(prediction.surface(41)!.cursor).toEqual({ x: 3, y: 1 });
  prediction.receive(shell("a".repeat(77), 3n), 50);
  prediction.input("b", 60);
  prediction.receive(shell("a".repeat(77) + "b", 4n), 70);
  prediction.input("c", 80);
  expect(prediction.surface(81)).toBeNull();
});

test("each terminal mismatch starts a tentative epoch and confirmed echo recovers on the same row", () => {
  const prediction = new Prediction();
  prediction.configure("terminal");
  prediction.receive(shell(), 0);
  prediction.input("a", 10);
  prediction.receive(shell("$ a", 2n), 20);
  prediction.input("b", 30);
  expect(prediction.surface(31)).not.toBeNull();
  prediction.receive(shell("$ aB", 3n), 40);
  prediction.input("c", 50);
  expect(prediction.surface(51)).toBeNull();
  prediction.receive(shell("$ aBc", 4n), 60);
  prediction.input("d", 70);
  expect(prediction.surface(71)).not.toBeNull();
  prediction.receive(shell("$ aBcD", 5n), 80);
  prediction.input("e", 90);
  prediction.receive(shell("$ aBcDe", 6n), 100);
  prediction.input("f", 110);
  expect(prediction.surface(111)).not.toBeNull();
  const moved = shell("", 7n, 0);
  moved.surface.cursor!.y = 2;
  prediction.receive(moved, 120);
  prediction.input("x", 130);
  const echoed = structuredClone(moved);
  echoed.stamp.revision = 8n;
  echoed.surface.lines[2] = "x";
  echoed.surface.cursor!.x = 1;
  prediction.receive(echoed, 140);
  prediction.input("y", 150);
  expect(prediction.surface(151)).not.toBeNull();
});

test("blank echo cannot train prediction and screen borders and cell styles survive projection", () => {
  const prediction = new Prediction();
  prediction.configure("terminal");
  const box = (draft: string, revision: bigint) => {
    const value = shell("", revision, 2 + draft.length);
    value.surface.lines = ["box heading", "\x1b[44m│ " + draft.padEnd(5) + "\x1b[31m│\x1b[0m", "status bar"];
    return value;
  };
  prediction.receive(box("", 1n), 0);
  prediction.input(" ", 10);
  prediction.receive(box(" ", 2n), 20);
  prediction.input("a", 30);
  expect(prediction.surface(31)).toBeNull();
  prediction.receive(box(" a", 3n), 40);
  prediction.input("b", 50);
  expect(prediction.surface(51)!.lines).toEqual(["box heading", "\x1b[44m│  ab  \x1b[31m│\x1b[0m", "status bar"]);
  prediction.input("cd", 60);
  expect(prediction.surface(61)).toBeNull();
});

test("history, paste, completion and wide or combining text immediately remove prediction", () => {
  for (const input of ["\x1b", "\x1b[A", "\x1b[200~", " @", " $", "界", "e\u0301", "👨‍👩‍👧"]) {
    const { prediction } = setup();
    prediction.input("l", 110);
    expect(prediction.surface(110), input).not.toBeNull();
    prediction.input(input, 120);
    expect(prediction.surface(120), input).toBeNull();
  }
});

for (const target of ["terminal", "codex", "claude"] as const) {
  test(`${target}: Return retains the latest caret while earlier predicted states arrive`, () => {
    const prediction = new Prediction();
    prediction.configure(target);
    const shape = target === "terminal" ? null : setup(target).shape;
    const frame = (draft: string, revision: bigint) =>
      shape
        ? view(composer.project(shape, { text: draft, cursor: draft.length })!, revision)
        : shell("$ " + draft, revision);
    prediction.receive(frame("h", 1n), 0);
    prediction.input("e", 10);
    prediction.receive(frame("he", 2n), 100);
    prediction.input("l", 110);
    prediction.input("l", 120);
    prediction.input("o there this is a test of wrapping some words", 130);
    const latest = prediction.surface(131)!;
    expect(latest).not.toBeNull();
    prediction.input("\r", 140);
    expect(prediction.surface(141)).toEqual(latest);
    prediction.input("queued", 150);
    expect(prediction.surface(151)).toEqual(latest);
    for (const [i, draft] of ["he", "hel", "hell"].entries()) {
      prediction.receive(frame(draft, BigInt(i + 3)), 200 + i * 10);
      expect(prediction.surface(221)!.cursor).toEqual(latest.cursor);
      expect(prediction.surface(221)!.lines.map(Bun.stripANSI)).toEqual(latest.lines.map(Bun.stripANSI));
    }
    const caughtUp = frame("hello there this is a test of wrapping some words", 6n);
    prediction.receive(caughtUp, 240);
    expect(prediction.surface(241)).toBeNull();
    expect(caughtUp.surface.cursor).toEqual(latest.cursor);
    prediction.input("more", 250);
    expect(prediction.surface(251)).toBeNull();
    // The application has now processed Return and replaced its input.
    prediction.receive(frame("", 7n), 300);
    expect(prediction.surface(301)).toBeNull();
  });

  test(`${target}: submission expiry is bounded and only generic echo trusts the settling receipt`, () => {
    for (const expire of [false, true]) {
      const prediction = new Prediction();
      prediction.configure(target);
      const shape = target === "terminal" ? null : setup(target).shape;
      const frame = (draft: string, revision: bigint) =>
        shape
          ? view(composer.project(shape, { text: draft, cursor: draft.length })!, revision)
          : shell("$ " + draft, revision);
      prediction.receive(frame("h", 1n));
      prediction.input("e");
      prediction.receive(frame("he", 2n));
      const now = performance.now();
      prediction.input("l", now);
      prediction.input("\r", now + 1);
      expect(prediction.surface(now + 2)).not.toBeNull();
      if (expire) {
        expect(prediction.surface(now + timeout_ms)).toBeNull();
      } else {
        prediction.delivered(prediction.sequence, { epoch: "one", sequence: 1n });
        prediction.receive({ ...frame("he", 2n), input_ack: { epoch: "one", sequence: 1n } });
        if (target === "terminal") expect(prediction.surface()).toBeNull();
        else {
          expect(prediction.surface()).not.toBeNull();
          prediction.receive(frame("", 3n));
          expect(prediction.surface()).toBeNull();
        }
      }
    }
  });
}

test("off, a pane binding change and reconnect discard speculative state", () => {
  for (const kind of ["off", "binding", "reconnect"] as const) {
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

test("late acknowledgements invalidate no-echo input on unchanged pixels, then retrain", () => {
  const prediction = new Prediction(() => 6500);
  prediction.configure("terminal");
  const receive = (line: string, revision: bigint, sequence: bigint) => {
    const frame = shell(line, revision);
    frame.input_ack = { epoch: "one", sequence };
    prediction.receive(frame);
  };
  receive("$ ", 1n, 0n);
  prediction.input("a");
  prediction.delivered(prediction.sequence, { epoch: "one", sequence: 1n });
  receive("$ a", 2n, 1n);
  prediction.input("b");
  const through = prediction.sequence;
  expect(prediction.surface()).not.toBeNull();
  // The screen may arrive before the control reply that identifies this batch.
  receive("$ a", 2n, 2n);
  expect(prediction.surface()).not.toBeNull();
  prediction.delivered(through, { epoch: "one", sequence: 2n });
  expect(prediction.surface()).toBeNull();
  prediction.input("c");
  expect(prediction.surface()).toBeNull();
  prediction.delivered(prediction.sequence, { epoch: "one", sequence: 3n });
  receive("$ ac", 3n, 3n);
  prediction.input("d");
  expect(prediction.surface()).not.toBeNull();
});

test("late receipts disambiguate type then erase without discarding newer unacknowledged edits", () => {
  const prediction = new Prediction();
  prediction.configure("terminal");
  prediction.receive(shell());
  prediction.input("a");
  prediction.receive(shell("$ a", 2n));
  prediction.input("b");
  prediction.input("\x7f");
  const through = prediction.sequence;
  prediction.input("c");
  prediction.delivered(through, { epoch: "one", sequence: 2n });
  const same = shell("$ a", 2n);
  same.input_ack = { epoch: "one", sequence: 2n };
  prediction.receive(same);
  expect(Bun.stripANSI(prediction.surface()!.lines[1]).trimEnd()).toBe("$ ac");
});

for (const provider of ["terminal", "codex", "claude"] as const) {
  test(`${provider}: optional gray affects only speculative text and clears on confirmation`, () => {
    const prediction = new Prediction();
    prediction.configure(provider, "dim-test", true);
    if (provider === "terminal") {
      prediction.receive(shell("\x1b[44m$ \x1b[0m", 1n, 2));
      prediction.input("a");
      prediction.receive(shell("\x1b[44m$ a\x1b[0m", 2n, 3));
      prediction.input("b");
      const projected = prediction.surface()!;
      expect(projected.lines[1]).toContain(palette.fg("muted") + "b");
      expect(projected.lines[1]).toStartWith("\x1b[44m$ a");
      prediction.receive(shell("\x1b[44m$ ab\x1b[0m", 3n, 4));
    } else {
      const fixture = fixtures.find(f => f.provider === provider)!;
      prediction.receive(view(fixture.cases[0].surface));
      prediction.input("e");
      expect(prediction.surface()!.lines.join("\n")).toContain(palette.fg("muted") + "e");
      prediction.receive(view(fixture.cases[1].surface, 2n));
    }
    expect(prediction.surface()).toBeNull();
    prediction.input("x");
    expect(prediction.surface()!.lines.join("\n")).toContain(palette.fg("muted"));
    prediction.configure(provider, "dim-test", false);
    expect(prediction.surface()!.lines.join("\n")).not.toContain(palette.fg("muted"));
  });
}

for (const provider of ["claude", "codex"] as const) {
  test(`${provider}: encoded editing keys and boundary arrows preserve a multiline trajectory`, () => {
    const { prediction, shape } = setup(provider);
    prediction.input("\x1b[106;5u", 110);
    prediction.input("second", 120);
    prediction.input("\x1b[106;5u", 130);
    prediction.input("third", 140);
    prediction.input("\x1b[117;5u", 150);
    prediction.input("\x1b[117;5u", 160);
    prediction.input("\x1b[B", 170);
    prediction.input("!", 180);
    const expected = { text: "he\nsecond!", cursor: 10 };
    const preview = prediction.surface(181)!;
    expect(composer.matches(composer.inspect(preview, provider)!, expected)).toBe(true);
    prediction.delivered(prediction.sequence, { epoch: "editor", sequence: 9n });
    for (const [i, value] of [
      "he\n",
      "he\nsecond",
      "he\nsecond\n",
      "he\nsecond\nthird",
      "he\nsecond\n",
      "he\nsecond",
    ].entries()) {
      prediction.receive(
        {
          ...view(composer.project(shape, { text: value, cursor: value.length })!, BigInt(i + 3)),
          input_ack: { epoch: "editor", sequence: 9n },
        },
        200 + i,
      );
      expect(composer.matches(composer.inspect(prediction.surface(210)!, provider)!, expected)).toBe(true);
    }
    prediction.receive(view(composer.project(shape, expected)!, 10n), 220);
    expect(prediction.surface(221)).toBeNull();
  });

  test(`${provider}: unknown input pauses a known multiline journal until a later edit confirms it`, () => {
    const { prediction, shape } = setup(provider);
    prediction.input("\n", 110);
    prediction.input("second", 111);
    const initial = composer.project(shape, { text: "he\nsecond", cursor: 9 })!;
    prediction.receive(view(initial, 3n), 120);
    prediction.input("\x1b[24~", 130);
    expect(prediction.surface(131)).toBeNull();
    prediction.input("!", 140);
    prediction.receive(view(initial, 4n), 150);
    expect(prediction.surface(151)).toBeNull();
    const confirmed = { text: "he\nsecond!", cursor: 10 };
    prediction.receive(view(composer.project(shape, confirmed)!, 5n), 160);
    prediction.input("?", 170);
    expect(composer.inspect(prediction.surface(171)!, provider)!.lines).toEqual(["he", "second!?"]);
  });

  test(`${provider}: timed-out and temporarily hidden drafts recover without losing hard breaks`, () => {
    const { prediction, shape } = setup(provider);
    const text = "he\nsecond line\nthird";
    prediction.input("\n", 110);
    prediction.input("second line", 120);
    prediction.input("\n", 130);
    prediction.input("third", 140);
    expect(prediction.surface(110 + timeout_ms)).toBeNull();
    const popup = structuredClone(shape.surface);
    popup.lines[popup.lines.length - 1] = "enter to select";
    prediction.receive(view(popup, 3n), 900);
    prediction.receive(view(composer.project(shape, { text, cursor: text.length })!, 4n), 1000);
    prediction.input("\x7f", 1010);
    expect(composer.inspect(prediction.surface(1011)!, provider)!.lines).toEqual(["he", "second line", "thir"]);
  });

  test(`${provider}: input reflows on resize while matching old frames retain the newest edit`, () => {
    const { prediction, shape } = setup(provider);
    const text = "hello there this is a test of wrapping some words";
    prediction.input(text.slice(2), 110);
    prediction.receive(view(composer.project(shape, { text, cursor: text.length })!, 3n), 150);
    prediction.input("\n", 160);
    prediction.input("tail", 170);
    const resized = { ...shape, width: shape.width - 7, surface: { ...shape.surface, cols: shape.surface.cols - 7 } };
    const remote = composer.project(resized, { text, cursor: text.length })!;
    prediction.receive(view(remote, 4n), 200);
    const expected = { text: text + "\ntail", cursor: text.length + 5 };
    expect(composer.matches(composer.inspect(prediction.surface(201)!, provider)!, expected)).toBe(true);
    prediction.receive(view(composer.project(resized, expected)!, 5n), 220);
    prediction.input("!", 230);
    expect(
      composer.matches(composer.inspect(prediction.surface(231)!, provider)!, {
        text: expected.text + "!",
        cursor: expected.cursor + 1,
      }),
    ).toBe(true);
  });

  test(`${provider}: a transient unmatched redraw hides the overlay without losing the draft`, () => {
    const { prediction, shape } = setup(provider);
    prediction.input("\n", 110);
    prediction.input("second", 120);
    prediction.receive(view(composer.project(shape, { text: "rendering", cursor: 9 })!, 3n), 150);
    expect(prediction.surface(151)).toBeNull();
    prediction.input("!", 160);
    prediction.receive(view(composer.project(shape, { text: "he\nsecond", cursor: 9 })!, 4n), 170);
    expect(composer.inspect(prediction.surface(171)!, provider)!.lines).toEqual(["he", "second!"]);
  });

  test(`${provider}: confirmed history suppresses late intermediate redraws only within the original deadline`, () => {
    const { prediction, shape } = setup(provider);
    prediction.input("l", 110);
    prediction.input("lo", 120);
    prediction.receive(view(composer.project(shape, { text: "hello", cursor: 5 })!, 3n), 150);
    prediction.receive(view(composer.project(shape, { text: "hel", cursor: 3 })!, 4n), 160);
    expect(composer.inspect(prediction.surface(161)!, provider)!.lines).toEqual(["hello"]);
    expect(prediction.surface(120 + timeout_ms)).toBeNull();
  });
}

test("Claude can wait for real box growth without discarding its predicted newline", () => {
  const { prediction, shape } = setup("claude");
  const crowded = structuredClone(shape.surface);
  crowded.lines[shape.top - 3] = "transcript above the prompt";
  prediction.receive(view(crowded, 3n), 110);
  prediction.input("\n", 120);
  expect(prediction.surface(121)).toBeNull();
  prediction.input("x", 130);
  prediction.receive(view(composer.project(shape, { text: "he\n", cursor: 3 })!, 4n), 150);
  expect(composer.inspect(prediction.surface(151)!, "claude")!.lines).toEqual(["he", "x"]);
});

test("multiline acquisition accepts provable hard breaks and refuses ambiguous soft wraps", () => {
  for (const provider of ["claude", "codex"] as const) {
    const { shape } = setup(provider);
    const value = "first\nsecond\n";
    const hard = composer.inspect(composer.project(shape, { text: value, cursor: value.length })!, provider)!;
    expect(composer.seed(hard)).toEqual({ text: value, cursor: value.length });
    const wrapped = "hello there this is a test of wrapping some words";
    const soft = composer.inspect(composer.project(shape, { text: wrapped, cursor: wrapped.length })!, provider)!;
    expect(composer.seed(soft)).toBeNull();
  }
});
