#!/usr/bin/env bun
/**
 * Plays the corgi's animations from src/corgi_animation.ts in this terminal,
 * drawn by the same code the viewer and sidebar use.
 *
 *   bun tools/anim.ts                      lists them
 *   bun tools/anim.ts farewell             the uninstall walk-off, full screen
 *   bun tools/anim.ts fetch --speed 0.25   a throw, at quarter speed
 *
 * Options:
 *   --width N    the row's width for row animations; default each one's own
 *   --speed X    playback rate; default 1
 *   --lang L     en, zh, ja, ko or ru; default from the environment
 *   --seed N     the throw, dig or music to play; default a new one on each replay
 *   --once       exit when it ends instead of replaying
 *
 * Keys: space pauses, ← and → step a frame, r restarts, q quits.
 */
import * as a from "../src/corgi_animation";
import * as frames from "../src/corgi_frames";
import * as i18n from "../src/i18n";
import * as locale from "../src/locale";
import * as palette from "../src/palette";

type Size = { width: number; height: number };
type Clip = {
  about: string;
  /** How often its picture can change. */
  frame_ms: number;
  /** A row animation's own width, drawn centered; null across the whole screen. */
  width: (() => number) | null;
  duration_ms: (size: Size, seed: number) => number;
  /** Rows from `top`, 1-based. */
  draw: (size: Size, ms: number, seed: number) => { top: number; rows: string[] };
};

const row = (draw: (width: number, ms: number, seed: number) => string) => (size: Size, ms: number, seed: number) => ({
  top: Math.floor((size.height - 1) / 2) + 1,
  rows: [draw(size.width, ms, seed)],
});
/** A sidebar routine, as `Playback` plays it. */
function routine(name: a.Routine, about: string, bright: boolean): Clip {
  const start = (seed: number) => {
    const playback = new a.Playback();
    playback.random = new a.Random(seed);
    playback.enter(name, 0);
    return playback;
  };
  return {
    about,
    frame_ms: bright ? 30 : 75,
    width: () => 30,
    // The idle wag never ends; one loop of it is enough.
    duration_ms: (_, seed) => (name === "idle" ? frames.wag.length * 200 : start(seed).deadline_ms),
    draw: row((width, ms, seed) => palette.fg(bright ? "text" : "faint") + start(seed).write(width, ms)),
  };
}
function unearth(dig: a.Dig): Clip {
  return {
    about: `a hibernated pane's title, dug up while ${dig}`,
    frame_ms: 80,
    width: () => a.Dig.width(dig),
    duration_ms: () => ([...a.Dig.word(dig)].length * 2 + 8) * 80,
    draw: row((width, ms) => a.writeUnearth(width, ms, dig)),
  };
}
const clips: Record<string, Clip> = {
  farewell: {
    about: "Corgi was uninstalled: the corgi walks off to The Farm",
    frame_ms: a.farewell_tick_ms,
    width: null,
    duration_ms: size => new a.Farewell(size.width, size.height).ticks * a.farewell_tick_ms,
    draw: (size, ms) => {
      const scene = new a.Farewell(size.width, size.height);
      return { top: scene.top, rows: scene.rows(Math.floor(ms / a.farewell_tick_ms)) };
    },
  },
  wag: routine("idle", "the sidebar's corgi, awake", false),
  sniff: routine("sniff", "the sidebar's corgi sniffing", false),
  fetch: routine("fetch", "the sidebar's corgi chasing a ball; --seed picks the throw", true),
  bone: routine("bone", "the sidebar's corgi digging up a bone; --seed picks one or two tries", true),
  asleep: {
    about: "a sleeping agent's corgi, dreaming",
    frame_ms: 75,
    width: () => 30,
    duration_ms: () => a.dream_period_ms,
    draw: row((width, ms) => a.idle(width, { puff_ms: ms < a.puff_duration_ms ? ms : null })),
  },
  fleas: {
    about: "scratching at fleas and shaking them off, and they hop back",
    frame_ms: a.fleas_tick_ms,
    width: () => 30,
    duration_ms: () => a.fleas_ticks * a.fleas_tick_ms,
    draw: row((width, ms) => a.writeFleas(width, Math.floor(ms / a.fleas_tick_ms))),
  },
  "flea-cycle": {
    about: "fleas, over and over, dozing between",
    frame_ms: a.fleas_tick_ms,
    width: () => 30,
    duration_ms: () => a.flea_cycle_ticks * a.fleas_tick_ms,
    draw: row((width, ms) => a.writeFleaCycle(width, Math.floor(ms / a.fleas_tick_ms))),
  },
  compacting: {
    about: "herding the letters of Compacting…",
    frame_ms: 110,
    width: () => Math.max(30, a.herdWidth()),
    duration_ms: size => {
      let step = 0;
      while (!a.herdScene(size.width, step).finished && step < 1000) step++;
      return (step + 1) * 110;
    },
    draw: row((width, ms) => a.writeHerd(width, Math.floor(ms / 110))),
  },
  restoring: unearth("restoring"),
  forking: unearth("forking"),
  gauge: {
    about: "the voice gauge listening to music, then setting the threshold; --seed picks the music",
    frame_ms: 20,
    width: () => a.gauge_width,
    duration_ms: (size, seed) => a.gaugeDuration(size.width, seed),
    draw: row((width, ms, seed) => a.writeGauge(width, ms, seed)),
  },
};

