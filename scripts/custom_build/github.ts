import { stopIfInterrupted } from "./git";

export type PrState = "OPEN" | "CLOSED" | "MERGED";
/** `head`: the repository (`owner/name`) and branch the PR is opened from. */
export type PrInfo = {
  state: PrState;
  title: string;
  mergeCommit: string | null;
  head: { repo: string; branch: string } | null;
};

/** A PR's state, title, merge commit and head from the GitHub CLI; null without `gh`
 * or when it can't answer (not signed in, offline, no such PR). */
export function prInfo(
  repo: string,
  number: number,
  env: Record<string, string | undefined> = process.env,
): PrInfo | null {
  const gh = Bun.which("gh", { PATH: env.PATH ?? "" });
  if (!gh) return null;
  const p = Bun.spawnSync(
    [
      gh,
      "pr",
      "view",
      String(number),
      "--repo",
      repo,
      "--json",
      "state,title,mergeCommit,headRepositoryOwner,headRepository,headRefName",
    ],
    {
      env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    },
  );
  stopIfInterrupted(p);
  if (p.exitCode !== 0) return null;
  try {
    const raw = JSON.parse(p.stdout.toString()) as Record<string, unknown>,
      state = String(raw.state ?? "").toUpperCase(),
      merge = raw.mergeCommit as { oid?: unknown } | null | undefined,
      owner = (raw.headRepositoryOwner as { login?: unknown } | null | undefined)?.login,
      name = (raw.headRepository as { name?: unknown } | null | undefined)?.name,
      branch = raw.headRefName;
    if (state !== "OPEN" && state !== "CLOSED" && state !== "MERGED") return null;
    return {
      state,
      title: typeof raw.title === "string" ? raw.title : "",
      mergeCommit: typeof merge?.oid === "string" ? merge.oid : null,
      head:
        typeof owner === "string" && typeof name === "string" && typeof branch === "string" && branch
          ? { repo: `${owner}/${name}`, branch }
          : null,
    };
  } catch {
    return null;
  }
}

/** A PR title as a description, without the leading `area: `. */
export function stripArea(title: string): string {
  return title.replace(/^[\w./-]+:\s+/, "").trim();
}

/** Whether `repo` (`owner/name`) is the repository at `target`, a `git.remoteTarget`
 * (`host/owner/name`, or a path for a local remote): their last two parts match. */
export function sameRepository(repo: string, target: string): boolean {
  const tail = (path: string) => path.toLowerCase().split("/").filter(Boolean).slice(-2).join("/");
  return tail(repo) !== "" && tail(repo) === tail(target);
}
