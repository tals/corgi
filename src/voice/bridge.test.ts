import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SshLink, remote as remote_command } from "./bridge";

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
/** Stands in for ssh and the bridge at once: greets with `greeting` (a
 * refusal ends it), answers pings unless `pong` is false, answers the watch
 * with `reply` in one write (ID is the request's id), and answers a set with
 * an endless line when `flood` is set. */
function remote(reply: string, opts: { greeting?: object; pong?: boolean; flood?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "corgi-bridge-"));
  dirs.push(dir);
  const file = join(dir, "ssh"),
    greeting = opts.greeting ?? { type: "ready", corgi: "test", bridge: 1 };
  writeFileSync(
    file,
    `#!/usr/bin/env bun
const greeting = ${JSON.stringify(greeting)}, pong = ${opts.pong ?? true}, flood = ${opts.flood ?? false};
process.stdout.write(JSON.stringify(greeting) + "\\n");
if (greeting.type === "refused") process.exit(0);
process.stdin.on("data", chunk => {
  for (const line of String(chunk).split("\\n")) {
    if (!line) continue;
    const req = JSON.parse(line);
    if (req.op === "ping") {
      if (pong) process.stdout.write(JSON.stringify({ type: "pong" }) + "\\n");
    } else if (req.op === "voice.watch") process.stdout.write(process.env.CORGI_FAKE_BRIDGE_REPLY.replaceAll("ID", String(req.id)));
    else if (req.op === "voice.set" && flood) process.stdout.write("x".repeat(70 * 1024));
  }
});
`,
    { mode: 0o755 },
  );
  process.env.CORGI_VOICE_SSH = file;
  process.env.CORGI_FAKE_BRIDGE_REPLY = reply;
}
const attached = JSON.stringify({
  id: "ID",
  ok: true,
  voice_id: "v-1",
  muted: false,
  viewer: true,
  focus: null,
}).replace('"ID"', "ID");

test("the host is told which bridge this side speaks", () => {
  expect(remote_command).toEndWith("__voice-bridge 1'");
});

test("a refusing or mismatched bridge is named for what the user must fix", async () => {
  const cases: [object, string][] = [
    [{ type: "refused", reason: "no_runtime", detail: "NoRuntime" }, "NoRuntime"],
    [{ type: "refused", reason: "daemon_lacks_voice", detail: "DaemonLacksVoice" }, "DaemonLacksVoice"],
    // A host with a newer bridge refuses ours and says which it speaks.
    [{ type: "refused", reason: "bridge_version", bridge: 2 }, "LocalTooOld"],
    // An older one does not know to say it.
    [{ type: "refused", reason: "bridge_version" }, "RemoteTooOld"],
    [{ type: "ready", corgi: "test", bridge: 2 }, "LocalTooOld"],
    [{ type: "ready", corgi: "test" }, "RemoteTooOld"],
  ];
  for (const [greeting, error] of cases) {
    remote("", { greeting });
    await expect(SshLink.connect("devbox", { deadline_ms: 2000 })).rejects.toThrow(error);
  }
});

test("a bridge that stops answering pings is lost", async () => {
  remote(`${attached}\n`, { pong: false });
  const link = await SshLink.connect("devbox", { deadline_ms: 2000 }),
    lost: string[] = [];
  link.on("closed", reason => lost.push(reason));
  await link.watch({ muted: false, available: true });
  const end = Date.now() + 8000;
  while (!lost.length && Date.now() < end) await Bun.sleep(20);
  expect(lost).toEqual(["ping_timeout"]);
}, 10_000);

test("a line past 64 KiB ends the link as a protocol error", async () => {
  remote(`${attached}\n`, { flood: true });
  const link = await SshLink.connect("devbox", { deadline_ms: 2000 }),
    lost: string[] = [];
  link.on("closed", reason => lost.push(reason));
  await link.watch({ muted: false, available: true });
  await expect(link.set({ muted: true })).rejects.toThrow("NotConnected");
  expect(lost).toEqual(["protocol_error"]);
});

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
