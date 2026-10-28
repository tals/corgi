import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Viewers } from "./viewers";
import { screen_text } from "./runtime";
import { displayWidth } from "../src/text";
import { EXE, Pty, registerCase, run } from "./support";
import { FIXTURES, bracketed, capture, modelFile, voiceClient, voiceEnv } from "./voice_support";
import * as models from "../src/voice/models";
import { concat, silence, tone } from "./fixtures/voice/make_pcm";

const voiceOps = ["voice.watch", "voice.set", "voice.type", "voice.toggle"];

class Voice extends Viewers {
  ptys: Pty[] = [];
  async tearDown() {
    // Voice mode first, so its whisper-server and ffmpeg are gone before the leak check.
    for (const pty of this.ptys.splice(0)) await pty.close();
    await super.tearDown();
  }
  /** Waits for voice mode's screen to show `text` on one row. */
  /** Waits for a row with `text`; a pattern matches a history row as `✓ 14:02:31 (156ms) text`. */
  async shows(pty: Pty, text: string | RegExp, timeout = 10_000) {
    const seen = (row: string) => (typeof text === "string" ? row.includes(text) : text.test(row));
    await pty.waitFor(output => screen_text(output, 100, 30).some(seen), timeout);
  }
  async voice() {
    return (await this.session()).voice?.state ?? null;
  }
  /** A pane running the capture program, once it has set its modes. */
  async capturePane(name: string, modes = "") {
    const { command, file } = capture(this, name, modes),
      pane = await this.new(command);
    await this.until(async () =>
      (await this.command("pane.read", { target: pane, view: "screen" })).text.includes("READY"),
    );
    return { pane, file };
  }
  /** Waits for `text` in the pane's capture: long enough for whisper-server to
   * start and a few utterances to play, even on a busy CI runner. */
  async captured(file: string, text: string, timeout = 15) {
    await this.until(() => existsSync(file) && readFileSync(file, "latin1").includes(text), timeout);
    return readFileSync(file, "latin1");
  }

  async test_capabilities_list_the_voice_ops() {
    const hello = await this.rpc({ op: "hello", protocol: 1 });
    for (const op of voiceOps) this.assertIn(op, hello.capabilities);
  }

  async test_one_voice_per_runtime_and_presence_follows_the_connection() {
    const first = await voiceClient(this);
    const { voice_id, muted } = await first.watch({ muted: false, available: true });
    this.assertRegex(voice_id, /^v-/);
    this.assertFalse(muted);
    await this.until(async () => (await this.voice()) === "listening");
    const second = await voiceClient(this);
    await this.assertRejects(second.watch({ muted: false, available: true }), "VoiceAttached");
    first.close();
    await this.until(async () => (await this.voice()) === null, 5);
    const third = await voiceClient(this);
    this.assertTrue((await third.watch({ muted: true, available: true })).muted);
    await this.until(async () => (await this.voice()) === "muted");
  }

  async test_presence_ends_when_heartbeats_stop() {
    const link = await voiceClient(this, { heartbeat_ms: 60_000 });
    await link.watch({ muted: false, available: true });
    await this.until(async () => (await this.voice()) === "listening");
    // The lease is 3 s; the socket stays open, so only the lease can end it.
    await this.until(async () => (await this.voice()) === null, 5);
  }

