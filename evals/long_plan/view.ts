#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";
import * as palette from "../../src/palette";
import * as history from "./history";
import * as plan from "./plan";

const directories = process.argv.slice(2);
if (!directories.length) throw Error("Usage: bun evals/long_plan/view.ts RUN_DIR [RUN_DIR...]");
const cases = new Map<string, unknown>();
for (const directory of directories) {
  const report = JSON.parse(fs.readFileSync(path.join(directory, "report.json"), "utf8"));
  for (const result of report.cases) {
    const accounted = path.join(directory, `${result.id}.accounted.history.json`);
    const data: history.History = JSON.parse(
      fs.readFileSync(fs.existsSync(accounted) ? accounted : path.join(directory, `${result.id}.history.json`), "utf8"),
    );
    const calls = JSON.parse(fs.readFileSync(path.join(directory, `${result.id}.calls.json`), "utf8"));
    const snapshots = calls.filter((c: { state?: unknown }) => c.state);
    if (!snapshots.length || report.baseline) continue;
    cases.set(result.id, {
      id: result.id,
      provider: data.provider,
      model: report.model,
      source: data.source,
      sha256: data.sha256,
      events: data.events.map((e: history.Event) => ({
        ...e,
        text:
          e.kind === "reasoning"
            ? "Reasoning signal present; raw reasoning is omitted from this design review."
            : e.text,
      })),
      snapshots: snapshots.map((s: { state: plan.State; through: number; elapsed_ms: number }) => ({
        state: s.state,
        ledger: plan.ledger(s.state, data, data.events[s.through - 1].line),
        through: s.through,
        elapsed_ms: s.elapsed_ms,
      })),
      complete: result.state.through === data.events.length,
      checks: result.checks,
      errors: result.errors,
    });
  }
}
const toolkit = fs.readFileSync(path.join(import.meta.dir, "../../termhtml/index.html"), "utf8");
const styles = toolkit.match(/<style id="termhtml-styles">[\s\S]*?<\/style>/)![0];
const script = toolkit.match(/<script id="termhtml-toolkit">[\s\S]*?<\/script>/)![0];
const css = Object.entries(palette.colors)
  .map(([key, rgb]) => `--${key}:rgb(${rgb.join(",")});`)
  .join("");
const template = fs.readFileSync(path.join(import.meta.dir, "view.html"), "utf8");
const output = path.resolve(".lavish/long-plan.html");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(
  output,
  template
    .replace("/*PALETTE*/", css)
    .replace("<!--STYLES-->", () => styles)
    .replace("<!--TOOLKIT-->", () => script)
    .replace("/*DATA*/[]", () => JSON.stringify([...cases.values()]).replaceAll("<", "\\u003c")),
);
console.log(output);
