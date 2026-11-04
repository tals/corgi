import * as config from "./build_config";

/** One merge a build carries on top of upstream main, as git recorded it. */
export type BuildMerge = { commit: string; subject: string };
/** Where a build's commit lives and what it merged onto upstream main. */
export type Identity = { repository: string; merges: readonly BuildMerge[] };

export const upstreamRepository = "github.com/tals/corgi";
/** This binary's identity, as build.ts stamped it. */
export const current: Identity = { repository: config.buildRepository, merges: config.buildMerges };

/** A remote URL as `host/owner/repo`, without user, credentials, port or
 * `.git`; empty for a local path or anything else without a host. */
export function repository(url: string): string {
  const u = url.trim(),
    m =
      /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:@]+)(?::\d*)?\/(.+?)(?:\.git)?\/*$/i.exec(u) ??
      /^(?:[^@/:]+@)?([^/:@]+):(?!\/)(.+?)(?:\.git)?\/*$/.exec(u);
  return m && /^[\w.-]+$/.test(m[1]) ? `${m[1].toLowerCase()}/${m[2]}` : "";
}

/** Whether a build differs from what upstream publishes: it merged something
 * onto main, or its commit lives in another repository. */
export function custom(id: Identity): boolean {
  return id.merges.length > 0 || (id.repository !== "" && id.repository !== upstreamRepository);
}

/** The repository, then one line per merge in merge order, for the bug
 * report and `--version --verbose`; nothing for a vanilla build. */
export function lines(id: Identity): string[] {
  if (!custom(id)) return [];
  return [...(id.repository ? [id.repository] : []), ...id.merges.map(m => `${m.commit.slice(0, 7)} ${m.subject}`)];
}

/** `corgi --version` output: the release line, and with `verbose` the
 * repository and merges. */
export function versionText(version: string, commit: string, id: Identity, verbose: boolean): string {
  const out = [`corgi ${version} (${commit})`];
  if (verbose) out.push(...lines(id).map(line => `  ${line}`));
  return out.join("\n") + "\n";
}

/** The identity of the checkout at `root`: the repository of the branch's
 * remote (or origin, when that remote is upstream or missing), and the
 * first-parent merges since main on the remote that points at upstream (or
 * origin). Git failures leave the parts they affect empty. */
export function fromGit(root: string): Identity {
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "ignore" });
    return r.exitCode === 0 ? r.stdout.toString().trim() : null;
  };
  const remotes = (git("remote") ?? "")
      .split("\n")
      .filter(Boolean)
      .map(name => ({ name, repository: repository(git("remote", "get-url", name) ?? "") })),
    tracked = git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}") ?? "",
    // Upstream can't hold a fork's commits, so a branch tracking it names origin instead.
    candidates = [
      remotes.filter(r => tracked.startsWith(r.name + "/")).sort((a, b) => b.name.length - a.name.length)[0],
      remotes.find(r => r.name === "origin"),
    ].filter(r => r !== undefined),
    own = candidates.find(r => r.repository !== upstreamRepository) ?? candidates[0],
    upstream = remotes.find(r => r.repository === upstreamRepository);
  const from = `${upstream?.name ?? "origin"}/main`,
    log = git("log", "--merges", "--first-parent", "--reverse", "--format=%H%x09%s", `${from}..HEAD`) ?? "";
  return {
    repository: own?.repository ?? "",
    merges: log
      .split("\n")
      .filter(Boolean)
      .map(line => {
        const tab = line.indexOf("\t");
        return { commit: line.slice(0, tab), subject: line.slice(tab + 1) };
      }),
  };
}