function usage(problem?: string): never {
  const say = problem ? console.error : console.log,
    names = Object.keys(clips),
    pad = Math.max(...names.map(name => name.length));
  if (problem) say(problem);
  say("usage: bun tools/anim.ts NAME [--width N] [--speed X] [--lang L] [--seed N] [--once]\n");
  for (const name of names) say(`  ${name.padEnd(pad)}  ${clips[name].about}`);
  process.exit(problem ? 2 : 0);
}
function options(argv: string[]) {
  const result = { name: "", width: null as number | null, speed: 1, seed: null as number | null, once: false };
  const number = (flag: string, value: string | undefined, min: number) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < min) usage(`${flag} takes a number of at least ${min}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--width":
        result.width = Math.floor(number(arg, argv[++i], 1));
        break;
      case "--speed":
        result.speed = number(arg, argv[++i], 0.01);
        break;
      case "--seed":
        result.seed = number(arg, argv[++i], 0) >>> 0;
        break;
      case "--lang": {
        const language = locale.parse(argv[++i] ?? "");
        if (!language) usage(`--lang takes one of ${locale.locales.join(", ")}`);
        i18n.setLanguage(language);
        break;
      }
      case "--once":
        result.once = true;
        break;
      case "-h":
      case "--help":
        usage();
      default:
        if (arg.startsWith("-") || result.name) usage(`unexpected ${arg}`);
        result.name = arg;
    }
  }
  if (!result.name) usage();
  if (!Object.hasOwn(clips, result.name)) usage(`no animation named ${result.name}`);
  return result;
}

const opts = options(process.argv.slice(2)),
  clip = clips[opts.name];
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("tools/anim.ts plays in a terminal");
  process.exit(2);
}

const freshSeed = () => opts.seed ?? Math.floor(Math.random() * 0x100000000);
let seed = freshSeed(),
  /** Where playback is, in the animation's own milliseconds. */
  at = 0,
  /** When `at` was set, while playing; null while paused. */
  since: number | null = Date.now(),
  /** When playback reached the end, holding the last frame before a replay. */
  ended: number | null = null,
  cleared = false,
  wake = () => {};

/** The animation's room: its row, or the screen above the status line. */
function size(): Size {
  const width = process.stdout.columns,
    height = process.stdout.rows - 1;
  return { width: clip.width ? Math.min(opts.width ?? clip.width(), width) : width, height };
}
const now = () => (since === null ? at : at + (Date.now() - since) * opts.speed);
function seek(ms: number) {
  at = Math.max(0, ms);
  if (since !== null) since = Date.now();
  ended = null;
}
function restart() {
  seed = freshSeed();
  since = Date.now();
  seek(0);
}
function draw(ms: number, duration: number) {
  const room = size(),
    scene = clip.draw(room, Math.min(ms, duration - 1), seed),
    left = Math.floor((process.stdout.columns - room.width) / 2) + 1,
    seconds = (n: number) => (n / 1000).toFixed(2),
    state = since === null ? "paused" : ended !== null ? "ended" : `×${opts.speed}`,
    status = `${opts.name}  ${seconds(Math.min(ms, duration))}s / ${seconds(duration)}s  ${state}  ·  space pause  ← → step  r restart  q quit`;
  let text = "\x1b[?2026h";
  if (!cleared) text += "\x1b[0m\x1b[2J";
  cleared = true;
  for (const [i, line] of scene.rows.entries()) {
    const at = `\x1b[${scene.top + i};${left}H`;
    text += `${at}\x1b[0m${" ".repeat(room.width)}${at}${line}\x1b[0m`;
  }
  text += `\x1b[${process.stdout.rows};1H\x1b[2K${palette.fg("faint")}${status.slice(0, process.stdout.columns)}\x1b[0m`;
  process.stdout.write(text + "\x1b[?2026l");
}
function quit(): never {
  process.stdin.setRawMode(false);
  process.stdout.write("\x1b[0m\x1b[?25h\x1b[?1049l");
  process.exit(0);
}

process.stdin.setRawMode(true);
process.stdin.on("data", (data: Buffer) => {
  const key = data.toString();
  switch (key) {
    case "q":
    case "\x1b":
    case "\x03":
      quit();
    case " ":
      if (since === null) since = Date.now();
      else {
        at = now();
        since = null;
      }
      break;
    case "\x1b[C":
    case "\x1b[D": {
      const frame = Math.floor(now() / clip.frame_ms) + (key === "\x1b[C" ? 1 : -1);
      since = null;
      seek(Math.min(frame * clip.frame_ms, clip.duration_ms(size(), seed) - 1));
      break;
    }
    case "r":
      restart();
      break;
  }
  wake();
});
process.on("SIGWINCH", () => {
  cleared = false;
  wake();
});
process.stdout.write("\x1b[?1049h\x1b[?25l");

for (;;) {
  const duration = clip.duration_ms(size(), seed),
    ms = now();
  if (ms >= duration && since !== null) {
    if (opts.once) quit();
    ended ??= Date.now();
    if (Date.now() - ended >= 1000) {
      restart();
      continue;
    }
  }
  draw(ms, duration);
  await Promise.race([
    Bun.sleep(Math.max(10, clip.frame_ms / opts.speed)),
    new Promise<void>(resolve => (wake = resolve)),
  ]);
}
