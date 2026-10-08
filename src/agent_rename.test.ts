import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  validName,
  peerIn,
  codexEmpty,
  codexHolds,
  command,
  max_name,
} from "./agent_rename";
import { Terminal } from "./pane/terminal";

test("names are one printable line", () => {
  expect(validName("refactor ⑂")).toBe(true);
  expect(validName(new Uint8Array([0xff]))).toBe(false);
  for (const name of [
    "",
    "two\nlines",
    "bell\x07",
    "\udfff",
    "x".repeat(max_name + 1),
  ])
    expect(validName(name)).toBe(false);
});
test("a session's peer is its live record's socket and key", async () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-peer-")),
    socket = "/tmp/cc-socks/1.sock";
  try {
    for (const [file, sessionId, peerProtocol, pid, messagingSocketPath] of [
      ["1.json", "live", 1, process.pid, socket],
      ["2.json", "future", 2, process.pid, socket],
      ["3.json", "gone", 1, 2147483647, socket],
      ["4.json", "keyless", 1, process.pid, "/tmp/cc-socks/4.sock"],
    ])
      writeFileSync(
        join(root, String(file)),
        JSON.stringify({ sessionId, peerProtocol, pid, messagingSocketPath }),
      );
    const digest = createHash("sha256").update(socket).digest("hex");
    writeFileSync(
      join(root, `${process.pid}.${digest}.key`),
      '{"peerToken":"secret"}',
    );
    expect(await peerIn(root, "LIVE")).toEqual({ socket, token: "secret" });
    for (const session of ["future", "gone", "keyless", "missing"])
      expect(await peerIn(root, session)).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
function screen(t: Terminal, input: string, footer: string) {
  t.feed("\x1b[2J\x1b[H\x1b[1;2m› \x1b[0mearlier prompt\r\n\r\n");
  t.feed(input);
  t.feed("\r\n  gpt · /tmp\r\n  ");
  t.feed(footer);
  t.feed("\x1b[3;3H");
}
test("only Codex's empty input box reads as empty", () => {
  const t = Terminal.create(60, 8);
  try {
    screen(
      t,
      "\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m",
      "\x1b[1m?\x1b[0m for shortcuts",
    );
    expect(codexEmpty(t)).toBe(true);
    expect(codexHolds(t, "Ask Codex to do anything")).toBe(false);
    for (const [input, footer] of [
      ["\x1b[1m›\x1b[0m Ask Codex to do anything", ""],
      [
        "\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m",
        "\x1b[1m?\x1b[0m / \x1b[1mesc\x1b[0m close",
      ],
      [
        "\x1b[1;7m› 1. Yes, proceed (y)\x1b[0m",
        "\x1b[1m?\x1b[0m for shortcuts",
      ],
      [
        "\x1b[1;2m› \x1b[0m\x1b[2mAsk Codex to do anything\x1b[0m",
        "\x1b[1m?\x1b[0m for shortcuts",
      ],
    ]) {
      screen(t, input, footer);
      expect(codexEmpty(t)).toBe(false);
    }
    screen(
      t,
      "\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m",
      "\x1b[2mreverse-i-search: \x1b[0m",
    );
    t.feed("\x1b[5;21H");
    expect(codexEmpty(t)).toBe(false);
    screen(
      t,
      "\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m",
      "\x1b[1m?\x1b[0m for shortcuts",
    );
    t.feed("\x1b]0;[ ! ] Action Required | codex\x07");
    expect(codexEmpty(t)).toBe(false);
  } finally {
    t.destroy();
  }
});
test("Codex's input row holds the typed command, cursor after it", () => {
  const t = Terminal.create(60, 8),
    typed = command("corgi ⑂");
  try {
    screen(t, "\x1b[1m›\x1b[0m \x1b[36m/rename\x1b[0m corgi ⑂", "");
    t.feed("\x1b[3;18H");
    expect(codexHolds(t, typed)).toBe(true);
    expect(codexHolds(t, "/rename corgi")).toBe(false);
    t.feed("\x1b[3;5H");
    expect(codexHolds(t, typed)).toBe(false);
  } finally {
    t.destroy();
  }
});
