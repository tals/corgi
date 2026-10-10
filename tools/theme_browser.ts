/**
 * Theme browser: records Corgi's real screens under each of Ghostty's
 * bundled themes, in Corgi's theme and in Animal Style, for a page that
 * shows how each takes the terminal's colors.
 *
 *   bun tools/theme_browser.ts [--match REGEX] [--limit N] [--out FILE] [--html FILE]
 *   bun tools/theme_browser.ts --from FILE --html FILE
 *
 * Each scene and Corgi theme runs in its own probe session; the session
 * switches terminal themes the way Ghostty does (answers the viewer's color
 * queries, reports a color scheme change) and records the styled screen.
 * Writes JSON with the frames, each theme's colors and the derived tokens,
 * and with --html the browser page (theme_browser.html filled with them).
 * --from rebuilds the page from earlier JSON. Runs the binary in PROBE_BUN
 * (default dist/corgi).
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { BINARIES, Session, begin, parseScript } from "./probe";
import * as ghostty from "./ghostty_themes";
import * as palette from "../src/palette";
import { ORDINARY_PROVIDER } from "../tests/provider_sim";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const cols = 120,
  rows = 34;
/** Colored shell output, so a pane shows the theme's own ANSI colors. */
const demo = `#!/bin/sh
printf '\\033[1;34m~/project\\033[0m on \\033[35m main\\033[0m \\033[33m+2\\033[0m\\n'
printf '\\033[1mdiff --git a/src/app.ts b/src/app.ts\\033[0m\\n'
printf '\\033[36m@@ -12,6 +12,7 @@\\033[0m export function start()\\n'
printf '\\033[31m-  const port = 3000;\\033[0m\\n'
printf '\\033[32m+  const port = Number(process.env.PORT ?? 3000);\\033[0m\\n'
printf '\\033[33mwarning:\\033[0m unused variable \\033[1mretries\\033[0m\\n'
printf '\\033[1;34msrc\\033[0m  \\033[1;32mbuild.sh\\033[0m  \\033[36mlatest\\033[0m  README.md\\n\\n'
for i in 0 1 2 3 4 5 6 7; do printf '\\033[4%sm   \\033[0m' $i; done; printf '\\n'
for i in 0 1 2 3 4 5 6 7; do printf '\\033[10%sm   \\033[0m' $i; done; printf '\\n'
`;
/** Agents working, waiting for input and idle, beside a pane of colored output. */
const workspace = `
type demo; key enter; settle
key ctrl+b v; settle
type claude; key enter; settle; type work; key enter; settle
key ctrl+b c; settle; key t; settle
type claude; key enter; settle; type block; key enter; settle
key ctrl+b c; settle; key t; settle
type claude; key enter; settle
key ctrl+b 1; settle
`;
const scenes: Record<string, string> = {
  main: workspace,
  setup: workspace + "key ctrl+b i; settle; key down down down down; settle",
  menu: workspace + "rclicktext claude 2; settle",
  launcher: workspace + "key ctrl+b a; settle",
};

/** A Corgi theme's tokens on a terminal theme, as the palette computes them. */
function look(theme: palette.Theme, terminal: ghostty.GhosttyTheme) {
  palette.use(theme, { foreground: terminal.foreground, background: terminal.background, ansi: terminal.palette });
  const tokens = Object.fromEntries(Object.entries(palette.colors).map(([token, rgb]) => [token, [...rgb]]));
  return { tokens: tokens as Record<palette.Token, palette.Rgb>, clear: palette.bg("bg") === "\x1b[49m" };
}

