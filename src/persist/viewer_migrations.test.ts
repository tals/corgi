import { expect, test } from "bun:test";
import * as state_formats from "./state_formats";
import type { ViewerFiles } from "./revision_values";

const history = state_formats.viewer,
  copied = "3bc5f3ca7f53";

test.each([copied, "d495e64414cb", "67a3f5d4cd43"])(
  "viewer migration restores settings only when downgrading to %s",
  target => {
    const state = { onboarding_complete: true, sidebar_width: 40, future_state: 1 },
      settings = {
        preset: "tmux",
        prefix: "ctrl_a",
        language: "ja",
        theme: "animal_style",
        corgi_intensity: 75,
        resources: { enabled: false },
        keys: { worktrees: "ctrl+alt+g", new: [] },
        worktree_folder: "$PROJECT_ROOT/.worktrees/$NAME",
      },
      config = { ...settings, future_config: 1 },
      original = { viewer: { ...state, ...settings, theme: "corgi" }, config };
    const up = history.up(original, copied) as ViewerFiles;
    expect(up).toEqual({ viewer: state, config });
    expect(original.viewer.theme).toBe("corgi");
    const down = history.down(up, target) as ViewerFiles;
    expect(down.config).toEqual(config);
    expect(down.viewer).toEqual({
      ...state,
      ...settings,
      keys: { "worktrees:0": "ctrl+alt+g", new: [] },
    });
    expect(history.up(down, target)).toEqual(up);
  },
);

test("an absent config does not revive copied settings", () => {
  const state = { onboarding_complete: true },
    up = history.up({ viewer: { ...state, theme: "animal_style" }, config: null }, copied);
  expect(up).toEqual({ viewer: state, config: null });
  expect(history.down(up, copied)).toEqual(up);
});
