export type PrState = "OPEN" | "CLOSED" | "MERGED";
export type PrInfo = { state: PrState; title: string; mergeCommit: string | null };

/** A PR's state, title and merge commit from the GitHub CLI; null without `gh`
 * or when it can't answer (not signed in, offline, no such PR). */
export function prInfo(
  repo: string,
  number: number,
  env: Record<string, string | undefined> = process.env,
): PrInfo | null {
  const gh = Bun.which("gh", { PATH: env.PATH ?? "" });
  if (!gh) return null;
  const p = Bun.spawnSync([gh, "pr", "view", String(number), "--repo", repo, "--json", "state,title,mergeCommit"], {
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  if (p.exitCode !== 0) return null;
  try {
    const raw = JSON.parse(p.stdout.toString()) as Record<string, unknown>,
      state = String(raw.state ?? "").toUpperCase(),
      merge = raw.mergeCommit as { oid?: unknown } | null | undefined;
    if (state !== "OPEN" && state !== "CLOSED" && state !== "MERGED") return null;
    return {
      state,
      title: typeof raw.title === "string" ? raw.title : "",
      mergeCommit: typeof merge?.oid === "string" ? merge.oid : null,
    };
  } catch {
    return null;
  }
}

/** A PR title as a description, without the leading `area: `. */
export function stripArea(title: string): string {
  return title.replace(/^[\w./-]+:\s+/, "").trim();
}