async function record(
  theme: palette.Theme,
  scene: string,
  script: string,
  names: string[],
): Promise<Record<string, string[]>> {
  const s = new Session(BINARIES.bun, BINARIES.bun, cols, rows);
  const frames: Record<string, string[]> = {};
  try {
    writeFileSync(
      join(s.home, ".local/state/corgi/viewer.json"),
      JSON.stringify({ onboarding_complete: true, preset: "corgi", prefix: "ctrl_b", theme }),
    );
    mkdirSync(join(s.home, "bin"), { recursive: true });
    writeFileSync(join(s.home, "bin", "demo"), demo);
    // A session per process, so each fake Claude keeps its own state.
    writeFileSync(
      join(s.home, "bin", "claude"),
      ORDINARY_PROVIDER.replaceAll("'ordinary-'+provider", "'ordinary-'+provider+'-'+process.pid"),
    );
    for (const file of ["demo", "claude"]) chmodSync(join(s.home, "bin", file), 0o755);
    s.useTheme(names[0]);
    await begin(s);
    for (const command of parseScript(script)) await s.exec(command);
    for (const [i, name] of names.entries()) {
      const asked = s.answered;
      s.useTheme(name);
      // The agents animate without pause, so wait for the viewer to ask for
      // the new colors and repaint in them instead of for quiet.
      const line = look(theme, s.theme!).tokens.line,
        drawn = new RegExp(`38;2;${line.join(";")}[;m]`),
        until = Date.now() + 3000;
      while (Date.now() < until && s.answered === asked) await Bun.sleep(10);
      while (Date.now() < until && !s.styled().some(l => drawn.test(l))) await Bun.sleep(20);
      await Bun.sleep(200);
      frames[name] = s.styled();
      if (i % 50 === 0) console.error(`${theme} ${scene}: ${i + 1}/${names.length} ${name}`);
    }
  } finally {
    await s.close();
  }
  return frames;
}

type Rgb = [number, number, number];
/** One styled screen line as runs of [column, text, fg, bg, attrs] with
 * colors as indexes into `colors`. A wide character is a run of its own
 * with attrs bit 64. Attrs: 1 bold, 2 dim, 4 italic, 8 underline, 16
 * strike, 32 inverse. */
