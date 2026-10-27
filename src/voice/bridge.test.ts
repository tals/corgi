import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SshLink } from "./bridge";

const saved = { ssh: process.env.CORGI_VOICE_SSH, reply: process.env.CORGI_FAKE_BRIDGE_REPLY },
  dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of [
    ["CORGI_VOICE_SSH", saved.ssh],
    ["CORGI_FAKE_BRIDGE_REPLY", saved.reply],
  ] as const)
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
});
/** Stands in for ssh and the bridge at once: greets, answers pings, and
 * answers the watch with `reply` in one write (ID is the request's id). */
function remote(reply: string) {
  const dir = mkdtempSync(join(tmpdir(), "corgi-bridge-"));
  dirs.push(dir);
  const file = join(dir, "ssh");
  writeFileSync(
    file,
    `#!/usr/bin/env bun
process.stdout.write(JSON.stringify({ type: "ready", corgi: "test", bridge: 1 }) + "\\n");
process.stdin.on("data", chunk => {
  for (const line of String(chunk).split("\\n")) {
    if (!line) continue;
    const req = JSON.parse(line);
    if (req.op === "ping") process.stdout.write(JSON.stringify({ type: "pong" }) + "\\n");
    else if (req.op === "voice.watch") process.stdout.write(process.env.CORGI_FAKE_BRIDGE_REPLY.replaceAll("ID", String(req.id)));
  }
});
`,
    { mode: 0o755 },
  );
  process.env.CORGI_VOICE_SSH = file;
  process.env.CORGI_FAKE_BRIDGE_REPLY = reply;
}

test("a watch answered and closed in the same read attaches nothing", async () => {
  const ok = JSON.stringify({ id: "ID", ok: true, voice_id: "v-1", muted: false, viewer: true, focus: null }).replace(
      '"ID"',
      "ID",
    ),
    closed = JSON.stringify({ type: "closed", reason: "runtime_gone" });
  remote(`${ok}\n${closed}\n`);
  const link = await SshLink.connect("devbox", { deadline_ms: 2000 });
  const lost: string[] = [];
  link.on("closed", reason => lost.push(reason));
  await expect(link.watch({ muted: false, available: true })).rejects.toThrow("ConnectionClosed");
  // The watch failed, so the session retries from that; no closed event on top.
  expect(lost).toEqual([]);
  await expect(link.type("x")).rejects.toThrow("NotConnected");
  link.close();
});

test("a watch answered on its own attaches, and a later close is reported", async () => {
  const ok = JSON.stringify({
    id: "ID",
    ok: true,
    voice_id: "v-1",
    muted: true,
    viewer: true,
    focus: "dictation",
  }).replace('"ID"', "ID");
  remote(`${ok}\n`);
  const link = await SshLink.connect("devbox", { deadline_ms: 2000 });
  const lost: string[] = [];
  link.on("closed", reason => lost.push(reason));
  expect(await link.watch({ muted: true, available: true })).toEqual({
    voice_id: "v-1",
    muted: true,
    viewer: true,
    focus: "dictation",
  });
  link.close();
  expect(lost).toEqual([]);
});
