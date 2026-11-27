import * as palette from "../../src/palette";
import { grid } from "../../site/terminal";
import type * as artifact from "./artifact";

type Child = Node | string | null | false | undefined;
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string> | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(props ?? {})) element.setAttribute(name, value);
  for (const child of children) if (child !== null && child !== false && child !== undefined) element.append(child);
  return element;
}
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const present = (children: Child[]) =>
  children.filter((c): c is Node | string => c !== null && c !== false && c !== undefined);

async function unpack<T>(element: HTMLElement): Promise<T> {
  const bytes = Uint8Array.from(atob(element.textContent!.trim()), c => c.charCodeAt(0)),
    stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).json();
}

const groups: Record<artifact.Group, string> = {
  long: "Long development sessions",
  routine: "Routine development sessions",
  excerpt: "Earlier short replays",
  probe: "Synthetic probes",
  reference: "Reference plans (whole session, one shot)",
};
const kinds: Record<string, string> = {
  user: "user",
  assistant: "agent",
  reasoning: "reasoning",
  tool: "tool",
  result: "result",
  plan: "todo",
  lifecycle: "lifecycle",
};
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const seconds = (ms: number) => (ms < 10_000 ? (ms / 1000).toFixed(1) : Math.round(ms / 1000)) + " s";
const scoreClass = (n: number) => (n <= 2 ? "low" : n <= 3 ? "mid" : "high");

/* Terminal: Corgi's palette, one fixed-width cell per column. */
const rgb = (name: string | null, fallback: palette.Token) =>
  name?.startsWith("#") ? name : `rgb(${palette.colors[(name ?? fallback) as palette.Token].join(",")})`;
function paint(screen: HTMLElement, ansi: string, cols: number, rows: number) {
  const cells = grid(ansi, cols, rows);
  const blank = (row: (typeof cells)[number]) => row.every(c => (c[0] === " " || c[0] === "") && c[2] === null);
  let first = 0,
    used = cells.length;
  while (used > 1 && blank(cells[used - 1])) used--;
  while (first < used - 1 && blank(cells[first])) first++;
  const fragment = document.createDocumentFragment();
  for (const row of cells.slice(first, used)) {
    const line = h("div", { class: "row" });
    for (const [ch, fg, bg, bold, underline, underlineColor, strike] of row) {
      const cell = h("span", null, ch);
      cell.style.color = rgb(fg, "text");
      if (bg !== null) cell.style.backgroundColor = rgb(bg, "bg");
      if (bold) cell.style.fontWeight = "700";
      const lines = [underline ? "underline" : "", strike ? "line-through" : ""].filter(Boolean).join(" ");
      if (lines) cell.style.textDecorationLine = lines;
      if (underline && underlineColor) cell.style.textDecorationColor = rgb(underlineColor, "text");
      line.append(cell);
    }
    fragment.append(line);
  }
  screen.replaceChildren(fragment);
}

/* Command program: verbs, paths and ranges picked out. */
const pathArgs: Record<string, number[]> = {
  mkdir: [1],
  set: [1],
  error: [1],
  cd: [1],
  mv: [1, 2],
  set_owner: [2],
  set_focus: [2],
};
function program(raw: string) {
  const code = h("code", null);
  raw.split("\n").forEach((text, index, all) => {
    if (index === all.length - 1 && text === "") return;
    const line = h("span", { class: "line" });
    const parts = text.split(/( +)/),
      verb = parts[0],
      paths = pathArgs[verb] ?? [];
    if (verb === "BEGIN_PLAN") line.append(h("span", { class: "marker" }, text));
    else {
      let word = 0;
      for (const part of parts) {
        if (/^ +$/.test(part) || part === "") {
          line.append(part);
          continue;
        }
        if (word === 0) line.append(h("span", { class: "verb" }, part));
        else if (paths.includes(word)) line.append(h("span", { class: part.startsWith("/") ? "path" : "range" }, part));
        else if (word === 1 && (verb === "set_owner" || verb === "set_focus"))
          line.append(h("span", { class: "range" }, part));
        else if (word === 2 && (verb === "set" || verb === "error") && /^[a-z_]+$/.test(part))
          line.append(h("span", { class: "key" }, part));
        else line.append(part);
        word++;
      }
    }
    code.append(line);
  });
  return h("pre", { class: "program" }, code);
}

