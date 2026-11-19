import type { Revision } from "../formats";
import type { ViewerFiles } from "../revision_values";

const settings = ["preset", "prefix", "keys", "language", "theme", "corgi_intensity", "resources", "worktree_folder"];

export const revision: Revision = {
  id: "50cd70f93bfd",
  parent: "3bc5f3ca7f53",
  description: "Keep settings only in config.json",
  up(value) {
    const { viewer } = value as ViewerFiles;
    for (const key of settings) delete viewer[key];
    return value;
  },
  down(value) {
    const { viewer, config } = value as ViewerFiles;
    for (const key of settings) {
      delete viewer[key];
      if (config && key in config) viewer[key] = config[key];
    }
    const keys = viewer.keys;
    if (keys && typeof keys === "object" && !Array.isArray(keys))
      viewer.keys = Object.fromEntries(
        Object.entries(keys).map(([name, shortcut]) => [name === "worktrees" ? "worktrees:0" : name, shortcut]),
      );
    return value;
  },
};
