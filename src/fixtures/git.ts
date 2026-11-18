import { execFileSync } from "node:child_process";

/** Runs git in `repo` as a fixed author and committer, and returns what it printed, trimmed. */
export function runGit(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  })
    .toString()
    .trim();
}
