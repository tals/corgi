/** Renders `list` as a table of the patches in merge order, or of the retired
 * ones, with each patch linked to its page on a terminal. */
import type { Config } from "./config";
import * as sources from "./sources";
import { type Cell, type Tone, table, title as toolTitle } from "./term";

/** Where a patch can be looked at: a PR's page, or a branch on GitHub. Own
 * branches link into the fork `origin` pushes to (`host/owner/repo`), when
 * that is on GitHub; anything else has no link. */
export function patchLink(source: sources.PatchSource, fork: string | null): string | null {
  switch (source.kind) {
    case "pr":
      return sources.prLink(source);
    case "fork-branch":
      return source.repo ? `https://github.com/${source.repo}/tree/${branchPath(source.branch)}` : null;
    case "branch":
      return fork?.startsWith("github.com/") ? `https://${fork}/tree/${branchPath(source.name)}` : null;
  }
}
/** A branch name as a URL path: each segment encoded (`#`, `?`, `%` and the
 * like), the `/` between them kept. */
const branchPath = (branch: string) => branch.split("/").map(encodeURIComponent).join("/");

/** Each kind of patch in its own color, so a list shows at a glance which are
 * PRs, own branches and branches from other forks. */
const kindTone: Record<sources.PatchSource["kind"], Tone> = { pr: "cyan", branch: "blue", "fork-branch": "magenta" };

export function render(
  config: Pick<Config, "patches" | "retired">,
  o: { retired: boolean; upstream: string; fork: string | null; color: boolean; columns?: number },
): string[] {
  const title = toolTitle(o.color),
    name = (s: sources.PatchSource): Cell => ({
      text: sources.display(s),
      url: patchLink(s, o.fork),
      tone: kindTone[s.kind],
    }),
    dim = (text: string): Cell => ({ text, tone: "dim" });
  if (o.retired) {
    if (!config.retired.length) return ["no retired patches"];
    const n = config.retired.length;
    return [
      `${title} · ${n} retired patch${n === 1 ? "" : "es"}`,
      "",
      ...table(
        ["PATCH", "RETIRED", "REASON"],
        config.retired.map(p => [name(p.source), dim(p.retired), { text: p.reason }]),
        { color: o.color, columns: o.columns, gap: 2 },
      ),
    ];
  }
  if (!config.patches.length) return ["no patches"];
  const n = config.patches.length;
  return [
    `${title} · ${n} patch${n === 1 ? "" : "es"}, merged in this order onto ${o.upstream}`,
    "",
    ...table(
      ["#", "PATCH", "ADDED", "DESCRIPTION"],
      config.patches.map((p, i) => [dim(String(i + 1)), name(p.source), dim(p.added), { text: p.description }]),
      { color: o.color, columns: o.columns, gap: 2 },
    ),
  ];
}
