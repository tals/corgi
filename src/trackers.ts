export * as git_push from "./trackers/git_push";
export * as git_status from "./trackers/git_status";
export * as link_labels from "./trackers/link_labels";
export * as ports from "./trackers/ports";
export * as resources from "./trackers/resources";
export * as worktrees from "./trackers/worktrees";

import type { Runtime } from "./runtime";

/** Apply scans already in flight before acknowledging a test settle. */
export async function settle(runtime: Runtime, collect: () => Promise<void>) {
  await collect();
  while (runtime.ports.busy() || runtime.git_status.busy() || runtime.worktree_tracker.busy()) {
    await Promise.all([runtime.ports.thread, runtime.git_status.thread, runtime.worktree_tracker.thread]);
    await collect();
  }
  await Bun.sleep(16);
  await collect();
}
