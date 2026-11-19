import type { Revision } from "../formats";
import type { ViewerFiles } from "../revision_values";

/** What a person chooses, as opposed to what viewers remember. */
const settings = ["preset", "prefix", "keys", "language", "theme", "corgi_intensity", "resources", "worktree_folder"];
/** The defaults of the builds before this revision, which saved every field. */
const defaults: Record<string, unknown> = {
  preset: "corgi",
  prefix: "ctrl_b",
  keys: {},
  corgi_intensity: 50,
  resources: { enabled: true },
  worktree_folder: "$PROJECT_ROOT/.worktrees/$NAME",
};

export const revision: Revision = {
  id: "3bc5f3ca7f53",
  parent: "d495e64414cb",
  description: "Move settings and shortcuts to config.json",
  up(value) {
    const { viewer, config } = value as ViewerFiles;
    // A config.json already there, such as one restored from dotfiles, wins.
    if (config !== null) return value;
    const chosen: Record<string, unknown> = {};
    for (const key of settings)
      if (key in viewer && JSON.stringify(viewer[key]) !== JSON.stringify(defaults[key])) chosen[key] = viewer[key];
    // viewer.json keeps them too: builds before this revision read them there.
    return { viewer, config: Object.keys(chosen).length ? chosen : null };
  },
  // Nothing left viewer.json.
  down: value => value,
};