function runs(line: string, colors: Map<string, number>): (string | number)[][] {
  const out: (string | number)[][] = [],
    index = (rgb: string) => {
      if (!colors.has(rgb)) colors.set(rgb, colors.size);
      return colors.get(rgb)!;
    };
  let fg = "",
    bg = "",
    attrs = 0,
    col = 0;
  for (const part of line.split(/(\x1b\[[0-9;:]*m)/)) {
    const sgr = /^\x1b\[([0-9;:]*)m$/.exec(part);
    if (sgr) {
      const p = sgr[1].split(";");
      for (let i = 0; i < p.length; i++) {
        const code = p[i].split(":")[0];
        if (code === "" || code === "0") ((fg = ""), (bg = ""), (attrs = 0));
        else if (code === "38" || code === "48") {
          if (p[i + 1] === "2") {
            const rgb = p.slice(i + 2, i + 5).map(Number) as Rgb;
            const hex = "#" + rgb.map(v => v.toString(16).padStart(2, "0")).join("");
            if (code === "38") fg = hex;
            else bg = hex;
            i += 4;
          }
        } else if (code === "39") fg = "";
        else if (code === "49") bg = "";
        else {
          const bit = { "1": 1, "2": 2, "3": 4, "4": 8, "9": 16, "7": 32 }[code];
          const clear = { "22": 3, "23": 4, "24": 8, "29": 16, "27": 32 }[code];
          if (bit) attrs |= bit;
          if (clear) attrs &= ~clear;
        }
      }
      continue;
    }
    for (const ch of part) {
      const wide = Bun.stringWidth(ch) === 2,
        style = [index(fg || "default-fg"), index(bg || "default-bg"), attrs | (wide ? 64 : 0)],
        last = out[out.length - 1];
      if (
        !wide &&
        last &&
        !((last[4] as number) & 64) &&
        last[2] === style[0] &&
        last[3] === style[1] &&
        last[4] === style[2]
      )
        last[1] += ch;
      else out.push([col, ch, ...style]);
      col += wide ? 2 : 1;
    }
  }
  return out;
}
const hue = (rgb: Rgb) => {
  const [r, g, b] = rgb.map(c => {
      const v = c / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    }),
    l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b),
    m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b),
    s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return (
    (Math.atan2(
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    ) *
      180) /
    Math.PI
  );
};
const brightness = (rgb: Rgb) => rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114;
/** The page's data: each theme's colors and its frames, gzipped and base64'd. */
function page(capture: any): string {
  const themes = capture.themes.map((t: any) => {
    const colors = new Map<string, number>(),
      bg = "#" + t.background.map((v: number) => v.toString(16).padStart(2, "0")).join("");
    colors.set(bg, 0);
    // Keyed "theme/scene", every frame sharing one color table.
    const scenes = Object.fromEntries(
      Object.entries(t.frames as Record<string, Record<string, string[]>>).flatMap(([theme, frames]) =>
        Object.entries(frames).map(([scene, lines]) => [`${theme}/${scene}`, lines.map(line => runs(line, colors))]),
      ),
    );
    const fg = "#" + t.foreground.map((v: number) => v.toString(16).padStart(2, "0")).join("");
    const table = [...colors.keys()].map(c => (c === "default-fg" ? fg : c === "default-bg" ? bg : c));
    const animal = t.looks.animal_style.tokens;
    const fallback = (["accent", "warm", "hot"] as const).filter(
      (status, k) =>
        ![
          [2, 10],
          [3, 11],
          [1, 9],
        ][k].some(slot => {
          const ansi = t.palette[slot];
          if (!ansi) return false;
          const d = Math.abs(hue(ansi) - hue(animal[status])) % 360;
          return Math.min(d, 360 - d) < 30;
        }),
    );
    return {
      name: t.name,
      foreground: t.foreground,
      background: t.background,
      palette: t.palette,
      looks: t.looks,
      dark: brightness(t.foreground) > brightness(t.background),
      fallback,
      frames: gzipSync(JSON.stringify({ colors: table, scenes }), { level: 9 }).toString("base64"),
    };
  });
  const json = JSON.stringify({ cols: capture.cols, rows: capture.rows, scenes: capture.scenes, themes }).replaceAll(
    "</",
    "<\\/",
  );
  return readFileSync(join(import.meta.dir, "theme_browser.html"), "utf8").replace("__DATA__", () => json);
}

if (arg("--from")) {
  writeFileSync(arg("--html")!, page(JSON.parse(readFileSync(arg("--from")!, "utf8"))));
  console.error(`wrote ${arg("--html")}`);
  process.exit(0);
}
const match = arg("--match") ? new RegExp(arg("--match")!, "i") : null;
const names = ghostty
  .names()
  .filter(name => !match || match.test(name))
  .slice(0, Number(arg("--limit") ?? Infinity));
const corgi_themes = palette.available_themes,
  runs_for = corgi_themes.flatMap(theme => Object.entries(scenes).map(([scene, script]) => ({ theme, scene, script }))),
  recorded = await Promise.all(runs_for.map(r => record(r.theme, r.scene, r.script, names)));
const themes = names.map(name => {
  const terminal = ghostty.load(name);
  return {
    name,
    foreground: terminal.foreground,
    background: terminal.background,
    palette: terminal.palette,
    looks: Object.fromEntries(corgi_themes.map(theme => [theme, look(theme, terminal)])),
    frames: Object.fromEntries(
      corgi_themes.map(theme => [
        theme,
        Object.fromEntries(runs_for.flatMap((r, i) => (r.theme === theme ? [[r.scene, recorded[i][name]]] : []))),
      ]),
    ),
  };
});
const out = arg("--out") ?? "theme-browser.json";
const capture = { cols, rows, scenes: Object.keys(scenes), themes };
writeFileSync(out, JSON.stringify(capture));
console.error(`wrote ${themes.length} themes to ${out}`);
if (arg("--html")) writeFileSync(arg("--html")!, page(capture));
