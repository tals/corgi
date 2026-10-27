//! `corgi voice` and `corgi voice setup`: voice mode on the machine with the
//! microphone, dictating into a local runtime or one over SSH.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import * as errors from "../errors";
import * as log from "../log";
import * as os from "../os";
import * as discovery from "../discovery";
import * as config from "../build_config";
import * as settings from "./settings";
import * as models from "./models";
import * as setup from "./setup";
import * as capture from "./capture";
import * as ui from "./ui";
import { Segmenter } from "./segmenter";
import { Server } from "./whisper";
import { VoiceSession } from "./session";
import { LocalLink, type VoiceLink } from "./link";
import { SshLink } from "./bridge";

type Flags = settings.VoiceFlags & { ssh?: string; verbose?: boolean };

/** Reads `args` after `voice`; anything else is a usage error. */
export function flags(args: string[]): Flags {
  const out: Flags = {},
    number = (value: string | undefined, min: number, max: number, integer: boolean) => {
      const n = Number(value);
      if (value === undefined || !value.trim() || !Number.isFinite(n) || n < min || n > max) throw Error("Usage");
      if (integer && !Number.isInteger(n)) throw Error("Usage");
      return n;
    };
  for (let i = 0; i < args.length; i++) {
    const value = args[i + 1];
    switch (args[i]) {
      case "--ssh":
        if (!value || value.startsWith("-")) throw Error("Usage");
        out.ssh = value;
        i++;
        break;
      case "--model":
        out.model = models.parseName(value ?? "") ?? throwUsage();
        i++;
        break;
      case "--threshold":
        out.threshold = number(value, 0, 100, true);
        i++;
        break;
      case "--silence":
        out.silence = number(value, 0.5, 10, false);
        i++;
        break;
      case "--port":
        out.port = number(value, 1024, 65535, true);
        i++;
        break;
      case "--device":
        if (!value) throw Error("Usage");
        out.device = value;
        i++;
        break;
      case "--no-filter":
        out.speech_filter = false;
        break;
      case "--verbose":
        out.verbose = true;
        break;
      default:
        throw Error("Usage");
    }
  }
  return out;
}
function throwUsage(): never {
  throw Error("Usage");
}
/** The one line voice mode prints when it cannot start. */
export function message(error: unknown, s: { model: string; port: number; ssh?: string }): string {
  const name = errors.name(error),
    host = s.ssh;
  switch (name) {
    case "ModelMissing":
      return `voice model ${s.model} is not installed; run: corgi voice setup --model ${s.model}`;
    case "WhisperMissing":
      return `whisper-server not found; install: ${setup.hint("whisper-server")}`;
    case "FfmpegMissing":
      return `ffmpeg not found; install: ${setup.hint("ffmpeg")}`;
    case "PortInUse":
      return `port ${s.port} is in use; set "port" in voice.json or pass --port`;
    case "DaemonLacksVoice":
      return host
        ? `Corgi's daemon on ${host} has no voice support; reload it there with: corgi reload`
        : "this Corgi daemon has no voice support; reload it with: corgi reload";
    case "RemoteTooOld":
      return `Corgi on ${host} has no voice support; install Corgi ${config.releaseVersion} or newer there`;
    case "RemoteMissing":
      return `Corgi is not installed on ${host}`;
    case "SshFailed":
      return `could not reach ${host}: ${(error as { detail?: string }).detail || "ssh failed"}`;
    case "VoiceAttached":
      return "another voice session is already attached to this runtime";
    case "NoRuntime":
      return host ? `no Corgi runtime is running on ${host}` : "no Corgi runtime is running";
    case "Timeout":
      return "whisper-server did not answer within 60 s";
    case "WhisperStartFailed":
      return "whisper-server stopped while starting; run with --verbose and see voice.log";
    default:
      return name ?? String(error);
  }
}
function logPath(): string {
  return join(dirname(settings.path()), "voice.log");
}

