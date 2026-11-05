import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as hostClipboard from "./host_clipboard";
import * as agentLauncher from "./agent_launcher";
import { byProvider } from "./providers";
import type { Transport } from "./mirror";
import { Prompt } from "./prompt";
import { Models, clipboardPacket, legacy, tokens } from "./prompt_pane";
import { Writer } from "./text";

const bytes = (text: string) => Buffer.from(text);

test("input splits into keys, sequences, pastes and mouse reports", () => {
  expect(tokens(bytes("hé\x1b[A\x1bb\x1b\r")).tokens).toEqual([
    { kind: "byte", byte: 0x68 },
    { kind: "byte", byte: 0xc3 },
    { kind: "byte", byte: 0xa9 },
    { kind: "sequence", text: "\x1b[A" },
    { kind: "sequence", text: "\x1bb" },
    { kind: "sequence", text: "\x1b\r" },
  ]);
  expect(tokens(bytes("\x1b[200~line one\r\nlíne two\x1b[201~x")).tokens).toEqual([
    { kind: "paste", text: "line one\r\nlíne two" },
    { kind: "byte", byte: 0x78 },
  ]);
  expect(tokens(bytes("\x1b[<0;10;5M\x1b[<0;10;5m\x1b[<65;3;4M\x1b[<35;7;8M")).tokens).toEqual([
    { kind: "mouse", button: 0, x: 9, y: 4, release: false },
    { kind: "mouse", button: 0, x: 9, y: 4, release: true },
    { kind: "mouse", button: 65, x: 2, y: 3, release: false },
    { kind: "mouse", button: 35, x: 6, y: 7, release: false },
  ]);
  expect(tokens(bytes("\x1bOB")).tokens).toEqual([{ kind: "sequence", text: "\x1bOB" }]);
});

test("an unfinished sequence or paste waits for the rest", () => {
  for (const partial of ["\x1b", "\x1b[", "\x1b[1;5", "\x1b[200~half a pas"]) {
    const split = tokens(bytes("a" + partial));
    expect(split.tokens).toEqual([{ kind: "byte", byte: 0x61 }]);
    expect(Buffer.from(split.rest).toString()).toBe(partial);
  }
  const first = tokens(bytes("\x1b[200~abc"));
  expect(tokens([...first.rest, ...bytes("def\x1b[201~")]).tokens).toEqual([{ kind: "paste", text: "abcdef" }]);
});

test("Kitty's key reports reach the card as the viewer passes keys to it, Ctrl+/ included", () => {
  const keys = (text: string) => tokens(bytes(text)).tokens.flatMap(legacy);
  expect(keys("\x1b[47;5u")).toEqual([{ kind: "byte", byte: 0x1f }]);
  expect(keys("\x1b[99;5u")).toEqual([{ kind: "byte", byte: 3 }]);
  expect(keys("\x1b[27u")).toEqual([{ kind: "byte", byte: 0x1b }]);
  expect(keys("\x1b[13;2u")).toEqual([{ kind: "sequence", text: "\x1b\r" }]);
  expect(keys("\x1b[A\x1b[1;5D")).toEqual([
    { kind: "sequence", text: "\x1b[A" },
    { kind: "sequence", text: "\x1b[1;5D" },
  ]);
  expect(keys("a\x1b[<0;10;5M")).toEqual([
    { kind: "byte", byte: 0x61 },
    { kind: "mouse", button: 0, x: 9, y: 4, release: false },
  ]);
});

test("clipboard packets end at ST or BEL, and wait for the rest", () => {
  expect(
    tokens(bytes("\x1b]5522;type=read:status=OK:pw=b3Rw\x1b\\a\x1b]5522;type=read:status=DONE\x07")).tokens,
  ).toEqual([
    { kind: "clipboard", text: "type=read:status=OK:pw=b3Rw" },
    { kind: "byte", byte: 0x61 },
    { kind: "clipboard", text: "type=read:status=DONE" },
  ]);
  for (const partial of ["\x1b]", "\x1b]55", "\x1b]5522;type=read", "\x1b]5522;type=read\x1b"]) {
    const split = tokens(bytes("a" + partial));
    expect(split.tokens).toEqual([{ kind: "byte", byte: 0x61 }]);
    expect(Buffer.from(split.rest).toString()).toBe(partial);
  }
  // Alt and ] from a legacy terminal stay a key.
  expect(tokens(bytes("\x1b]x")).tokens).toEqual([
    { kind: "sequence", text: "\x1b]" },
    { kind: "byte", byte: 0x78 },
  ]);
});