  async test_text_goes_to_the_focused_pane_of_the_last_active_viewer() {
    const one = await this.capturePane("one", bracketed),
      two = await this.capturePane("two");
    const a = await this.newViewer();
    await a.focus(one.pane);
    const b = await this.newViewer();
    await b.focus(two.pane);
    const link = await voiceClient(this);
    await link.watch({ muted: false, available: true });
    const viewers = (await this.rpc({ op: "viewer.list" })).viewers;
    this.assertEqual(await link.type("refactor the parser module"), { pane: two.pane, viewer: viewers.at(-1).id });
    let bytes = await this.captured(two.file, "refactor the parser module");
    this.assertNotIn("\x1b[200~", bytes);
    // Escape sequences and returns cannot end the paste or submit.
    await link.type("evil \x1b[201~ and\rmore");
    bytes = await this.captured(two.file, "more");
    this.assertNotIn("\r", bytes);
    this.assertNotIn("\x1b", bytes);
    // Using viewer a makes it the target; its pane takes bracketed pastes.
    await a.input("\x1b[<35;5;5M");
    this.assertEqual((await link.type("into one")).pane, one.pane);
    bytes = await this.captured(one.file, "\x1b[201~");
    this.assertIn("\x1b[200~into one\x1b[201~", bytes);
    // A focus change retargets.
    await a.focus(two.pane);
    await a.input("\x1b[<35;5;5M");
    this.assertEqual((await link.type("follows focus")).pane, two.pane);
    await this.captured(two.file, "follows focus");
  }

  async test_typing_without_a_target_fails_by_name() {
    const own = await this.capturePane("own");
    const link = await voiceClient(this);
    await link.watch({ pane: own.pane, muted: false, available: true });
    await this.assertRejects(link.type("nobody"), "NoViewer");
    const a = await this.newViewer();
    await a.focus(own.pane);
    await this.assertRejects(link.type("myself"), "VoicePane");
    this.assertFalse(readFileSync(own.file, "latin1").includes("myself"));
  }

  async test_viewer_toggle_reaches_the_voice() {
    const link = await voiceClient(this),
      pushed: boolean[] = [];
    link.on("muted", muted => pushed.push(muted));
    await link.watch({ muted: false, available: true });
    this.assertEqual((await this.rpc({ op: "voice.toggle", protocol: 3 })).muted, true);
    // Text already on its way when the viewer muted is refused.
    await this.assertRejects(link.type("late"), "VoiceMuted");
    await this.until(() => pushed.includes(true), 1);
    this.assertEqual(await this.voice(), "muted");
    await link.set({ muted: false });
    await this.until(async () => (await this.voice()) === "listening", 1);
    // A voice that cannot listen shows muted, and a toggle keeps it so.
    await link.set({ available: false });
    await this.until(async () => (await this.voice()) === "muted", 1);
    this.assertEqual((await this.rpc({ op: "voice.toggle", protocol: 3 })).muted, true);
    this.assertEqual(await this.voice(), "muted");
    link.close();
    await this.until(async () => (await this.voice()) === null, 5);
    await this.assertRejects(this.rpc({ op: "voice.toggle", protocol: 3 }), "NoVoice");
  }

