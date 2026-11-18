import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as hostClipboard from "./host_clipboard";
import * as agentLauncher from "./agent_launcher";
import { byProvider } from "./providers";
import type { Transport } from "./mirror";
import { Prompt } from "./prompt";
import { Models, clipboardPacket, legacy } from "./prompt_pane";
import { Writer } from "./text";
import { Parser } from "./terminal_input";

const bytes = (text: string) => Buffer.from(text);

test("Kitty keys are encoded for the prompt without reparsing their bytes", () => {
  const keys = (text: string) => new Parser().feed(bytes(text)).map(input => Buffer.from(legacy(input)).toString());
  expect(keys("\x1b[47;5u")).toEqual(["\x1f"]);
  expect(keys("\x1b[99;5u")).toEqual(["\x03"]);
  expect(keys("\x1b[27u")).toEqual(["\x1b"]);
  expect(keys("\x1b[13;2u")).toEqual(["\x1b\r"]);
  expect(keys("\x1b[A\x1b[1;5D")).toEqual(["\x1b[A", "\x1b[1;5D"]);
  expect(keys("a\x1b[<0;10;5M")).toEqual(["a", "\x1b[<0;10;5M"]);
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

test("Escape before a fragmented paste cannot submit the standalone prompt", async () => {
  const payload = "first\rsecond\x1b",
    data = bytes(`\x1b\x1b[200~${payload}\x1b[201~`);
  for (let split = 0; split <= data.length; split++) {
    const prompt = new Prompt({
      mode: "pane",
      memory_root: folder(),
      daemon: { call: async () => ({ ok: true }), start: async () => ({ provider: "claude", session: "fake" }) },
    });
    prompt.catalog(
      [
        {
          provider: "claude",
          account: "",
          account_name: "",
          model: "fake",
          name: "Fake",
          efforts: [],
          default_effort: null,
        },
      ],
      [{ provider: "claude", account: "", model: "fake", name: "Fake", effort: null }],
      [],
    );
    prompt.show({ cwd: "", workspace: "", workspace_id: null, branch: "", focus: null, herd: [], mentions: [] });
    try {
      const parser = new Parser(),
        input = [...parser.feed(data.subarray(0, split)), ...parser.feed(data.subarray(split))];
      for (const event of input) {
        if (event.kind === "paste_start") prompt.pasteStart();
        else if (event.kind === "paste_end") prompt.pasteEnd();
        else if (event.kind === "paste") for (const byte of event.bytes) prompt.pasteByte(byte);
        else {
          const value = legacy(event);
          if (value.length > 1 && value[0] === 27) prompt.sequence(Buffer.from(value).toString("latin1"));
          else for (const byte of value) prompt.key(byte);
        }
      }
      expect(prompt.conversation.items.filter(item => item.kind === "user")).toEqual([]);
      expect(prompt.textField()?.text).toBe("first\nsecond");
      expect(input[0]).toMatchObject({ kind: "key", key: { codepoint: 27 } });
      expect(Buffer.concat(input.filter(event => event.kind === "paste").map(event => event.bytes)).toString()).toBe(
        payload,
      );
      expect(parser.due()).toBe(Infinity);
    } finally {
      await prompt.conversation.stop();
    }
  }
});

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
