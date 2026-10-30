import { expect, spyOn, test } from "bun:test";
import { toBuffer, type Pointer } from "bun:ffi";
import { call, symbols } from "../native_bridge";
import * as json from "../json";
import * as surface from "./surface";
import { Terminal } from "./terminal";

function reply(bytes: string) {
  const payload = Buffer.from(bytes),
    native = symbols as unknown as {
      app_terminal_json(handle: Pointer, input: Pointer, length: number, output: Pointer, capacity: number): number;
    };
  return spyOn(native, "app_terminal_json").mockImplementation((_handle, _input, _length, output, capacity) => {
    if (payload.length > capacity) return -payload.length;
    toBuffer(output, 0, capacity).set(payload);
    return payload.length;
  });
}

test("surface JSON normalizes decimal receipts without reviving unrelated fields", () => {
  const terminal = new Terminal(20, 4);
  const original = terminal.surface(1),
    parse = spyOn(json, "parse");
  try {
    for (const receipt of [0n, 9007199254740991n, 9007199254740992n, 18446744073709551615n]) {
      const expected = {
        ...original,
        surface: {
          ...original.surface,
          lines: ['9007199254740993 界 é 🐕 "quoted"', "\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\"],
          images: [
            {
              image: { id: "18446744073709551615", width: 20, height: 30, format: 32, bytes: 2400 },
              x: 0.25,
              y: 1.5,
              width: 2.75,
              height: 3.25,
              source_x: 0,
              source_y: 0,
              source_width: 20,
              source_height: 30,
              z: -1,
            },
          ],
        },
        stamp: { identity: receipt, revision: receipt, offset: Number.MAX_SAFE_INTEGER },
      };
      const native = reply(
        JSON.stringify({
          value: {
            ...expected,
            stamp: { ...expected.stamp, identity: String(receipt), revision: String(receipt) },
          },
        }),
      );
      try {
        const captured = terminal.surface(1, Number.MAX_SAFE_INTEGER);
        expect(captured).toEqual(expected);
        expect(json.stringify(captured)).toBe(json.stringify(expected));
      } finally {
        native.mockRestore();
      }
    }
    expect(parse).not.toHaveBeenCalled();
  } finally {
    parse.mockRestore();
    terminal.destroy();
  }
});

test("surface decoding retains oversized reply retries and native errors", () => {
  const terminal = new Terminal(20, 4),
    original = terminal.surface(1),
    value = { ...original, surface: { ...original.surface, lines: ["界".repeat(30000)] } },
    native = reply(
      JSON.stringify({
        value: {
          ...value,
          stamp: { ...value.stamp, identity: String(value.stamp.identity), revision: String(value.stamp.revision) },
        },
      }),
    );
  try {
    expect(terminal.surface(1)).toEqual(value);
    expect(native).toHaveBeenCalledTimes(2);
  } finally {
    native.mockRestore();
    terminal.destroy();
  }
  const failure = reply('{"err":"CaptureFailed"}');
  try {
    expect(() => call(1n, { op: "surface", pane: 1 })).toThrow("CaptureFailed");
  } finally {
    failure.mockRestore();
  }
});

test("other native JSON operations still preserve wide integer tokens", () => {
  const native = reply('{"value":{"revision":18446744073709551615}}');
  try {
    expect(call(1n, { op: "info" })).toEqual({ revision: 18446744073709551615n });
  } finally {
    native.mockRestore();
  }
});

test("real surface receipts match scalar native metadata across updates and borrowed viewports", () => {
  const terminal = new Terminal(20, 4);
  try {
    for (const text of ["", "history 界\r\n".repeat(12), "\x1b[1;1Hchanged", "\x1b[?1049hALT"]) {
      terminal.feed(text);
      for (const offset of [null, 0]) {
        const captured = terminal.surface(1, offset);
        expect(captured.stamp).toEqual(surface.stamp(terminal, offset));
        expect(captured.surface.lines).toHaveLength(4);
      }
    }
  } finally {
    terminal.destroy();
  }
});
