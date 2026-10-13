//! A build as the overview and setup name it: when it was built, and from
//! which commit.

export interface Label {
  /** When the build was made; null when unknown. */
  built_ms: number | null;
  /** The source commit's hash, as much of it as is known; "" when unknown. */
  commit: string;
  /** A development build with uncommitted changes. */
  dirty: boolean;
}
/** A dated release ("20260925T183012Z-be82c7b9090a") was built when its
 * version says, from the commit it ends with; other builds go by `built_at`.
 * A known commit replaces the version's hash, so development builds name
 * theirs too. */
export function of(version: string, commit: string, built_at = ""): Label {
  const dated = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-([0-9a-f]{7,40})$/.exec(version),
    hex = /^[0-9a-fA-F]{7,40}/.exec(commit)?.[0],
    built = dated
      ? Date.UTC(+dated[1], +dated[2] - 1, +dated[3], +dated[4], +dated[5], +dated[6])
      : Date.parse(built_at);
  return {
    built_ms: Number.isNaN(built) ? null : built,
    commit: hex ?? dated?.[7] ?? "",
    dirty: hex !== undefined && commit.endsWith("-dirty"),
  };
}
/** The commit as people quote it. */
export function short(l: Label): string {
  return l.commit.slice(0, 7);
}
/** "2026-09-25 18:30 · ", "be82c7b" and "-dirty": the local build time, the
 * short commit and its mark, each "" when unknown. */
export function parts(l: Label): [string, string, string] {
  let built = "";
  if (l.built_ms !== null) {
    const d = new Date(l.built_ms),
      two = (n: number) => String(n).padStart(2, "0");
    built = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
    if (l.commit.length > 0) built += " · ";
  }
  return [built, short(l), l.commit.length > 0 && l.dirty ? "-dirty" : ""];
}
/** "2026-09-25 18:30 · be82c7b". */
export function text(l: Label): string {
  return parts(l).join("");
}
