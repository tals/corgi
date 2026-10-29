//! The last changes to which conversations panes and native sessions show,
//! kept so a checkpoint a release turns down can say how it got that way.
//! It goes in bug reports, so an entry holds ids only.
export const kinds = [
  "opened",
  "closed",
  "bound",
  "unbound",
  "released",
  "forgot",
  "restored_live",
  "restored_cold",
  "reloading",
  "imported",
] as const;
export type Kind = (typeof kinds)[number];
export const parseKind = (value: unknown): Kind | null => kinds.find(k => k === value) ?? null;
/** `pane` or `session` is 0 when the entry isn't about one. */
export type Entry = { at: number; kind: Kind; pane: number; session: number; actors: number[] };
/** Who an attachment belongs to; read when it changes, since a pane's id can move. */
export type Owner = { readonly holder: "pane" | "session"; readonly id: number };
export const capacity = 128;
let entries: Entry[] = [];

export function record(kind: Kind, about: { owner?: Owner | null; actors?: number[] } = {}): void {
  const owner = about.owner ?? null;
  entries.push({
    at: Date.now(),
    kind,
    pane: owner?.holder === "pane" ? owner.id : 0,
    session: owner?.holder === "session" ? owner.id : 0,
    actors: about.actors ?? [],
  });
  if (entries.length > capacity) entries.splice(0, entries.length - capacity);
}
export function capture(): Entry[] {
  return entries.map(e => ({ ...e, actors: [...e.actors] }));
}
/** Continues the saved log; entries this build can't read are left out. */
export function restore(saved: unknown): void {
  entries = [...parse(saved), ...entries].sort((a, b) => a.at - b.at).slice(-capacity);
}
export function parse(saved: unknown): Entry[] {
  const id = (v: unknown) =>
    Number.isInteger(v) && (v as number) >= 0 && (v as number) < 2 ** 32 ? (v as number) : null;
  return (Array.isArray(saved) ? saved : []).flatMap(e => {
    const kind = parseKind(e?.kind),
      pane = id(e?.pane ?? 0),
      session = id(e?.session ?? 0),
      actors = Array.isArray(e?.actors) ? e.actors.map(id) : [];
    if (!kind || !Number.isFinite(e?.at) || pane === null || session === null || actors.includes(null)) return [];
    return [{ at: e.at, kind, pane, session, actors: actors as number[] }];
  });
}
export function clear(): void {
  entries = [];
}
/** "pane 16 showed conversation 1". */
export function describe(e: Entry): string {
  const who = e.pane ? `pane ${e.pane}` : e.session ? `native session ${e.session}` : "",
    list = e.actors.join(", "),
    them = `conversation${e.actors.length === 1 ? "" : "s"} ${list}`;
  switch (e.kind) {
    case "opened":
      return `${who} opened`;
    case "closed":
      return `${who} closed`;
    case "bound":
      return `${who} showed ${them}`;
    case "unbound":
      return `${who} stopped showing ${them}`;
    case "released":
      return e.actors.length ? `${who}'s agent went away; it forgot ${them}` : `${who}'s agent went away`;
    case "forgot":
      return `the daemon forgot ${them}, which nothing referred to`;
    case "restored_live":
      return "the daemon took over a live handoff";
    case "restored_cold":
      return "the daemon started from a saved checkpoint";
    case "reloading":
      return "the daemon began handing off to another release";
    case "imported":
      return `${who} came in from an import`;
  }
}
/** `e` as a report line, timed from `saved_ms`: "−2m 05s  pane 16 showed conversation 1". */
export function line(e: Entry, saved_ms: number): string {
  const s = Math.max(0, Math.round((saved_ms - e.at) / 1000)),
    ago =
      s >= 3600
        ? `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, "0")}m`
        : s >= 60
          ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`
          : `${s}s`;
  return `−${ago}  ${describe(e)}`;
}
