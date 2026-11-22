#!/usr/bin/env bun
//! Draws a fixed run of scenes with Corgi's pictures in the terminal it runs
//! in, to check a host by eye or by screenshot:
//!
//!   bun tools/host_images_check.ts --out DIR --name kitty [--mode diff|clear]
//!
//! `diff` writes what the viewer does: only the pictures that changed.
//! `clear` takes every picture off and places them all again each scene, as
//! a reference the two should match. After each scene it writes
//! DIR/NAME-MODE-N.ready and waits for DIR/NAME-MODE-N.shot (or two seconds
//! with no --out). DIR/NAME-MODE.log lists what each scene wrote and any
//! error the host answered.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as dockingGrip from "../src/docking_grip";
import { Differ } from "../src/frame_diff";
import type { Cell } from "../src/fork_hero";
import * as hostImages from "../src/host_images";
import { Rect } from "../src/layout";
import * as rowGlide from "../src/row_glide";
import * as signalBars from "../src/signal_bars";
import * as tabIcons from "../src/tab_icons";

const arg = (name: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? null : process.argv[at + 1];
};
const out = arg("out"),
  name = arg("name") ?? "host",
  mode = arg("mode") === "clear" ? "clear" : "diff",
  tag = `${name}-${mode}`;
if (out) mkdirSync(out, { recursive: true });
const log = (line: string) => out && appendFileSync(join(out, `${tag}.log`), line + "\n");

const stdin = process.stdin,
  write = (s: string | Uint8Array) => process.stdout.write(s);
stdin.setRawMode(true);
let replies = "";
stdin.on("data", bytes => {
  const text = bytes.toString("latin1");
  if (text.includes("\x03")) leave(1);
  replies += text;
});
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