const folders: string[] = [];
afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function folder() {
  const dir = mkdtempSync(join(tmpdir(), "corgi-pane-"));
  folders.push(dir);
  return dir;
}
const b64 = (text: string | Buffer) => Buffer.from(text).toString("base64");

test("a pane loads workspace models and refreshes when accounts change", async () => {
  const preview = agentLauncher.preview({ installed: byProvider(() => false) }),
    context = {
      cwd: "/workspace/project",
      workspace: "",
      workspace_id: 1,
      branch: "",
      focus: null,
      herd: [],
      mentions: [],
    },
    prompt = new Prompt({
      daemon: { call: async () => ({ ok: true }), start: async () => ({ provider: "claude", session: "s" }) },
      memory_root: folder(),
      mode: "pane",
    });
  let modelReads = 0,
    redraws = 0;
  prompt.changed = () => {
    redraws++;
  };
  const conn = {
      request: async (op: string) =>
        op === "agent.preview"
          ? { ok: true, preview }
          : {
              ok: true,
              result: { workspaces: [{ id: 1, cwd: "/tmp", model: { nodes: [], tabs: [], revision: 0 } }] },
            },
    } as Transport,
    models = new Models(conn, prompt, context, async (provider, _account, _quit, cwd) => {
      modelReads++;
      if (cwd !== context.cwd) return [];
      return [{ id: provider === "claude" ? "claude-sonnet-5-5" : "gpt-6-astra", name: provider }];
    });
  prompt.show(context);
  try {
    models.poll(0);
    await Bun.sleep(0);
    expect(prompt.current()).toBeNull();
    expect(modelReads).toBe(0);
    preview.installed.claude = true;
    preview.pending = false;
    models.poll(5000);
    const before = redraws;
    await Bun.sleep(0);
    expect(prompt.current()?.model).toBe("claude-sonnet-5-5");
    expect(redraws).toBeGreaterThan(before);
    preview.installed.claude = false;
    preview.installed.codex = true;
    models.poll(10000);
    await Bun.sleep(0);
    expect(prompt.current()?.model).toBe("gpt-6-astra");
    expect(modelReads).toBe(2);
  } finally {
    models.close();
  }
});

test("a paste event brings the card its image, else its text", () => {
  const prompt = new Prompt({
      daemon: { call: async () => ({ ok: true }), start: async () => ({ provider: "claude", session: "s" }) },
      memory_root: folder(),
      mode: "pane",
    }),
    clipboard = Object.assign(new hostClipboard.State(), { folder: folder() });
  prompt.show({ cwd: "", workspace: "", workspace_id: null, branch: "", focus: null, herd: [], mentions: [] });
  const event = (listing: string, pw: string) =>
    [
      `type=read:status=OK:pw=${pw}`,
      `type=read:status=DATA:mime=Lg==:pw=${pw};${b64(listing)}`,
      `type=read:status=DONE:pw=${pw}`,
    ]
      .map(raw => clipboardPacket(clipboard, prompt, raw, 0))
      .join("");
  const reply = (mime: string, data: Buffer) =>
    [
      "type=read:id=corgi:status=OK",
      `type=read:id=corgi:status=DATA:mime=${b64(mime)};${b64(data)}`,
      "type=read:id=corgi:status=DONE",
    ]
      .map(raw => clipboardPacket(clipboard, prompt, raw, 0))
      .join("");
  // The event's password reads the image the daemon holds for it.
  expect(event("image/png", "b3Rw")).toBe(
    `\x1b]5522;type=read:id=corgi:pw=b3Rw:name=Q29yZ2k=;${b64("image/png")}\x1b\\`,
  );
  expect(reply("image/png", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]))).toBe("");
  expect(prompt.attached()).toEqual(["Image 1"]);
  // Text wins when the paste brought both.
  expect(event("text/plain image/png", "cHc=")).toContain(`;${b64("text/plain")}\x1b\\`);
  reply("text/plain", Buffer.from("hello"));
  expect(prompt.attached()).toEqual(["Image 1"]);
  const w = new Writer();
  prompt.draw(w, 80, 24, null, 0);
  expect(w.s.replace(/\x1b\[[\d;]*[A-Za-z]/g, "")).toContain("hello█");
});
