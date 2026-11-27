#!/usr/bin/env bun
// Run inside tools/ghostty_screenshot.ts -- to capture the actual agent tooltip.
import * as fs from "node:fs";
import * as path from "node:path";
import * as history from "./history";
import * as plan from "./plan";
import * as tooltip from "./tooltip";
import * as palette from "../../src/palette";
import { Writer } from "../../src/text";

const [directory, id, event = "Infinity"] = process.argv.slice(2);
if (!directory || !id) throw Error("Usage: capture.ts RUN_DIRECTORY CASE [EVENT]");
const data: history.History = JSON.parse(fs.readFileSync(path.join(directory, `${id}.history.json`), "utf8"));
const calls: { through: number; state?: plan.State }[] = JSON.parse(
  fs.readFileSync(path.join(directory, `${id}.calls.json`), "utf8"),
);
const call = calls.findLast(c => c.state && c.through <= Number(event));
if (!call?.state) throw Error("NoCheckpoint");
const line = data.events.find(e => e.id === call.through)!.line;
const view = plan.snapshot(call.state, data, line);
const draw = () => {
  const out = new Writer();
  out.write(new palette.Style({ bg: "bg", fg: "text" }).sgr() + "\x1b[2J\x1b[?25l");
  tooltip.draw(
    out,
    process.stdout.columns || 116,
    process.stdout.rows || 24,
    id,
    data.provider,
    view,
    history.runningAt(history.activity(data), line),
  );
  process.stdout.write(out.buffered());
};
draw();
process.stdout.on("resize", draw);
process.stdin.resume();
