import * as palette from "../../src/palette";
import type * as roadmap from "../../src/activity/roadmap";
import { grid } from "../../site/terminal";

type Replay = {
  key: string;
  id: string;
  label: string;
  provider: string;
  cohort: "routine" | "long" | "probe" | "excerpt";
  events: number;
  turns: number;
  ablation: string;
  model: string;
  source: string;
  checkpoints: { through: number; view: roadmap.Snapshot; running: boolean | null; frames: Record<string, string> }[];
  failures: string[];
};
const data: Replay[] = JSON.parse(document.querySelector("#data")!.textContent!);
const session = document.querySelector<HTMLSelectElement>("#session")!,
  slider = document.querySelector<HTMLInputElement>("#checkpoint")!,
  screen = document.querySelector<HTMLElement>("#screen")!,
  position = document.querySelector<HTMLElement>("#position")!,
  notes = document.querySelector<HTMLElement>("#notes")!;
const dataset = document.querySelector<HTMLElement>("#dataset")!;
const height = document.querySelector<HTMLSelectElement>("#height")!;
let cols = 110,
  rows = 34,
  narrow = false;
const groups: Record<Replay["cohort"], string> = {
  long: "Long development sessions",
  routine: "Routine development sessions",
  excerpt: "Earlier short replays",
  probe: "Synthetic probes",
};
for (const cohort of ["long", "routine", "excerpt", "probe"] as const) {
  const entries = data.filter(e => e.cohort === cohort);
  if (!entries.length) continue;
  const group = document.createElement("optgroup");
  group.label = groups[cohort];
  session.append(group);
  for (const entry of entries) {
    const option = document.createElement("option");
    option.value = entry.key;
    option.textContent = `${entry.label} · ${entry.provider} · ${entry.events} events · ${entry.turns} turns${cohort === "probe" || cohort === "excerpt" ? " · " + entry.ablation : ""}`;
    group.append(option);
  }
}
const current = () => data.find(c => c.key === session.value)!;
const view = () => current().checkpoints[Number(slider.value)].view;
const running = () => current().checkpoints[Number(slider.value)].running;
const frame = () => current().checkpoints[Number(slider.value)].frames[`${cols}x${rows}`];
const color = (name: string | null, fallback: palette.Token) =>
  name?.startsWith("#") ? name : `rgb(${palette.colors[(name ?? fallback) as palette.Token].join(",")})`;
function render() {
  const available = Math.min(narrow ? 64 : 88, Math.floor((document.querySelector("#wrap")!.clientWidth - 2) / 9));
  cols = available >= 88 ? 88 : available >= 64 ? 64 : 40;
  rows = Number(height.value);
  const fragment = document.createDocumentFragment();
  for (const row of grid(frame(), cols, rows)) {
    const line = document.createElement("div");
    line.className = "screen-row";
    for (const [ch, fg, bg, bold, , , strike] of row) {
      const cell = document.createElement("span");
      cell.textContent = ch;
      cell.style.color = color(fg, "text");
      cell.style.backgroundColor = color(bg, "bg");
      if (bold) cell.style.fontWeight = "700";
      if (strike) cell.style.textDecorationLine = "line-through";
      line.append(cell);
    }
    fragment.append(line);
  }
  screen.replaceChildren(fragment);
  screen.style.width = `${cols * 9}px`;
  position.textContent = `${Number(slider.value) + 1}/${current().checkpoints.length} · event ${current().checkpoints[Number(slider.value)].through}/${current().events}`;
  dataset.textContent = `${groups[current().cohort]} · ${current().events} events · ${current().turns} user turns · ${current().checkpoints.length} checkpoints`;
  notes.textContent = `${current().model} · ${current().ablation} · source ${current().source.slice(0, 12)} · ${current().failures.length ? "Eval findings: " + current().failures.join("; ") : "All reviewed assertions passed"}`;
}
function change() {
  slider.max = String(current().checkpoints.length - 1);
  slider.value = slider.max;
  render();
}
screen.tabIndex = 0;
screen.addEventListener("keydown", e => {
  if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", "Enter", " "].includes(e.key)) e.preventDefault();
});
slider.addEventListener("input", render);
session.addEventListener("change", change);
height.addEventListener("change", render);
window.addEventListener("resize", render);
document.querySelector("#long")!.addEventListener("click", () => {
  session.value = data.toSorted((a, b) => b.events - a.events)[0].key;
  height.value = "18";
  change();
  screen.focus({ preventScroll: true });
});
const routine = document.querySelector<HTMLButtonElement>("#routine")!;
routine.hidden = !data.some(d => d.cohort === "routine");
routine.addEventListener("click", () => {
  const bumps = (d: Replay) => d.checkpoints.at(-1)!.view.nodes.filter(n => n.bump).length;
  session.value = data
    .filter(d => d.cohort === "routine")
    .toSorted((a, b) => bumps(a) - bumps(b) || b.events - a.events)[0].key;
  change();
});
document.querySelector("#narrow")!.addEventListener("click", () => {
  narrow = !narrow;
  render();
});
document.querySelector("#ansi")!.addEventListener("click", () => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([frame()], { type: "text/plain" }));
  a.download = "corgi-plan.ansi";
  a.click();
  URL.revokeObjectURL(a.href);
});
Object.assign(window, { planReview: { view, running, render } });
const query = new URLSearchParams(location.search);
if (data.some(d => d.key === query.get("replay"))) session.value = query.get("replay")!;
if ([...height.options].some(o => o.value === query.get("rows"))) height.value = query.get("rows")!;
change();
const checkpoint = current().checkpoints.findIndex(c => c.through === Number(query.get("event")));
if (checkpoint >= 0) {
  slider.value = String(checkpoint);
  render();
}
