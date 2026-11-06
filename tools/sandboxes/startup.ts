/** An intentionally slow OpenCode startup, with visible progress and cancellation. */
import { join } from "node:path";
import { table, type World } from "../sandbox";

export const world: World = {
  seed(s) {
    s.write(
      join(s.home, "bin/opencode2"),
      `#!/bin/sh
case "$1" in
  --version) echo 'opencode v2.1.2';;
  api)
    for part in $(seq 1 120); do
      echo "mise opencode@2.1.2 downloading package: $part / 120" >&2
      sleep 1
    done
    exit 1;;
esac
`,
    );
    s.run(["chmod", "+x", join(s.home, "bin/opencode2")]);
  },
  arrange(s) {
    const workspace = s.corgi(["workspace", "new", "Startup", "--cwd", s.dir]);
    s.corgi([
      "tab",
      "new",
      "--workspace",
      String(workspace.workspace),
      "--name",
      "Slow startup",
      "--command",
      `CORGI_OPENCODE2_BIN='${join(s.home, "bin/opencode2")}' '${s.exe}' agent opencode2`,
    ]);
  },
  intro() {
    return [
      "OpenCode is waiting on a simulated two-minute installation.",
      ...table([
        ["waiting", "click the bottom-right count for live status"],
        ["x", "kill the selected startup from its panel"],
        ["Enter", "show the waiting pane"],
      ]),
    ];
  },
};
