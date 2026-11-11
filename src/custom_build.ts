import * as config from "./build_config";

/** Where a build's commit lives, relative to what upstream publishes. */
export type Identity = { repository: string };

export const upstreamRepository = "github.com/tals/corgi";
/** This binary's identity, as build.ts stamped it. */
export const current: Identity = { repository: config.buildRepository };

/** A remote URL as `host/owner/repo`, without user, credentials, port or
 * `.git`; empty for a local path or anything else without a host. */
export function repository(url: string): string {
  const u = url.trim(),
    m =
      /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:@]+)(?::\d*)?\/(.+?)(?:\.git)?\/*$/i.exec(u) ??
      /^(?:[^@/:]+@)?([^/:@]+):(?!\/)(.+?)(?:\.git)?\/*$/.exec(u);
  return m && /^[\w.-]+$/.test(m[1]) ? `${m[1].toLowerCase()}/${m[2]}` : "";
}

/** Whether a build differs from what upstream publishes: its commit lives in
 * another repository. */
export function custom(id: Identity): boolean {
  return id.repository !== "" && id.repository !== upstreamRepository;
}

/** The repository as an https link, for the bug report and
 * `--version --verbose`; nothing for a vanilla build. */
export function lines(id: Identity): string[] {
  return custom(id) ? [`https://${id.repository}`] : [];
}

/** `corgi --version` output: the release line, and with `verbose` the
 * repository. */
export function versionText(version: string, commit: string, id: Identity, verbose: boolean): string {
  const out = [`corgi ${version} (${commit})`];
  if (verbose) out.push(...lines(id).map(line => `  ${line}`));
  return out.join("\n") + "\n";
}

/** The identity of the checkout at `root`: the repository the branch's remote
 * pushes to (origin when that remote is upstream or missing). A remote that
 * fetches upstream and pushes to a fork names the fork. Git failures leave it
 * empty. */
export function fromGit(root: string): Identity {
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "ignore" });
    return r.exitCode === 0 ? r.stdout.toString().trim() : null;
  };
  // The push URL, unless it names no repository (`no_push` and the like).
  const url = (name: string) =>
    repository(git("remote", "get-url", "--push", name)?.split("\n")[0] ?? "") ||
    repository(git("remote", "get-url", name) ?? "");
  const remotes = (git("remote") ?? "")
      .split("\n")
      .filter(Boolean)
      .map(name => ({ name, repository: url(name) })),
    tracked = git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}") ?? "",
    // Upstream can't hold a fork's commits, so a branch tracking it names origin instead.
    candidates = [
      remotes.filter(r => tracked.startsWith(r.name + "/")).sort((a, b) => b.name.length - a.name.length)[0],
      remotes.find(r => r.name === "origin"),
    ].filter(r => r !== undefined),
    own = candidates.find(r => r.repository !== upstreamRepository) ?? candidates[0];
  return { repository: own?.repository ?? "" };
}
