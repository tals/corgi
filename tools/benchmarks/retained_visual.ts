/** Serial real-PTY visual comparison and PNG evidence; run outside CPU measurements. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Session } from "../ui_driver";
import * as ghostty from "../ghostty_themes";
import * as benchmark from "./cpu_lock";
import * as text from "../../src/text";
import type { ImagePlacement } from "../../src/pane/surface";

type Color = [number, number, number];
type Cell = {
  x: number;
  text: string;
  width: number;
  fg: Color;
  bg: Color;
  bold: boolean;
  faint: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  link: string | null;
};
type Picture = ImagePlacement & { data: string };
type Frame = {
  name: string;
  cols: number;
  rows: number;
  cells: Cell[][];
  cursor: { x: number; y: number } | null;
  images: Picture[];
  raw_bytes: number;
};
const theme: ghostty.GhosttyTheme = {
  name: "evidence",
  foreground: [209, 214, 219],
  background: [24, 27, 32],
  palette: [
    [0, 0, 0],
    [205, 49, 49],
    [13, 188, 121],
    [229, 229, 16],
    [36, 114, 200],
    [188, 63, 188],
    [17, 168, 205],
    [229, 229, 229],
    [102, 102, 102],
    [241, 76, 76],
    [35, 209, 139],
    [245, 245, 67],
    [59, 142, 234],
    [214, 112, 214],
    [41, 184, 219],
    [255, 255, 255],
  ],
};

function cells(line: string): Cell[] {
  const out: Cell[] = [];
  let x = 0,
    fg = theme.foreground,
    bg = theme.background,
    bold = false,
    faint = false,
    italic = false,
    underline = false,
    strike = false,
    link: string | null = null;
  const tokens = line.match(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][\s\S]*?(?:\x07|\x1b\\)|[^\x1b]+/g) ?? [];
  for (const token of tokens) {
    if (token.startsWith("\x1b[")) {
      if (!token.endsWith("m")) throw Error("Unexpected coordinate in captured surface row");
      const codes = token.slice(2, -1).split(";").map(Number);
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i];
        if (code === 0) {
          fg = theme.foreground;
          bg = theme.background;
          bold = faint = italic = underline = strike = false;
        } else if ((code === 38 || code === 48) && codes[i + 1] === 2) {
          const rgb: Color = [codes[i + 2], codes[i + 3], codes[i + 4]];
          if (code === 38) fg = rgb;
          else bg = rgb;
          i += 4;
        } else if (code === 1) bold = true;
        else if (code === 2) faint = true;
        else if (code === 3) italic = true;
        else if (code === 4) underline = true;
        else if (code === 9) strike = true;
        else throw Error(`Unexpected captured SGR ${code}`);
      }
    } else if (token.startsWith("\x1b]8;")) {
      link = token.slice(token.indexOf(";", 4) + 1).replace(/(?:\x07|\x1b\\)$/, "") || null;
    } else if (token.startsWith("\x1b")) throw Error("Unexpected captured terminal command");
    else
      for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(token)) {
        const width = text.displayWidth(segment);
        if (!width && out.length) out[out.length - 1].text += segment;
        else {
          out.push({ x, text: segment, width, fg, bg, bold, faint, italic, underline, strike, link });
          x += width;
        }
      }
  }
  return out;
}

function changedBackground(before: Cell[][], after: Cell[][]): number {
  let changed = 0;
  for (let y = 0; y < before.length; y++)
    for (const cell of before[y]) {
      if (cell.x < 28) continue;
      const other = after[y]?.find(item => item.x === cell.x);
      if (other && cell.bg.some((value, i) => value !== other.bg[i])) changed++;
    }
  return changed;
}

const fixture = String.raw`import { spawnSync } from 'node:child_process';
spawnSync('stty',['-echo'],{stdio:'inherit'});
const write=s=>process.stdout.write(s);
function draw(){write('\x1b_Ga=d,d=A,q=2;\x1b\\\x1b[0m\x1b[2J\x1b[H\x1b[?25l'+
'RETAINED SURFACE VISUAL FIXTURE\r\n'+
'ASCII: unchanged spans must remain stable\r\n'+
'\x1b[1;38;2;240;130;80mBOLD COLOR\x1b[0m / \x1b[3mitalic\x1b[0m / \x1b[4munderline\x1b[0m / \x1b[9mstrike\x1b[0m\r\n'+
'Unicode: café é Ω λ ── ░▒▓ 😀\r\n'+
'\x1b[38;2;70;210;160;48;2;45;55;90mRGB foreground and background\x1b[0m\r\n'+
'Link: \x1b]8;;https://example.test/retained\x1b\\https://example.test/retained\x1b]8;;\x1b\\\r\n'+
'SELECT_START alpha beta gamma SELECT_END\r\n'+
'\r\n\r\nsparse counter: 0000\r\n');}
function image(){const w=360,h=132,p=Buffer.alloc(w*h*3);for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=(y*w+x)*3,s=(x+y)%30<5;p[i]=s?245:50+Math.floor(x*180/w);p[i+1]=s?240:60+Math.floor(y*170/h);p[i+2]=s?230:160;}const data=p.toString('base64');write('\x1b[8;3H');for(let i=0;i<data.length;i+=4096)write((i?'\x1b_Gm=':'\x1b_Ga=T,f=24,s=360,v=132,c=36,r=6,C=1,q=2,m=')+Number(i+4096<data.length)+';'+data.slice(i,i+4096)+'\x1b\\');}
draw();let pending='';process.stdin.on('data',chunk=>{pending+=chunk;let at;while((at=pending.indexOf('\n'))>=0){const command=pending.slice(0,at).trim();pending=pending.slice(at+1);if(command==='redraw')draw();else if(command==='sparse')write('\x1b[10;17H0001');else if(command==='append')write('\x1b[12;1HBACKGROUND_OUTPUT');else if(command==='image')image();else if(command==='scroll'){for(let i=1;i<=90;i++)write('history '+String(i).padStart(3,'0')+'\r\n');write('SCROLL_DONE');}}});process.stdin.resume();
`;

async function run(binary: string, directory: string): Promise<Frame[]> {
  mkdirSync(directory, { recursive: true });
  const s = new Session(binary, binary, 120, 36);
  for (const key of ["CORGI_NATIVE_ROOT", "CORGI_TELEMETRY_DIR", "CORGI_TELEMETRY_TRACE", "BUN_OPTIONS"])
    delete s.env[key];
  s.env.TERM = "xterm-kitty";
  writeFileSync(
    join(s.home, ".local/state/corgi/viewer.json"),
    JSON.stringify({
      onboarding_complete: true,
      preset: "corgi",
      prefix: "ctrl_b",
      corgi_intensity: 0,
      resources: { enabled: false },
    }),
  );
  writeFileSync(join(s.cwd, "fixture.ts"), fixture);
  s.screen.applyTheme(ghostty.asTerminalTheme(theme));
  s.screen.native({ op: "pixels", start_x: 10, start_y: 22 });
  s.terminal.close();
  let pending = "",
    sending: { id: string; quiet: string } | null = null;
  const decoder = new TextDecoder();
  s.terminal = new Bun.Terminal({
    cols: s.cols,
    rows: s.rows,
    data(pty, bytes) {
      s.bytes += bytes.length;
      s.lastData = Date.now();
      s.output += decoder.decode(bytes, { stream: true });
      s.screen.feed(bytes);
      pending += Buffer.from(bytes).toString("latin1");
      while (pending.length) {
        const at = pending.indexOf("\x1b");
        if (at < 0) {
          pending = "";
          break;
        }
        if (at) pending = pending.slice(at);
        if (pending.length < 2) break;
        if (pending.startsWith("\x1b_G")) {
          const end = pending.indexOf("\x1b\\");
          if (end < 0) break;
          const fields = Object.fromEntries(
            pending
              .slice(3, end)
              .split(";", 1)[0]
              .split(",")
              .map(part => part.split("=")),
          );
          pending = pending.slice(end + 2);
          if (fields.a === "q") pty.write(`\x1b_Gi=${fields.i};OK\x1b\\`);
          if (fields.a === "t" || fields.a === "T") sending = { id: fields.i ?? "0", quiet: fields.q ?? "0" };
          if (sending && fields.m !== "1") {
            if (sending.quiet !== "2") pty.write(`\x1b_Gi=${sending.id};OK\x1b\\`);
            sending = null;
          }
          if (fields.a === "p" && fields.q !== "2") pty.write(`\x1b_Gi=${fields.i},p=${fields.p};OK\x1b\\`);
        } else if (pending.startsWith("\x1b[")) {
          const match = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(pending);
          if (!match) break;
          pending = pending.slice(match[0].length);
          if (match[0] === "\x1b[16t") pty.write("\x1b[6;22;10t");
          if (match[0] === "\x1b[14t") pty.write(`\x1b[4;${s.rows * 22};${s.cols * 10}t`);
          if (match[0] === "\x1b[c") pty.write("\x1b[?62c");
        } else if (pending.startsWith("\x1b]")) {
          const end = /\x07|\x1b\\/.exec(pending);
          if (!end) break;
          const body = pending.slice(2, end.index);
          pending = pending.slice(end.index + end[0].length);
          const query = /^(10|11|4;\d+);\?$/.exec(body);
          if (query) pty.write(ghostty.reply(theme, query[1]) ?? "");
        } else if ("\x1b_G".startsWith(pending)) break;
        else pending = pending.slice(2);
      }
    },
  });
  async function cli(...args: string[]) {
    const child = Bun.spawn([binary, ...args, "--json"], { env: s.env, cwd: s.cwd, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code) throw Error(`${args.join(" ")}: ${err}`);
    return out.trim() ? JSON.parse(out) : null;
  }
  const frames: Frame[] = [];
  async function capture(name: string) {
    await s.settle(150, 1500);
    const surface = s.screen.surface(0).surface;
    const pictures: Picture[] = [];
    for (const placement of surface.images ?? []) {
      const chunks: Buffer[] = [];
      let offset = 0;
      while (offset < placement.image.bytes) {
        const chunk = s.screen.native({ op: "image", text: placement.image.id, skip: offset }) as string | null;
        if (!chunk) throw Error("Missing captured image pixels");
        const bytes = Buffer.from(chunk, "base64");
        chunks.push(bytes);
        offset += bytes.length;
      }
      pictures.push({ ...placement, data: Buffer.concat(chunks).toString("base64") });
    }
    const frame: Frame = {
      name,
      cols: s.cols,
      rows: s.rows,
      cells: surface.lines.map(cells),
      cursor: surface.cursor,
      images: pictures,
      raw_bytes: s.bytes,
    };
    frames.push(frame);
    writeFileSync(join(directory, `${name}.json`), JSON.stringify(frame));
    writeFileSync(join(directory, `${name}.txt`), s.text().join("\n"));
    writeFileSync(join(directory, `${name}.ansi`), s.output);
    return frame;
  }
  async function command(pane: number, value: string) {
    await cli("pane", "send", String(pane), value, "--enter");
    await Bun.sleep(80);
  }
  try {
    await s.start();
    await s.exec(["waittext", "$", "10000"]);
    const pane = (await cli("list")).result.panes[0].id as number;
    s.write("exec bun fixture.ts\r");
    await s.exec(["waittext", "RETAINED SURFACE VISUAL FIXTURE"]);
    // Process discovery runs separately from the first terminal draw.
    const identifiedBy = Date.now() + 10000;
    while (!s.text()[0]?.includes("fixtur") && Date.now() < identifiedBy) await Bun.sleep(20);
    if (!s.text()[0]?.includes("fixtur")) throw Error("Fixture process title did not settle");
    await capture("01-normal-unicode-colors");
    await command(pane, "sparse");
    await s.exec(["waittext", "0001"]);
    await capture("02-sparse-update");
    await s.exec(["hovertext", "https://example.test/retained"]);
    await Bun.sleep(300);
    await capture("03-link-hover");
    await s.exec(["move", "115", "34"]);
    await Bun.sleep(150);
    const [x1, y1] = s.find("SELECT_START"),
      [x2, y2] = s.find("SELECT_END");
    const beforeSelection = s.screen.surface(0).surface.lines.map(cells);
    s.write(`\x1b[<0;${x1};${y1}M\x1b[<32;${x2};${y2}M`);
    await Bun.sleep(100);
    const selected = await capture("04-held-selection");
    if (changedBackground(beforeSelection, selected.cells) < 10) throw Error("Held selection has no visible highlight");
    await command(pane, "append");
    if (!(await cli("pane", "read", String(pane), "--lines", "100")).result.text.includes("BACKGROUND_OUTPUT"))
      throw Error("Background output did not reach the source pane");
    await capture("05-selection-freezes-output");
    if (s.text().join("\n").includes("BACKGROUND_OUTPUT")) throw Error("Selection did not freeze visible output");
    s.write(`\x1b[<0;${x2};${y2}m`);
    await s.exec(["waittext", "BACKGROUND_OUTPUT"]);
    await Bun.sleep(2200);
    await capture("06-selection-released");
    await command(pane, "image");
    await Bun.sleep(300);
    const pictured = await capture("07-kitty-image");
    if ((frames.at(-1)?.images.length ?? 0) < 2) throw Error("Expected pane picture and badge image");
    await s.exec(["click", "45", "12", "right"]);
    await capture("08-image-menu-overlay");
    await s.exec(["key", "esc"]);
    await s.exec(["key", "ctrl+b", "T"]);
    await s.exec(["waittext", "Rename tab"]);
    const dimmed = await capture("08b-dimmed-dialog");
    const brightCell = pictured.cells[1].find(cell => cell.x === 28)!;
    const dimCell = dimmed.cells[1].find(cell => cell.x === 28)!;
    if (
      !brightCell ||
      !dimCell ||
      brightCell.fg.some((value, i) => Math.floor(value / 2) !== dimCell.fg[i]) ||
      brightCell.bg.some((value, i) => Math.floor(value / 2) !== dimCell.bg[i])
    )
      throw Error("Dialog did not dim the pane's uncovered text cell");
    if (dimmed.images.some(placement => placement.image.width === 360))
      throw Error("Dimmed pane image remained visible");
    await s.exec(["key", "esc"]);
    const restoredImage = await capture("08c-image-restored");
    if (!restoredImage.images.some(placement => placement.image.width === 360))
      throw Error("Pane image did not return after closing dialog");
    await command(pane, "redraw");
    await command(pane, "scroll");
    await s.exec(["waittext", "SCROLL_DONE"]);
    await s.exec(["key", "ctrl+b", "s"]);
    await s.exec(["key", "k", "k", "k"]);
    const scrolled = await capture("09-copy-scrollback");
    if (!s.text().join("\n").includes("SCROLL ")) throw Error("Copy mode did not open");
    const [sx, sy] = s.find("history 060"),
      [ex, ey] = s.find("history 064");
    s.write(`\x1b[<0;${sx};${sy}M\x1b[<32;${ex + 10};${ey}M`);
    await Bun.sleep(100);
    const copySelection = await capture("10-copy-selection");
    if (changedBackground(scrolled.cells, copySelection.cells) < 20)
      throw Error("Scrollback selection has no visible highlight");
    s.write(`\x1b[<0;${ex + 10};${ey}m`);
    await s.exec(["key", "q"]);
    await Bun.sleep(2200);
    if (s.text().join("\n").includes("SCROLL ")) throw Error("Copy mode did not exit");
    await command(pane, "redraw");
    await s.exec(["waittext", "RETAINED SURFACE VISUAL FIXTURE"]);
    if (s.text().join("\n").includes("history ")) throw Error("Redraw did not restore the live viewport");
    await cli("pane", "split", String(pane), "--right", "--command", "exec bun fixture.ts");
    const splitDeadline = Date.now() + 10000;
    while (s.text().join("\n").split("RETAINED SURFACE VISUAL FIXTURE").length !== 3) {
      if (Date.now() > splitDeadline) throw Error("Both split fixtures did not paint");
      await Bun.sleep(25);
    }
    await capture("11-split-panes");
    await s.exec(["key", "ctrl+b", "h"]);
    await capture("12-focus-left");
    await s.exec(["key", "ctrl+b", "z"]);
    await capture("13-zoom");
    await s.exec(["key", "ctrl+b", "z"]);
    // This width omits help's independent footer animation, keeping every captured cell comparable.
    await s.exec(["resize", "48x24"]);
    await s.exec(["key", "ctrl+b", "?"]);
    await capture("14-help-overlay");
    await s.exec(["key", "esc"]);
    await s.exec(["resize", "120x36"]);
    await s.settle(150, 1500);
    await s.exec(["hovertext", "agents"]);
    await Bun.sleep(200);
    await capture("15-scope-hover");
    await s.exec(["move", "115", "34"]);
    await s.exec(["resize", "60x20"]);
    await capture("16-resize-small");
    await s.exec(["resize", "140x45"]);
    await capture("17-resize-large");
    return frames;
  } finally {
    writeFileSync(join(directory, "terminal.ansi"), s.output);
    if (s.home) {
      try {
        writeFileSync(join(directory, "server.log"), readFileSync(join(s.home, "server.log")));
      } catch {}
    }
    await s.close();
  }
}

const release = await benchmark.acquire();
try {
  const baseline = resolve(process.argv[2]),
    candidate = resolve(process.argv[3]),
    output = resolve(process.argv[4]);
  mkdirSync(output, { recursive: false });
  const left = await run(baseline, join(output, "baseline"));
  const right = await run(candidate, join(output, "candidate"));
  const comparisons = left.map((frame, i) => {
    const other = right[i];
    const comparable = ({ raw_bytes: _bytes, images, ...value }: Frame) => ({
      ...value,
      images: images
        .map(({ image: { id: _id, ...image }, ...placement }) => ({ ...placement, image }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    });
    return {
      name: frame.name,
      same: !!other && JSON.stringify(comparable(frame)) === JSON.stringify(comparable(other)),
    };
  });
  const result = {
    baseline,
    candidate,
    comparisons,
    equal: left.length === right.length && comparisons.every(row => row.same),
    cell_pixels: [10, 22],
    note: "Real PTY output replayed through Ghostty; exact styled cells, hyperlink destinations, cursor and decoded image placements/pixels. Opaque image/link identifiers are excluded. No timing normalization.",
  };
  writeFileSync(join(output, "comparison.json"), JSON.stringify(result, null, 2));
  const png = Bun.spawn(["uv", "run", "--script", join(import.meta.dir, "retained_png.py"), output], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (await png.exited) throw Error("PNG rendering failed");
  console.log(JSON.stringify(result, null, 2));
  if (!result.equal) process.exitCode = 1;
} finally {
  await release();
}