/** `corgi voice …`; returns the exit status. */
export async function command(args: string[]): Promise<number> {
  if (args[0] === "setup") {
    const rest = args.slice(1);
    let model = models.default_model;
    if (rest.length === 2 && rest[0] === "--model") model = models.parseName(rest[1]) ?? throwUsage();
    else if (rest.length) throw Error("Usage");
    return setup.run({ model });
  }
  const given = flags(args);
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw Error("TerminalRequired");
  const read = settings.read(settings.path()),
    s = settings.merge(read.settings, given),
    context = { model: s.model, port: s.port, ssh: given.ssh };
  if (given.verbose) {
    mkdirSync(dirname(logPath()), { recursive: true });
    log.configure("voice", process.env, logPath());
  }
  const logger = log.getLogger("voice");
  try {
    return await voice(s, given, read.notices, logger);
  } catch (error) {
    logger.error("voice mode stopped", { error });
    process.stderr.write(`corgi: ${message(error, context)}\n`);
    return errors.is(error, "Usage") ? 2 : 1;
  }
}
async function voice(
  s: settings.VoiceSettings,
  given: Flags,
  notices: string[],
  logger: ReturnType<typeof log.getLogger>,
): Promise<number> {
  const model = models.catalog[s.model];
  if (!models.installed(model)) throw Error("ModelMissing");
  const binary = discovery.onPath("whisper-server");
  if (!binary) throw Error("WhisperMissing");
  if (!discovery.onPath("ffmpeg")) throw Error("FfmpegMissing");
  let vadModel: string | undefined;
  if (s.speech_filter && models.installed(models.filter)) vadModel = models.fileOf(models.filter);
  else if (s.speech_filter)
    notices = [...notices, "The speech filter is not installed, so noise may become text: run corgi voice setup"];
  const host = given.ssh,
    socket = os.socketPath(),
    pane = !host && process.env.CORGI_PANE ? Number(process.env.CORGI_PANE) || undefined : undefined;
  let connected = false;
  const link = (signal: AbortSignal): Promise<VoiceLink> =>
    host ? SshLink.connect(host, { batch: connected, signal }) : LocalLink.connect(socket);
  const timing = { silence: s.silence, pre_roll: s.pre_roll, min_speech: s.min_speech, burst: s.burst },
    segmenter = new Segmenter({ threshold: s.threshold, timing, now: Date.now });
  // The server starts after the first connection, so a refusal starts nothing.
  let server: Server | null = null;
  const crashed: ((code: number | null) => void)[] = [];
  const session = new VoiceSession({
    link,
    transcriber: {
      transcribe: wav => (server ? server.transcribe(wav) : Promise.reject(Error("ServerDown"))),
      on: (_event, fn) => void crashed.push(fn),
    },
    segmenter,
    now: Date.now,
    pane,
    log: line => logger.info(line),
  });
  // Over SSH, the first connection may prompt; it happens before the UI takes the terminal.
  try {
    await session.connect();
  } catch (error) {
    // Nothing runs yet, so nothing retries: the error is the answer.
    session.close();
    throw error;
  }
  connected = true;
  let mic: capture.Capture | null = null,
    cleaned: Promise<void> | null = null;
  // A whisper-server still loading when voice mode ends is stopped too.
  const stopping = new AbortController();
  const cleanup = () =>
    (cleaned ??= (async () => {
      stopping.abort();
      mic?.stop();
      session.close();
      await server?.stop();
      logger.info("voice mode stopped");
    })());
  const start = async (vad: string | undefined) => {
    const started = await Server.start({
      binary,
      model: models.fileOf(model),
      port: s.port,
      vadModel: vad,
      signal: stopping.signal,
    });
    logger.info("whisper-server ready", { port: s.port, model: s.model, filter: vad !== undefined });
    started.on("crashed", code => {
      logger.error("whisper-server crashed", { code, output: started.output });
      for (const fn of crashed) fn(code);
    });
    return started;
  };
  // The filter is a server option: switching it restarts the server, and
  // what is said meanwhile fails rather than waits.
  const toggleFilter = async (): Promise<ui.FilterState> => {
    if (!models.installed(models.filter)) return "not installed";
    vadModel = vadModel ? undefined : models.fileOf(models.filter);
    const old = server;
    server = null;
    await old?.stop();
    try {
      const fresh = await start(vadModel);
      if (cleaned) await fresh.stop();
      else server = fresh;
    } catch (error) {
      logger.error("whisper-server restart failed", { error });
      for (const fn of crashed) fn(null);
    }
    return vadModel ? "on" : "off";
  };
  // Until the UI takes the terminal, Ctrl+C or a signal while the model loads
  // still stops the server, which would otherwise keep the port.
  const onSignal = () => void cleanup().finally(() => process.exit(1)),
    signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) process.on(signal, onSignal);
  try {
    server = await start(vadModel);
    mic = capture.Capture.start(
      s.device,
      f => session.frame(f),
      problem => {
        logger.warn("microphone", { problem });
        session.setAvailable(false, problem);
      },
    );
  } catch (error) {
    await cleanup();
    throw error;
  } finally {
    for (const signal of signals) process.off(signal, onSignal);
  }
  let quit!: () => void;
  const stopped = new Promise<void>(resolve => (quit = resolve));
  const view = new ui.VoiceUi(session, {
    target: host ?? "local",
    device: s.device ?? "(default)",
    model: s.model,
    threshold: s.threshold,
    filter: vadModel ? "on" : s.speech_filter ? "not installed" : "off",
    timing,
    setTiming: (name, seconds) => segmenter.setTiming(name, seconds),
    toggleFilter,
    notices,
    setThreshold: pct => segmenter.setThreshold(pct),
    listDevices: () => capture.listDevices(),
    switchDevice: device => {
      logger.info("microphone switched", { device: device.id });
      mic?.switch(device.id);
    },
    quit: () => quit(),
  });
  await ui.run(view, stopped, cleanup);
  await cleanup();
  return 0;
}