  /** Voice mode in a terminal, with the fakes and a port of its own. */
  async voiceMode(env: Record<string, string>, args: string[] = []) {
    voiceEnv(this);
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }),
      port = probe.port;
    probe.stop(true);
    const logs = {
      ffmpeg: join(this.temp.name, "ffmpeg.log"),
      whisper: join(this.temp.name, "whisper.log"),
    };
    const pty = await Pty.spawn([EXE, "voice", "--port", String(port), ...args], {
      env: {
        ...this.env,
        CORGI_FAKE_FFMPEG_LOG: logs.ffmpeg,
        CORGI_FAKE_WHISPER_LOG: logs.whisper,
        CORGI_FAKE_PCM_SPEED: "4",
        ...env,
      },
      cwd: this.temp.name,
      cols: 100,
      rows: 30,
    });
    this.ptys.push(pty);
    return { pty, logs };
  }
  lines(file: string): any[] {
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(line => JSON.parse(line));
  }

  async test_voice_mode_types_what_is_said_without_submitting() {
    const target = await this.capturePane("target"),
      a = await this.newViewer();
    await a.focus(target.pane);
    const { pty, logs } = await this.voiceMode(
      {
        CORGI_FAKE_PCM: join(FIXTURES, "two.pcm"),
        CORGI_FAKE_WHISPER_SCRIPT: "refactor the parser module\n[BLANK_AUDIO]",
      },
      ["--verbose"],
    );
    await this.until(async () => (await this.voice()) === "listening", 10);
    const bytes = await this.captured(target.file, "refactor the parser module");
    await this.shows(pty, /✓ \d\d:\d\d:\d\d \(\d+ms\) refactor the parser module/);
    await this.until(() => this.lines(logs.whisper).filter(l => l.request).length === 2, 10);
    this.assertEqual(readFileSync(target.file, "latin1"), "refactor the parser module");
    this.assertNotIn("\r", bytes);
    this.assertTrue(this.lines(logs.whisper)[0].vad);
    pty.write("q");
    this.assertEqual(await pty.proc.exited, 0);
    // Quitting stops its whisper-server and ffmpeg and ends the presence.
    await this.until(async () => (await this.voice()) === null, 5);
    // --verbose kept a line per utterance, dropped ones too, outside the screen.
    const log = readFileSync(join(this.env.XDG_STATE_HOME!, "corgi/voice.log"), "utf8");
    this.assertRegex(log, /utterance 1: delivered duration=[\d.]+s transcribe_ms=\d+ deliver_ms=\d+/);
    this.assertRegex(log, /utterance 2: dropped \(not speech\)/);
    this.assertIn("whisper-server ready", log);
  }

  async test_consecutive_utterances_join_with_a_space_and_nothing_submits() {
    const target = await this.capturePane("target"),
      a = await this.newViewer();
    await a.focus(target.pane);
    const speech = join(this.temp.name, "three.pcm"),
      burst = concat(tone(1), silence(3));
    writeFileSync(speech, new Uint8Array(concat(burst, burst, burst).buffer));
    const { pty } = await this.voiceMode({
      CORGI_FAKE_PCM: speech,
      CORGI_FAKE_WHISPER_SCRIPT: "um, send\nthe next step is to refactor\nnext",
    });
    // Words that once were commands are text like any other.
    await this.captured(target.file, "refactor next");
    this.assertEqual(readFileSync(target.file, "latin1"), "send the next step is to refactor next");
    await this.shows(pty, /✓ [\d:]{8} \(\d+ms\) next/);
  }

  async test_typing_between_utterances_starts_the_next_fresh() {
    const target = await this.capturePane("target"),
      a = await this.newViewer();
    await a.focus(target.pane);
    const link = await voiceClient(this);
    await link.watch({ muted: false, available: true });
    await link.type("first");
    await link.type("joined");
    await this.captured(target.file, "first joined");
    // Anything typed in between means the next utterance gets no space.
    await a.input("x");
    await this.captured(target.file, "joinedx");
    await link.type("fresh");
    this.assertEqual(await this.captured(target.file, "fresh"), "first joinedxfresh");
  }

  async test_without_a_viewer_voice_holds_off_then_names_the_pane() {
    const pane = await this.new("sleep 60", "notes");
    const { pty, logs } = await this.voiceMode({
      CORGI_FAKE_PCM: join(FIXTURES, "speech.pcm"),
      CORGI_FAKE_WHISPER_SCRIPT: "hello",
    });
    await this.shows(pty, "No Corgi window is attached");
    // What is said with no viewer attached is never transcribed, nor reported as a failure.
    await this.until(() => this.lines(logs.ffmpeg).includes("done"), 10);
    this.assertEqual(this.lines(logs.whisper).filter(l => l.request).length, 0);
    this.assertFalse(screen_text(pty.output, 100, 30).join("\n").includes("failed"));
    const a = await this.newViewer();
    await a.focus(pane);
    await this.shows(pty, "Mode:    Listening");
    await this.shows(pty, "Target:  local → notes");
  }

  async test_noise_types_nothing() {
    const target = await this.capturePane("target"),
      a = await this.newViewer();
    await a.focus(target.pane);
    const { pty, logs } = await this.voiceMode({ CORGI_FAKE_PCM: join(FIXTURES, "noise.pcm") });
    await this.until(() => this.lines(logs.ffmpeg).includes("done"), 10);
    this.assertEqual(this.lines(logs.whisper).filter(l => l.request).length, 0);
    // The noise ends in silence, so an utterance it started would have ended too.
    await this.shows(pty, "Say something");
    this.assertFalse(existsSync(target.file) && readFileSync(target.file).length > 0);
  }

  async test_a_crashed_server_is_not_restarted_until_the_filter_switches() {
    const target = await this.capturePane("target"),
      a = await this.newViewer();
    await a.focus(target.pane);
    const { pty, logs } = await this.voiceMode({
      CORGI_FAKE_PCM: join(FIXTURES, "two.pcm"),
      CORGI_FAKE_WHISPER_SCRIPT: "first words\nsecond words",
      CORGI_FAKE_WHISPER_MODE: "crash_after:1",
    });
    await this.captured(target.file, "first words");
    await this.shows(pty, "The Whisper server stopped: press f for a fresh one");
    await this.shows(pty, "failed: server crashed");
    await this.until(async () => (await this.voice()) === "muted");
    this.assertEqual(this.lines(logs.whisper).filter(l => l.start).length, 1);
    // Switching the filter starts a fresh server, without it, and voice listens again.
    pty.write("f");
    await this.until(() => this.lines(logs.whisper).filter(l => l.start).length === 2, 10);
    this.assertFalse(this.lines(logs.whisper).filter(l => l.start)[1].vad);
    await this.until(async () => (await this.voice()) === "listening", 10);
    await this.shows(pty, /filter +off/);
  }

  async test_a_missing_model_stops_before_listening() {
    voiceEnv(this);
    rmSync(modelFile(this, models.catalog["base.en"]));
    const pty = await Pty.spawn([EXE, "voice"], { env: this.env, cwd: this.temp.name });
    this.ptys.push(pty);
    await pty.waitFor("corgi: voice model base.en is not installed; run: corgi voice setup --model base.en");
    this.assertEqual(await pty.proc.exited, 1);
    this.assertEqual(await this.voice(), null);
  }

  async test_without_the_filter_voice_mode_reminds_and_runs() {
    voiceEnv(this);
    rmSync(modelFile(this, models.filter));
    const { pty, logs } = await this.voiceMode({});
    await this.shows(pty, "The speech filter is not installed");
    await this.until(() => this.lines(logs.whisper).some(l => l.start));
    this.assertFalse(this.lines(logs.whisper)[0].vad);
  }

  async test_viewer_shortcut_and_indicator_mute_the_voice() {
    const a = await this.newViewer(),
      link = await voiceClient(this),
      pushed: boolean[] = [];
    await a.action("voice-mute");
    this.assertIn("Voice is not running", a.state.data);
    link.on("muted", muted => pushed.push(muted));
    await link.watch({ muted: false, available: true });
    const title = async () => screen_text((await a.poll()).data, 100, 30)[0];
    await this.until(async () => (await title()).includes("♫"));
    await a.action("voice-mute");
    await this.until(() => pushed.includes(true), 1);
    this.assertEqual(await this.voice(), "muted");
    await this.until(async () => (await title()).includes("♪"), 1);
    await link.set({ muted: false });
    await this.until(async () => (await title()).includes("♫"), 1);
    // A click on the indicator runs the same action.
    const row = await title(),
      x = displayWidth(row.slice(0, row.indexOf("♫"))) + 1;
    await a.input(`\x1b[<0;${x};1M\x1b[<0;${x};1m`);
    await this.until(() => pushed.filter(m => m).length === 2, 1);
    this.assertEqual(await this.voice(), "muted");
    link.close();
    // With no voice attached, the indicator is gone.
    await this.until(async () => !/[♪♫]/.test(await title()), 5);
  }

  async test_a_viewer_mute_reaches_voice_mode_within_a_second() {
    const a = await this.newViewer(),
      { pty } = await this.voiceMode({});
    await this.until(async () => (await this.voice()) === "listening", 10);
    await this.shows(pty, "Mode:    Listening");
    await a.action("voice-mute");
    await this.shows(pty, "Mode:    MUTED", 1000);
    await a.action("voice-mute");
    await this.shows(pty, "Mode:    Listening", 1000);
  }

  async test_setup_lists_the_models_for_an_unknown_one() {
    voiceEnv(this);
    const out = await run([EXE, "voice", "setup", "--model", "large"], { env: this.env, check: false });
    this.assertEqual(out.code, 2);
    for (const name of models.names) this.assertIn(name, out.stderr);
  }

  async test_a_microphone_that_cannot_listen_shows_muted() {
    for (const [fail, text] of [
      ["denied", process.platform === "darwin" ? "System Settings › Privacy & Security › Microphone" : "access denied"],
      ["busy", "The microphone is in use by another program"],
      ["missing", "No microphone found"],
    ]) {
      const target = await this.capturePane(`target-${fail}`),
        a = await this.newViewer();
      await a.focus(target.pane);
      const { pty } = await this.voiceMode({ CORGI_FAKE_FFMPEG_FAIL: fail });
      await this.shows(pty, text);
      await this.until(async () => (await this.voice()) === "muted");
      await a.action("voice-mute");
      this.assertEqual(await this.voice(), "muted");
      this.assertTrue(pty.proc.exitCode === null);
      this.assertFalse(existsSync(target.file) && readFileSync(target.file).length > 0);
      pty.write("q");
      this.assertEqual(await pty.proc.exited, 0);
      await this.until(async () => (await this.voice()) === null, 5);
      await a.close();
    }
  }

  async test_the_picker_switches_microphones_without_restarting_whisper() {
    const { pty, logs } = await this.voiceMode({ CORGI_FAKE_PCM: join(FIXTURES, "speech.pcm") });
    await this.until(async () => (await this.voice()) === "listening", 10);
    pty.write("d");
    await this.shows(pty, "Studio Microphone");
    await this.shows(pty, "MacBook Pro Microphone");
    // The picker starts on the current device, the default, so the other one is a key away.
    pty.write("\x1b[A\r");
    const captures = () => this.lines(logs.ffmpeg).filter(l => Array.isArray(l) && !l.includes("-list_devices"));
    await this.until(() => captures().length === 2);
    const started = captures(),
      device = process.platform === "darwin" ? ":0" : "Studio Microphone";
    this.assertIn(device, started[1]);
    await this.until(() => screen_text(pty.output, 100, 30)[3].includes("Studio Microphone"));
    this.assertEqual(this.lines(logs.whisper).filter(l => l.start).length, 1);
    pty.write("q");
    this.assertEqual(await pty.proc.exited, 0);
    await this.until(async () => (await this.voice()) === null, 5);
  }

  async test_voice_mode_reconnects_after_a_live_reload() {
    const { pty } = await this.voiceMode({});
    await this.until(async () => (await this.voice()) === "listening", 10);
    const before = (await this.rpc({ op: "hello", protocol: 1 })).server_pid;
    this.assertEqual((await this.rpc({ op: "server.reload", protocol: 1, executable: EXE })).ok, true);
    // The new daemon starts without the presence; voice mode's 5 s retry restores it.
    await this.until(async () => (await this.voice()) === "listening", 8);
    this.assertNotEqual((await this.rpc({ op: "hello", protocol: 1 })).server_pid, before);
    this.assertTrue(pty.proc.exitCode === null);
  }

  async assertRejects(promise: Promise<unknown>, name: string) {
    try {
      await promise;
    } catch (error) {
      this.assertIn(name, String(error));
      return;
    }
    this.fail(`expected ${name}`);
  }
}
registerCase("Voice", Voice, { inherited: false });