/** Asks the host for its cell size and whether it takes Kitty images. */
async function probe(): Promise<{ cell: Cell; kitty: boolean }> {
  write("\x1b[16t\x1b_Ga=q,i=31,s=1,v=1,f=24,t=d;AAAA\x1b\\\x1b[c");
  for (let waited = 0; waited < 1500 && !/\x1b\[\?[\d;]*c/.test(replies); waited += 20) await sleep(20);
  const size = /\x1b\[6;(\d+);(\d+)t/.exec(replies);
  const found = {
    cell: { width: Number(size?.[2] ?? 8), height: Number(size?.[1] ?? 16) },
    kitty: /_Gi=31;OK/.test(replies),
  };
  log(`probe ${JSON.stringify(found)} cell_reported=${size !== null}`);
  replies = "";
  return found;
}
function leave(code: number): never {
  write(store.close() + "\x1b[?1049l\x1b[?25h");
  stdin.setRawMode(false);
  process.exit(code);
}

/** Four quadrants in a white frame, with a dark diagonal: any wrong crop,
 * offset or scale shows. */
function quadrants(width: number, height: number, invert = false): hostImages.Image {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const edge = x < 2 || y < 2 || x >= width - 2 || y >= height - 2,
        diagonal = Math.abs(x / width - y / height) < 0.03,
        left = x < width / 2,
        top = y < height / 2;
      let color = top ? (left ? [220, 60, 60] : [60, 180, 80]) : left ? [70, 110, 230] : [230, 190, 50];
      if (diagonal) color = [20, 20, 20];
      if (edge) color = [255, 255, 255];
      if (invert) color = color.map(c => 255 - c);
      rgba.set([...color, 255], (y * width + x) * 4);
    }
  return new hostImages.Image({ rgba, width, height });
}

const cols = process.stdout.columns ?? 100,
  rows = process.stdout.rows ?? 30;
write(`\x1b]2;corgi-check-${tag}\x07\x1b[?1049h\x1b[?25l`);
const store = new hostImages.Store();
const { cell, kitty } = await probe();
const big = quadrants(12 * cell.width, 4 * cell.height),
  small = quadrants(6 * cell.width, 3 * cell.height),
  swapped = quadrants(6 * cell.width, 3 * cell.height, true);

type Scene = { title: string; draw(frame: hostImages.FrameImages, text: string[]): void; repaint?: boolean };
const card = (text: string[], box: Rect, label: string) => {
  for (let y = box.y; y < box.y + box.h; y++) {
    const inner =
      y === box.y || y === box.y + box.h - 1 ? "─".repeat(box.w - 2) : label.padEnd(box.w - 2).slice(0, box.w - 2);
    const edge = y === box.y ? "╭╮" : y === box.y + box.h - 1 ? "╰╯" : "││";
    text[y] = `\x1b[${y + 1};${box.x + 1}H\x1b[0;97;44m${edge[0]}${inner}${edge[1]}\x1b[0m`;
  }
};
/** What every scene shows unless it says otherwise. */
const chrome = (frame: hostImages.FrameImages) => {
  for (const [i, brand] of (["node", "rust", "vim"] as const).entries())
    tabIcons.place(frame, brand, 4 + i * 6, 12, cell);
  if (signalBars.fits(cell))
    for (const quality of [1, 2, 3, 4] as const) signalBars.place(frame, quality, 30 + quality * 4, 12, cell);
  dockingGrip.draw(frame, [new Rect(60, 12, 4, 1)], cell);
};
const scenes: Scene[] = [
  {
    title: "two pictures, marks, bars and a grip",
    draw: frame => {
      frame.show(big, { col: 4, row: 3 });
      frame.show(small, { col: 30, row: 3 });
      chrome(frame);
    },
  },
  {
    title: "the big one moved 7 px right and 5 px down",
    draw: frame => {
      frame.show(big, { col: 4, row: 3, x: 7 % cell.width, y: 5 % cell.height });
      frame.show(small, { col: 30, row: 3 });
      chrome(frame);
    },
  },
  {
    title: "a card over the big one's middle cuts it",
    draw: (frame, text) => {
      frame.show(big, { col: 4, row: 3 });
      frame.show(small, { col: 30, row: 3 });
      chrome(frame);
      const box = new Rect(8, 4, 20, 3);
      card(text, box, " card over a picture");
      frame.cover(box);
      // A card over the marks' row cuts those too.
      const low = new Rect(6, 12, 30, 1);
      text.push(`\x1b[13;7H\x1b[0;30;43m${" covered ".padEnd(30)}\x1b[0m`);
      frame.cover(low);
    },
  },
  {
    title: "card gone; the small one has new pixels",
    draw: frame => {
      frame.show(big, { col: 4, row: 3 });
      frame.show(swapped, { col: 30, row: 3 });
      chrome(frame);
    },
  },
  {
    title: "big one gone; the small one twice",
    draw: frame => {
      frame.show(swapped, { col: 30, row: 3 });
      frame.show(swapped, { col: 44, row: 4, x: Math.floor(cell.width / 2) });
      chrome(frame);
    },
  },
  {
    title: "a tint under the text of rows 7 and 8, half a row down",
    draw: frame => {
      frame.show(small, { col: 30, row: 3 });
      rowGlide.place(frame, 2, 6.5, 40, 2, { top: 0, bottom: rows }, 1, cell);
      chrome(frame);
    },
  },
  {
    title: "the big one scaled into 30 by 8 cells, a region of it beside",
    draw: frame => {
      frame.show(big, { col: 4, row: 3, cols: 30, rows: 8 });
      frame.show(big, { col: 40, row: 3, region: new Rect(big.width / 2, 0, big.width / 2, big.height / 2) });
    },
  },
  {
    title: "the same, on a screen cleared and drawn from nothing",
    repaint: true,
    draw: frame => {
      frame.show(big, { col: 4, row: 3, cols: 30, rows: 8 });
      frame.show(big, { col: 40, row: 3, region: new Rect(big.width / 2, 0, big.width / 2, big.height / 2) });
    },
  },
  {
    title: "everything covered: no pictures, kept by the host",
    draw: (frame, text) => {
      frame.show(big, { col: 4, row: 3 });
      frame.show(small, { col: 30, row: 3 });
      const box = new Rect(0, 2, cols, rows - 2);
      card(text, box, " a card over everything");
      frame.cover(box);
    },
  },
  {
    title: "uncovered: both back, nothing sent",
    draw: frame => {
      frame.show(big, { col: 4, row: 3 });
      frame.show(small, { col: 30, row: 3 });
    },
  },
  { title: "nothing: every picture freed", draw: () => {} },
];

let differ = Differ.create(cols, rows);
for (const [i, scene] of scenes.entries()) {
  const frame = store.frame(cell),
    text: string[] = [];
  for (let y = 2; y < rows; y++)
    text[y] = `\x1b[${y + 1};1H\x1b[0;90m${`row ${String(y + 1).padStart(2)} `.padEnd(cols, "·").slice(0, cols)}`;
  if (kitty) scene.draw(frame, text);
  const heading = `\x1b[1;1H\x1b[0;1m${name}  scene ${i}: ${scene.title}\x1b[0m\x1b[2;1H${kitty ? "" : "no Kitty images on this host"}`;
  if (scene.repaint) {
    differ.destroy();
    differ = Differ.create(cols, rows);
    write("\x1b[2J");
  }
  const pictures = store.present();
  if (pictures.send) write(pictures.send);
  const clear = "\x1b_Ga=d,d=a,q=2\x1b\\" + pictures.redraw;
  const shown = "\x1b[?25l\x1b[0m\x1b[H\x1b[J" + heading + text.join("") + "\x1b[1;1H";
  write(differ.diff(shown, mode === "clear" ? { draw: clear, redraw: clear } : pictures));
  if (pictures.free) write(pictures.free);
  await sleep(150);
  let sent = pictures.send.length,
    drawn = (mode === "clear" ? clear : pictures.draw).length;
  const answered = replies;
  // As the viewer does: a picture the host answers an error about goes again.
  for (let tries = 0; tries < 3; tries++) {
    const refused = [...replies.matchAll(/\x1b_G(?:[^;\x1b]*,)?i=(\d+)[^;\x1b]*;(?!OK)/g)].filter(m =>
      store.refused(Number(m[1])),
    );
    replies = "";
    if (refused.length === 0) break;
    const again = store.present();
    write(again.send);
    write(differ.diff(shown, again));
    sent += again.send.length;
    drawn += again.draw.length;
    await sleep(150);
  }
  log(
    `scene ${i} send=${sent} draw=${drawn} free=${pictures.free.length}` +
      (answered ? ` replies=${JSON.stringify(answered.replace(/[^\x20-\x7e]/g, "?").slice(0, 160))}` : ""),
  );
  replies = "";
  if (!out) await sleep(2000);
  else {
    writeFileSync(join(out, `${tag}-${i}.ready`), "");
    for (let waited = 0; waited < 30_000 && !existsSync(join(out, `${tag}-${i}.shot`)); waited += 50) await sleep(50);
  }
}
leave(0);
