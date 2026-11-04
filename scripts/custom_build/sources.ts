/** Where a patch comes from: a branch of this repository, a pull request on
 * GitHub, or a branch of another repository. */
export type PatchSource =
  | { kind: "branch"; name: string }
  | { kind: "pr"; repo: string; number: number }
  | { kind: "fork-branch"; repo?: string; url?: string; branch: string };

const repoName = "[\\w.-]+/[\\w.-]+";

/** The source an `add` argument names (`#123`, `owner/repo#12`, `owner/repo:branch`,
 * a GitHub pull or tree URL, `<git url>#branch=<name>`, or a branch name). */
export function parse(arg: string, upstreamRepo: string): PatchSource {
  const text = arg.trim();
  let match: RegExpMatchArray | null;
  if ((match = text.match(/^#?(\d+)$/))) return { kind: "pr", repo: upstreamRepo, number: Number(match[1]) };
  if ((match = text.match(new RegExp(`^https://github\\.com/(${repoName})/pull/(\\d+)/?$`))))
    return { kind: "pr", repo: match[1], number: Number(match[2]) };
  if ((match = text.match(new RegExp(`^(${repoName})#(\\d+)$`))))
    return { kind: "pr", repo: match[1], number: Number(match[2]) };
  if ((match = text.match(new RegExp(`^https://github\\.com/(${repoName})/tree/(.+?)/?$`))))
    return { kind: "fork-branch", repo: match[1], branch: match[2] };
  if ((match = text.match(/^(.+)#branch=(.+)$/))) return { kind: "fork-branch", url: match[1], branch: match[2] };
  if ((match = text.match(new RegExp(`^(${repoName}):(.+)$`))))
    return { kind: "fork-branch", repo: match[1], branch: match[2] };
  return { kind: "branch", name: text };
}

/** Why a fork URL can't be used: credentials in it would be stamped into the
 * binary, the bug report, commit messages and prompts. Null when it is fine. */
export function urlProblem(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.password || (/^https?:$/.test(parsed.protocol) && parsed.username))
    return `${parsed.protocol}//${parsed.host}${parsed.pathname} carries credentials; drop them from the URL and use a git credential helper`;
  return null;
}

/** A source's name everywhere it is shown, and its identity in the patch list. */
export function display(source: PatchSource): string {
  switch (source.kind) {
    case "branch":
      return source.name;
    case "pr":
      return `${source.repo}#${source.number}`;
    case "fork-branch":
      return `${source.repo ?? source.url}:${source.branch}`;
  }
}

/** A display string as a file name: lowercase, runs of other characters as `-`. */
export function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "patch"
  );
}

/** GitHub's base URL; tests point it at local bare repositories. */
export function githubBase(env: Record<string, string | undefined> = process.env): string {
  return (env.CORGI_CUSTOM_BUILD_GITHUB || "https://github.com").replace(/\/$/, "");
}

/** The URL to fetch a PR or another repository's branch from; null for own branches. */
export function fetchUrl(source: PatchSource, env: Record<string, string | undefined> = process.env): string | null {
  switch (source.kind) {
    case "branch":
      return null;
    case "pr":
      return `${githubBase(env)}/${source.repo}.git`;
    case "fork-branch":
      return source.url ?? `${githubBase(env)}/${source.repo}.git`;
  }
}

/** The ref GitHub publishes for a PR head, or the fetched branch; null for own branches. */
export function remoteRef(source: PatchSource): string | null {
  switch (source.kind) {
    case "branch":
      return null;
    case "pr":
      return `refs/pull/${source.number}/head`;
    case "fork-branch":
      return `refs/heads/${source.branch}`;
  }
}

/** Where a fetched source is kept, away from branches and remotes; null for own branches. */
export function privateRef(source: PatchSource): string | null {
  switch (source.kind) {
    case "branch":
      return null;
    case "pr":
      return `refs/custom-build/${source.repo}/pull/${source.number}`;
    case "fork-branch":
      return `refs/custom-build/${source.repo ?? slug(source.url ?? "")}/heads/${source.branch}`;
  }
}

/** The PR's web page, for reports and prompts. */
export function prLink(source: PatchSource): string | null {
  return source.kind === "pr" ? `https://github.com/${source.repo}/pull/${source.number}` : null;
}
