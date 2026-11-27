#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";
import * as palette from "../../src/palette";
import * as replays from "./replays";

const loaded = replays.load(process.argv.slice(2));
if (!loaded.length) throw Error("Provide completed replay directories");
const js = await replays.script(path.join(import.meta.dir, "preview_browser.ts"));
const css = Object.entries(palette.colors)
  .map(([k, v]) => `--${k}:rgb(${v.join(",")})`)
  .join(";");
const data = JSON.stringify(
  loaded.map(r => ({
    key: r.key,
    id: r.id,
    label: r.label,
    provider: r.provider,
    cohort: r.cohort,
    events: r.events,
    turns: r.turns,
    ablation: r.ablation,
    source: r.source,
    model: r.model,
    checkpoints: r.checkpoints.map(c => {
      const frames: Record<string, string> = {};
      for (const cols of [40, 64, 88])
        for (const rows of [18, 24, 34, 50]) frames[`${cols}x${rows}`] = replays.frame(r, c, cols, rows);
      return { through: c.call.through, view: c.view, running: c.running, frames };
    }),
    failures: replays.failures(r),
  })),
).replaceAll("<", "\\u003c");
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Corgi · Long-term plan</title><style>:root{${css}}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui}main{max-width:1080px;margin:36px auto;padding:0 12px}h1{color:var(--strong);font-size:32px;margin:8px 0}p{color:var(--muted);max-width:850px}.eyebrow{color:var(--accent);font:12px monospace;letter-spacing:.12em}.controls{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin:18px 0}select,button{min-height:36px;max-width:100%;color:var(--text);background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:6px 12px}input{flex:1;min-width:110px;accent-color:var(--accent)}#screen{font:14px/20px ui-monospace,"DejaVu Sans Mono",monospace;outline:none;margin:0 auto}#screen:focus{box-shadow:0 0 0 1px var(--accent)}.screen-row{height:20px;white-space:pre}.screen-row span{display:inline-block;width:9px;height:20px}#wrap{overflow:auto;border:1px solid var(--line);border-radius:8px}.facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:24px;margin:22px 0}.facts p{font-size:13px}#notes{font:12px/1.5 monospace;overflow-wrap:anywhere;color:var(--faint)}@media(max-width:650px){main{margin:18px auto}.facts{grid-template-columns:1fr;gap:0}h1{font-size:26px}}</style><main><div class="eyebrow">CORGI / WORKTREE DESIGN REVIEW</div><h1>Long-term plan, in Corgi.</h1><p>The actual agent tooltip, driven by recorded development conversations and synthetic probes. One row per item, with a short explanation beneath setbacks. Episodes group their steps. The goal stays in the header. The tooltip follows work chronologically. Within each episode, a step keeps one row and accumulates tokens, calls and cached usage. Resuming work moves that row to the bottom; pauses and late receipts keep the order. Returning from a different episode appends a block marked ↩, with its own costs; totals cover the whole plan. Sidebar branches connect each block; “... N more” counts hidden steps when two or more are omitted. Totals cover the whole observed plan. Try “Long example” to see a short terminal.</p><div class="controls"><label for="session">Replay</label><select id="session"></select><button id="narrow">Narrow view</button><button id="long">Long example</button><button id="routine" hidden>Routine example</button><label for="height">Height</label><select id="height"><option value="18">18 rows</option><option value="24" selected>24 rows</option><option value="34">34 rows</option><option value="50">50 rows</option></select><button id="ansi">Export ANSI</button></div><p id="dataset"></p><div class="controls"><label for="checkpoint">Checkpoint</label><input id="checkpoint" type="range" min="0"><output id="position"></output></div><div id="wrap"><div id="screen" aria-label="Corgi agent tooltip"></div></div><div class="facts"><div><strong>Keep the whole episode</strong><p>Goals survive turns. Reading, edits and retries sit under the subproblem they address.</p></div><div><strong>Keep problems visible</strong><p>A green ▶ marks the current episode and its active step. The current step stays at the bottom of the latest episode. Completed work keeps its play icon cleared; completed work is dimmed and older unfinished steps keep ordinary text. A green ▶ … keeps the tail visibly running while the next step is not known yet, including context compaction. Provider turn completion clears play markers. Adjacent checkpoints can be minutes apart; the slider does not represent elapsed time. Visits appear when work is observed. ! marks a problem on its step; !✓ and a struck-through explanation show recovery. A checked TODO is intent, not verification.</p></div><div><strong>Show what was observed</strong><p>Tokens shows uncached input plus output; Cached is separate. The original session Total stays above the plan. Episode attribution is inferred. Live plan rows count observed intervals only.</p></div></div><p id="notes"></p><p>Reload Corgi from this worktree: <code>./go.ts --reload --no-kill</code>. Long-term plans are enabled by default. Hover an agent in the sidebar to see its plan in the existing tooltip.</p></main><script id="data" type="application/json">${data}</script><script type="module">${js}</script></html>`;
fs.mkdirSync(".lavish", { recursive: true });
fs.writeFileSync(".lavish/long-plan-integrated.html", html);
console.log(`${loaded.length} replays → .lavish/long-plan-integrated.html`);