async function main() {
  const data = await unpack<artifact.Payload>($("#replay-data"));
  const replaySelect = $<HTMLSelectElement>("#replay"),
    rowsSelect = $<HTMLSelectElement>("#rows"),
    colsSelect = $<HTMLSelectElement>("#cols"),
    sessionSelect = $<HTMLSelectElement>("#session"),
    slider = $<HTMLInputElement>("#update"),
    screen = $("#screen"),
    wrap = $("#wrap"),
    details = $<HTMLDetailsElement>("#details");
  const byKey = new Map(data.replays.map(r => [r.key, r]));
  let replay = data.replays[0],
    index = replay.updates.length - 1,
    /** The selected example, which stays chosen while its replay is shown. */
    chosen: number | null = null;
  const filters: Record<artifact.Verdict, string> = { good: "", bad: "" };
  const at = (r: artifact.Replay, u: number) => `${r.slug}-at-${r.updates[u].through}`;
  const category = (slug: string) => data.categories[slug] ?? (slug.replaceAll("_", " ") || "Other");
  const position = (e: artifact.Example) => `update ${e.update + 1} of ${byKey.get(e.replay)!.updates.length}`;
  const from = (e: artifact.Example) =>
    `${byKey.get(e.replay)!.label} · ${byKey.get(e.replay)!.provider} · ${position(e)}`;

  /* Replay bundles open on first view. */
  const bundles = new Map<string, artifact.Bundle>(),
    opening = new Map<string, Promise<void>>();
  const open = (r: artifact.Replay) => {
    if (!opening.has(r.slug))
      opening.set(
        r.slug,
        unpack<artifact.Bundle>($(`#bundle-${r.slug}`)).then(bundle => void bundles.set(r.slug, bundle)),
      );
    return opening.get(r.slug)!;
  };

  /* Totals and controls. */
  const updates = data.replays.reduce((n, r) => n + r.updates.length, 0),
    judged = data.replays.filter(r => r.judge),
    count = (v: artifact.Verdict) => data.examples.filter(e => e.verdict === v).length,
    models = [...new Set(data.replays.map(r => r.model))];
  $("#totals").textContent = [
    plural(data.replays.length, "replay"),
    plural(updates, "plan update"),
    data.examples.length ? `${count("good")} good and ${count("bad")} bad examples` : "",
    judged.length
      ? `judge mean ${(judged.reduce((n, r) => n + r.judge!.overall, 0) / judged.length).toFixed(1)}/5 over ${judged.length}`
      : "",
    models.join(", "),
  ]
    .filter(Boolean)
    .join(" · ");
  for (const group of Object.keys(groups) as artifact.Group[]) {
    const entries = data.replays.filter(r => r.group === group);
    if (!entries.length) continue;
    replaySelect.append(
      h(
        "optgroup",
        { label: groups[group] },
        ...entries.map(r =>
          h(
            "option",
            { value: r.key },
            `${r.judge ? r.judge.overall + "/5 · " : ""}${r.label} · ${r.provider} · ${plural(r.updates.length, "update")} · ${r.run}`,
          ),
        ),
      ),
    );
  }
  // A short terminal on laptop screens keeps the example panes in view.
  const tall = window.innerHeight >= 1000 ? 24 : 18;
  for (const rows of data.heights)
    rowsSelect.append(
      h("option", rows === tall ? { value: String(rows), selected: "" } : { value: String(rows) }, `${rows} rows`),
    );
  colsSelect.append(h("option", { value: "auto" }, "Fit width"));
  for (const cols of data.widths) colsSelect.append(h("option", { value: String(cols) }, `${cols} columns`));
  screen.style.backgroundColor = rgb(null, "bg");
  screen.style.color = rgb(null, "text");

  /* Terminal sizing: the widest frame that fits, its font shrunk on phones. */
  const probe = h("span", { class: "screen", style: "--fs:100px;position:absolute;visibility:hidden" }, "0".repeat(10));
  document.body.append(probe);
  const advance = probe.getBoundingClientRect().width / 1000 || 0.6,
    font = 14.5;
  probe.remove();
  function size() {
    const style = getComputedStyle(wrap),
      room = wrap.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      fixed = colsSelect.value === "auto" ? null : Number(colsSelect.value),
      cols = fixed ?? data.widths.findLast(w => w * advance * font <= room) ?? data.widths[0],
      fs = fixed ? font : Math.max(9, Math.min(font, Math.floor((room / (cols * advance)) * 10) / 10)),
      rows = Number(rowsSelect.value);
    screen.style.setProperty("--fs", `${fs}px`);
    // A steady height, so moving through updates does not shift the page.
    screen.style.minHeight = `${rows * 1.22}em`;
    return { cols, rows };
  }

  function strip() {
    const ticks = $("#strip"),
      n = replay.updates.length;
    ticks.style.gridTemplateColumns = `repeat(${n}, minmax(0, 16px))`;
    ticks.style.columnGap = n > 90 ? "0" : n > 45 ? "1px" : "2px";
    ticks.replaceChildren(
      ...replay.updates.map((u, i) => {
        const marks = [u.rejected ? "rejected" : "", u.repairs ? "repaired" : "", u.problem ? "problem" : ""].filter(
          Boolean,
        );
        return h("button", {
          type: "button",
          tabindex: "-1",
          class: "tick " + marks.join(" "),
          "data-update": String(i),
          title: `Update ${i + 1} · through event ${u.through}${marks.length ? " · " + marks.join(", ") : ""}`,
          "aria-label": `Update ${i + 1}`,
        });
      }),
    );
  }

  /* What you are looking at: the example, where it is from, and the judge's verdict on its replay. */
  function context() {
    const example = chosen === null ? null : data.examples[chosen],
      judge = replay.judge,
      parts: Child[] = [];
    if (example) {
      const row = example.row;
      parts.push(
        h(
          "div",
          { class: "kicker" },
          h("span", { class: `badge ${example.verdict}` }, example.verdict === "good" ? "Good" : "Bad"),
          h("span", { class: "cat" }, category(example.category)),
        ),
        h("h2", null, example.title),
        h("p", { class: "tldr" }, example.note),
        h(
          "dl",
          { class: "facts" },
          h("dt", null, "From"),
          h("dd", null, `${from(example)} · event ${example.event} · ${replay.run}`),
          ...(row
            ? [
                h("dt", null, "Row"),
                h(
                  "dd",
                  null,
                  h("code", null, row.id),
                  ` ${row.kind} · ${row.state}${row.subtitle ? ` · “${row.subtitle}”` : ""}`,
                  row.bump
                    ? h(
                        "span",
                        { class: row.bump.state },
                        ` · ! ${row.bump.kind} ${row.bump.state}: ${row.bump.detail}`,
                      )
                    : null,
                ),
              ]
            : []),
        ),
      );
      if (index !== example.update) {
        const back = h("button", { type: "button" }, `Back to update ${example.update + 1}`);
        back.addEventListener("click", () => select(replay.key, example.update, chosen));
        parts.push(
          h(
            "p",
            { class: "away" },
            `Showing update ${index + 1}; the example is at update ${example.update + 1}.`,
            back,
          ),
        );
      }
    } else
      parts.push(
        h(
          "div",
          { class: "kicker" },
          h("span", { class: "badge" }, "Replay"),
          h("span", { class: "cat" }, groups[replay.group]),
        ),
        h("h2", null, replay.label),
        h(
          "dl",
          { class: "facts" },
          h("dt", null, "From"),
          h(
            "dd",
            null,
            `${replay.provider} · ${replay.run} · ${plural(replay.events, "event")} · ${plural(replay.turns, "user turn")}`,
          ),
          h("dt", null, "Model"),
          h("dd", null, `${replay.model} · ${replay.ablation}`),
        ),
      );
    if (judge)
      parts.push(
        h(
          "section",
          { class: "judge" },
          h(
            "h3",
            null,
            "Judge on the final plan",
            h("span", { class: `score ${scoreClass(judge.overall)}` }, `${judge.overall}/5`),
          ),
          h("p", null, judge.summary),
          h(
            "p",
            { class: "dims" },
            ...Object.entries(judge.scores).map(([k, v]) => h("span", null, `${k} `, h("b", null, String(v)))),
          ),
          h(
            "details",
            null,
            h("summary", null, "Reasons, flagged rows and what is missing"),
            h(
              "ul",
              null,
              ...Object.entries(judge.reasons).map(([k, v]) => h("li", null, h("b", null, k), ` ${v}`)),
              ...judge.bad.map(b => h("li", null, h("b", null, `${b.id} ${category(b.fault)}`), ` ${b.why}`)),
              ...judge.missing.map(m => h("li", null, h("b", null, "Missing"), ` ${m}`)),
            ),
          ),
        ),
      );
    parts.push(
      h(
        "p",
        { class: "checks" + (replay.findings.length ? " has" : "") },
        replay.findings.length
          ? `Eval checks: ${replay.findings.map(f => f.name).join("; ")}`
          : `Eval checks: all ${plural(replay.checks, "check")} pass`,
      ),
    );
    $("#context").replaceChildren(...present(parts));
  }

  function inspector() {
    const bundle = bundles.get(replay.slug);
    if (!details.open || !bundle) return;
    const update = replay.updates[index],
      detail = bundle.details[index];
    const meta = [
      `Update ${index + 1} of ${replay.updates.length}`,
      detail.from === update.through ? `event ${update.through}` : `events ${detail.from}–${update.through}`,
      detail.elapsed_ms === null ? "" : `model call ${seconds(detail.elapsed_ms)}`,
      detail.usage ? `${detail.usage.tokens} tokens · ${detail.usage.cached} cached` : "",
    ].filter(Boolean);
    const parts: Child[] = [
      h("p", { class: "meta" }, meta.join(" · ")),
      h(
        "div",
        { class: "tags" },
        detail.rejected.length
          ? h("span", { class: "tag bad" }, plural(detail.rejected.length, "rejected attempt"))
          : null,
        detail.repairs.length ? h("span", { class: "tag warn" }, plural(detail.repairs.length, "server repair")) : null,
        h("span", { class: "tag" }, update.changed ? plural(update.changed, "row") + " changed" : "No rows changed"),
        h(
          "span",
          { class: "tag" },
          update.running === false ? "Agent idle" : update.running ? "Agent working" : "Activity unknown",
        ),
      ),
      replay.findings.length
        ? h(
            "section",
            null,
            h("h4", null, "Eval check findings for this replay"),
            h(
              "ul",
              { class: "findings" },
              ...replay.findings.map(f =>
                h("li", null, h("strong", null, f.name), f.detail ? h("span", null, f.detail) : null),
              ),
            ),
          )
        : null,
      h(
        "section",
        null,
        h("h4", null, "Command program"),
        detail.raw ? program(detail.raw) : h("p", { class: "note" }, "Empty response."),
      ),
      detail.repairs.length
        ? h(
            "section",
            null,
            h("h4", null, "Server repairs"),
            h("ul", { class: "repairs" }, ...detail.repairs.map(r => h("li", null, r))),
          )
        : null,
      ...detail.rejected.map((r, i) =>
        h(
          "details",
          { class: "rejected", open: "" },
          h("summary", null, `Rejected attempt ${i + 1}`),
          h("p", { class: "reason" }, r.reason),
          program(r.raw),
        ),
      ),
      h(
        "section",
        null,
        h("h4", null, `Events the model read · ${detail.events.length}`),
        detail.support
          ? h(
              "p",
              { class: "note" },
              `Also supplied ${plural(detail.support, "older event")} as context, not shown here.`,
            )
          : null,
        h(
          "ol",
          { class: "events" },
          ...detail.events.map(e =>
            h(
              "li",
              { class: `event kind-${e.kind}` },
              h(
                "div",
                { class: "event-head" },
                h("span", { class: "event-id" }, `@${e.id}`),
                h("span", { class: "kind" }, kinds[e.kind] ?? e.kind),
                h("span", { class: "turn" }, `turn ${e.turn}`),
                h(
                  "span",
                  { class: e.owner ? "owner" : "owner none" },
                  (e.focus ? "▶ " : "→ ") + (e.owner === null ? "unowned" : (detail.owners[e.owner] ?? e.owner)),
                ),
              ),
              h("pre", { class: "event-text" }, e.text),
            ),
          ),
        ),
      ),
    ];
    $("#inspector").replaceChildren(...present(parts));
  }

  function render() {
    const update = replay.updates[index],
      { cols, rows } = size();
    slider.max = String(replay.updates.length - 1);
    slider.value = String(index);
    $("#position").textContent =
      `Update ${index + 1} of ${replay.updates.length} · event ${update.through} of ${replay.events}`;
    $("#prev").toggleAttribute("disabled", index === 0);
    $("#next").toggleAttribute("disabled", index === replay.updates.length - 1);
    for (const tick of $("#strip").children)
      tick.classList.toggle("current", (tick as HTMLElement).dataset.update === String(index));
    context();
    const bundle = bundles.get(replay.slug);
    if (!bundle) {
      screen.textContent = "Loading…";
      open(replay).then(render);
      return;
    }
    paint(screen, bundle.frames.list[bundle.frames.index[`${cols}x${rows}`][index]], cols, rows);
    inspector();
    try {
      history.replaceState(null, "", "#" + at(replay, index));
    } catch {}
  }
  function select(key: string, update: number | null, example: number | null = null) {
    const changed = key !== replay.key;
    replay = byKey.get(key) ?? replay;
    index = Math.max(0, Math.min(update ?? replay.updates.length - 1, replay.updates.length - 1));
    chosen = example;
    replaySelect.value = replay.key;
    if (changed || !$("#strip").children.length) strip();
    for (const row of document.querySelectorAll<HTMLElement>(".ex"))
      row.setAttribute("aria-selected", String(row.dataset.example === String(chosen)));
    render();
  }
  const step = (delta: number) => {
    const next = Math.max(0, Math.min(index + delta, replay.updates.length - 1));
    if (next === index) return;
    index = next;
    render();
  };
  function fromHash() {
    const match = /^#(.+)-at-(\d+)$/.exec(location.hash);
    const r = match && data.replays.find(r => r.slug === match[1]);
    if (!r) return false;
    const u = r.updates.findIndex(u => u.through === Number(match![2]));
    select(r.key, u < 0 ? null : u);
    return true;
  }

  /* Example panes: filter by session and category; arrow keys move within a pane. */
  const sessions = [...new Set(data.examples.map(e => e.replay))];
  sessionSelect.append(
    h("option", { value: "" }, `All sessions (${data.examples.length})`),
    ...sessions.map(key => {
      const r = byKey.get(key)!;
      return h(
        "option",
        { value: key },
        `${r.label} · ${r.run} (${data.examples.filter(e => e.replay === key).length})`,
      );
    }),
  );
  const order = new Map(data.replays.map((r, i) => [r.key, i]));
  function panes() {
    const session = sessionSelect.value;
    for (const verdict of ["good", "bad"] as const) {
      const pane = $(`.pane.${verdict}`),
        all = data.examples.map((e, i) => ({ e, i })).filter(({ e }) => e.verdict === verdict),
        inSession = all.filter(({ e }) => !session || e.replay === session),
        counts = new Map<string, number>();
      for (const { e } of inSession) counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
      const ranked = [...counts].sort((a, b) => b[1] - a[1] || category(a[0]).localeCompare(category(b[0])));
      if (filters[verdict] && !counts.has(filters[verdict])) filters[verdict] = "";
      const chip = (slug: string, label: string, n: number) => {
        const button = h(
          "button",
          { type: "button", class: "chip", "aria-pressed": String(filters[verdict] === slug) },
          label,
          h("span", null, String(n)),
        );
        button.addEventListener("click", () => {
          filters[verdict] = filters[verdict] === slug ? "" : slug;
          panes();
        });
        return button;
      };
      pane
        .querySelector(".chips")!
        .replaceChildren(
          chip("", "All", inSession.length),
          ...ranked.map(([slug, n]) => chip(slug, category(slug), n)),
        );
      const rank = new Map(ranked.map(([slug], i) => [slug, i]));
      const shown = inSession
        .filter(({ e }) => !filters[verdict] || e.category === filters[verdict])
        .sort(
          (a, b) =>
            rank.get(a.e.category)! - rank.get(b.e.category)! ||
            order.get(a.e.replay)! - order.get(b.e.replay)! ||
            a.e.update - b.e.update,
        );
      pane.querySelector(".count")!.textContent =
        shown.length === all.length ? String(all.length) : `${shown.length} of ${all.length}`;
      const list = pane.querySelector<HTMLElement>(".list")!;
      list.replaceChildren(
        ...(shown.length
          ? shown.map(({ e, i }) =>
              h(
                "div",
                {
                  class: "ex",
                  role: "option",
                  id: `example-${i}`,
                  "data-example": String(i),
                  "aria-selected": String(i === chosen),
                  title: e.note,
                },
                h("span", { class: "ex-cat" }, category(e.category)),
                h("span", { class: "ex-title" }, e.title),
                h(
                  "span",
                  { class: "ex-from" },
                  h(
                    "span",
                    { class: "ex-session" },
                    `${byKey.get(e.replay)!.label} · ${byKey.get(e.replay)!.provider}`,
                  ),
                  h("span", { class: "ex-at" }, ` · ${position(e)}`),
                ),
                h("span", { class: "ex-tldr" }, e.tldr),
              ),
            )
          : [h("p", { class: "empty" }, "No examples match these filters.")]),
      );
      if (shown.some(({ i }) => i === chosen)) list.setAttribute("aria-activedescendant", `example-${chosen}`);
      else list.removeAttribute("aria-activedescendant");
    }
  }
  const choose = (i: number) => {
    const e = data.examples[i];
    select(e.replay, e.update, i);
    const row = document.getElementById(`example-${i}`),
      list = row?.closest<HTMLElement>(".list");
    if (!row || !list) return;
    list.setAttribute("aria-activedescendant", row.id);
    // Scroll the pane, never the page.
    const top = row.offsetTop;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + row.offsetHeight > list.scrollTop + list.clientHeight)
      list.scrollTop = top + row.offsetHeight - list.clientHeight;
  };
  for (const list of document.querySelectorAll<HTMLElement>(".list")) {
    list.addEventListener("click", event => {
      const row = (event.target as HTMLElement).closest<HTMLElement>(".ex");
      if (!row) return;
      choose(Number(row.dataset.example));
      // On a phone the preview sits above the panes; bring it back into view.
      const stage = $("#stage").getBoundingClientRect();
      if (stage.top < -stage.height / 3)
        $("#stage").scrollIntoView({
          behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        });
    });
    list.addEventListener("keydown", event => {
      const rows = [...list.querySelectorAll<HTMLElement>(".ex")];
      if (!rows.length) return;
      const current = rows.findIndex(r => r.dataset.example === String(chosen));
      const target: Record<string, number> = {
        ArrowDown: current < 0 ? 0 : Math.min(current + 1, rows.length - 1),
        ArrowUp: current < 0 ? 0 : Math.max(current - 1, 0),
        Home: 0,
        End: rows.length - 1,
      };
      if (!(event.key in target)) return;
      event.preventDefault();
      choose(Number(rows[target[event.key]].dataset.example));
    });
  }
  if (data.examples.length) {
    $("#examples").hidden = false;
    sessionSelect.addEventListener("change", panes);
    panes();
  }

  replaySelect.addEventListener("change", () => select(replaySelect.value, null));
  slider.addEventListener("input", () => {
    index = Number(slider.value);
    render();
  });
  rowsSelect.addEventListener("change", render);
  colsSelect.addEventListener("change", render);
  $("#prev").addEventListener("click", () => step(-1));
  $("#next").addEventListener("click", () => step(1));
  $("#strip").addEventListener("click", event => {
    const tick = (event.target as HTMLElement).closest<HTMLElement>("[data-update]");
    if (!tick) return;
    index = Number(tick.dataset.update);
    render();
  });
  screen.addEventListener("keydown", event => {
    const keys: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, Home: -Infinity, End: Infinity };
    if (!(event.key in keys)) return;
    event.preventDefault();
    const delta = keys[event.key];
    step(Number.isFinite(delta) ? delta : delta < 0 ? -index : replay.updates.length);
  });
  details.addEventListener("toggle", inspector);
  let width = window.innerWidth;
  window.addEventListener("resize", () => {
    if (window.innerWidth === width) return;
    width = window.innerWidth;
    render();
  });
  window.addEventListener("hashchange", () => fromHash());
  if (!fromHash()) {
    const first = $(".pane.good .ex") ?? $(".pane.bad .ex");
    if (first) choose(Number(first.dataset.example));
    else select(replay.key, null);
  }
  await open(replay);
  $("#status").hidden = true;
  document.body.dataset.ready = "";
}

main().catch(error => {
  $("#status").hidden = false;
  $("#status").textContent =
    `This page could not load its replays: ${error instanceof Error ? error.message : String(error)}`;
  throw error;
});
