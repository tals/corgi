import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Viewers } from "./viewers";
import { screen_text } from "./runtime";
import { EXE, Lines, Pty, deadline, registerCase, writeExecutable } from "./support";
import { FIXTURES, capture, voiceEnv } from "./voice_support";
import { concat, silence, tone } from "./fixtures/voice/make_pcm";
import * as config from "../src/build_config";

const relayed = new Set(["ping", "voice.watch", "voice.set", "voice.type"]),
  answers = new Set(["ready", "pong", "voice.muted", "voice.viewer", "closed"]);

class VoiceBridge extends Viewers {
  ptys: Pty[] = [];
  async tearDown() {
    for (const pty of this.ptys.splice(0)) await pty.close();
    await super.tearDown();
  }
  async voice() {
    return (await this.session()).voice?.state ?? null;
  }
  async capturePane(name: string) {
    const { command, file } = capture(this, name),
      pane = await this.new(command);
    await this.until(async () =>
      (await this.command("pane.read", { target: pane, view: "screen" })).text.includes("READY"),
    );
    const a = await this.newViewer();
    await a.focus(pane);
    return { pane, file, viewer: a };
  }
  typed(file: string) {
    return existsSync(file) ? readFileSync(file, "latin1") : "";
  }
  /** `corgi voice --ssh fakehost`, the fake ssh running the bridge here. */
  async remoteVoice(env: Record<string, string>, pcm = join(FIXTURES, "two.pcm")) {
    voiceEnv(this);
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }),
      port = probe.port;
    probe.stop(true);
    const files = {
      ssh: join(this.temp.name, "ssh.log"),
      transcript: join(this.temp.name, "transcript.log"),
      ffmpeg: join(this.temp.name, "ffmpeg.log"),
      whisper: join(this.temp.name, "whisper.log"),
    };
    const pty = await Pty.spawn([EXE, "voice", "--ssh", "fakehost", "--port", String(port)], {
      env: {
        ...this.env,
        CORGI_FAKE_PCM: pcm,
        CORGI_FAKE_SSH_LOG: files.ssh,
        CORGI_FAKE_SSH_TRANSCRIPT: files.transcript,
        CORGI_FAKE_FFMPEG_LOG: files.ffmpeg,
        CORGI_FAKE_WHISPER_LOG: files.whisper,
        ...env,
      },
      cwd: this.temp.name,
      cols: 100,
      rows: 30,
    });
    this.ptys.push(pty);
    return { pty, files };
  }
  lines(file: string): any[] {
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(line => JSON.parse(line));
  }
  async shows(pty: Pty, text: string | RegExp, timeout = 15_000) {
    const seen = (row: string) => (typeof text === "string" ? row.includes(text) : text.test(row));
    await pty.waitFor(output => screen_text(output, 100, 30).some(seen), timeout);
  }

  async test_dictation_crosses_ssh_as_json_lines_only() {
    const target = await this.capturePane("target");
    // A slow login (a prompt, a far host) must not cost the first link.
    const { pty, files } = await this.remoteVoice({
      CORGI_FAKE_SSH_DELAY: "4500",
      CORGI_FAKE_PCM_SPEED: "4",
      CORGI_FAKE_WHISPER_SCRIPT: "refactor the parser module\nsend",
    });
    await this.until(() => this.typed(target.file) === "refactor the parser module send", 15);
    await this.shows(pty, /✓ [\d:]{8} \(\d+ms\) send/);
    // A viewer's mute reaches the voice UI across the bridge within a second.
    await target.viewer.action("voice-mute");
    await this.shows(pty, "Mode:    MUTED", 1000);
    this.assertIn('"type":"voice.muted"', readFileSync(files.transcript, "utf8"));
    this.assertEqual(this.lines(files.ssh).length, 1);
    this.assertIn("Target:  fakehost", screen_text(pty.output, 100, 30)[2]);
    const lines = readFileSync(files.transcript, "utf8").trim().split("\n");
    this.assertEqual(JSON.parse(lines.find(l => l.startsWith("< "))!.slice(2)).type, "ready");
    for (const line of lines) {
      const message = JSON.parse(line.slice(2));
      if (line.startsWith("> ")) this.assertIn(message.op, relayed);
      else if (message.type !== undefined) this.assertIn(message.type, answers);
      else this.assertEqual(typeof message.id, "number");
      // Only words and state: nothing the size of audio.
      this.assertLess(line.length, 1024);
    }
    this.assertIn('"op":"voice.type"', readFileSync(files.transcript, "utf8"));
  }

  async test_a_drop_fails_what_was_said_and_reconnects_without_prompts() {
    const target = await this.capturePane("target");
    const { pty, files } = await this.remoteVoice({
      CORGI_FAKE_SSH_DROP_AFTER: "500",
      CORGI_FAKE_WHISPER_SCRIPT: "lost words\nafter the drop",
    });
    await this.shows(pty, "failed: not connected");
    await this.until(() => this.typed(target.file).includes("after the drop"), 15);
    this.assertNotIn("lost words", this.typed(target.file));
    // The microphone and Whisper ran on through the drop.
    this.assertEqual(this.lines(files.whisper).filter(l => l.start).length, 1);
    this.assertEqual(this.lines(files.ffmpeg).filter(l => Array.isArray(l)).length, 1);
    const invocations = readFileSync(files.ssh, "utf8")
      .trim()
      .split("\n")
      .map(l => JSON.parse(l));
    this.assertNotIn("BatchMode=yes", invocations[0]);
    this.assertIn("BatchMode=yes", invocations[1]);
  }

  async test_mute_survives_a_reconnect() {
    const target = await this.capturePane("target");
    const pcm = join(this.temp.name, "late.pcm");
    writeFileSync(pcm, new Uint8Array(concat(silence(7), tone(1.5), silence(3)).buffer));
    const { pty, files } = await this.remoteVoice(
      { CORGI_FAKE_SSH_DROP_AFTER: "4000", CORGI_FAKE_WHISPER_SCRIPT: "while muted" },
      pcm,
    );
    await this.until(async () => (await this.voice()) === "listening", 10);
    pty.write("m");
    await this.until(async () => (await this.voice()) === "muted", 2);
    // The drop ends the presence; the reconnect brings it back muted.
    await this.until(async () => (await this.voice()) === null, 5);
    await this.until(async () => (await this.voice()) === "muted", 10);
    // The speech, which comes after the reconnect, is never transcribed or typed.
    await this.until(() => this.lines(files.ffmpeg).includes("done"), 20);
    this.assertEqual(this.lines(files.whisper).filter(l => l.request).length, 0);
    this.assertEqual(this.typed(target.file), "");
    this.assertEqual(await this.voice(), "muted");
  }

  async test_the_remote_voice_json_is_ignored() {
    const target = await this.capturePane("target"),
      remote = join(this.temp.name, "remote-state");
    mkdirSync(join(remote, "corgi"), { recursive: true });
    // A threshold nothing reaches: were it read, nothing would be typed.
    writeFileSync(join(remote, "corgi/voice.json"), JSON.stringify({ threshold: 100 }));
    await this.remoteVoice({
      CORGI_FAKE_SSH_STATE: remote,
      CORGI_FAKE_PCM_SPEED: "4",
      CORGI_FAKE_WHISPER_SCRIPT: "refactor",
    });
    await this.until(() => this.typed(target.file) === "refactor", 15);
  }

  async test_an_old_remote_corgi_is_named() {
    const old = join(this.temp.name, "old-bin");
    writeExecutable(
      join(old, "corgi"),
      "#!/bin/sh\necho 'corgi: unknown command __voice-bridge; see corgi --help' >&2\nexit 2\n",
    );
    voiceEnv(this);
    const pty = await Pty.spawn([EXE, "voice", "--ssh", "fakehost"], {
      env: { ...this.env, PATH: `${old}:${this.env.PATH}` },
      cwd: this.temp.name,
    });
    this.ptys.push(pty);
    await pty.waitFor(
      `corgi: Corgi on fakehost has no voice support; install Corgi ${config.releaseVersion} or newer there`,
    );
    this.assertEqual(await pty.proc.exited, 1);
    this.assertEqual(await this.voice(), null);
  }

  async test_the_bridge_leaves_when_pings_stop() {
    voiceEnv(this);
    const bridge = Bun.spawn([EXE, "__voice-bridge"], {
        env: this.env,
        cwd: this.temp.name,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      }),
      lines = new Lines();
    void (async () => {
      for await (const chunk of bridge.stdout) lines.feed(Buffer.from(chunk).toString());
    })();
    this.assertEqual(JSON.parse(await lines.next()).type, "ready");
    bridge.stdin.write(JSON.stringify({ id: 1, op: "voice.watch", muted: false, available: true }) + "\n");
    bridge.stdin.flush();
    this.assertTrue(JSON.parse(await lines.next()).ok);
    await this.until(async () => (await this.voice()) === "listening");
    // No ping ever comes: the bridge goes within 3 s, and the presence with it.
    this.assertEqual(await deadline(bridge.exited, 4500, "the bridge kept running"), 0);
    await this.until(async () => (await this.voice()) === null, 5);
  }
}
registerCase("VoiceBridge", VoiceBridge, { inherited: false });
