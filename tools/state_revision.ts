import { join } from "node:path";
import * as state_revision from "../scripts/state_revision";

const args = process.argv.slice(2),
  description = args.shift();
let kind: state_revision.Open = "state";
const usage = (): never => {
  console.error('Usage: bun tools/state_revision.ts "Describe the saved-state change" [--workspaces | --viewer]');
  process.exit(1);
};
if (!description) usage();
while (args.length) {
  const flag = args.shift();
  switch (flag) {
    case "--workspaces":
    case "--viewer":
      if (kind !== "state") usage();
      kind = flag === "--viewer" ? "viewer" : "workspaces";
      break;
    default:
      usage();
  }
}
const next = await state_revision.create(join(import.meta.dir, ".."), description!, kind);
console.log(`Created src/persist/revisions/${next.name}.ts`);
console.log(
  {
    state:
      "The generated steps discard auxiliary state. Edit up/down to retain it, then run bun format.ts and bun test src/persist.",
    workspaces:
      "Edit up/down for the workspace change, then run bun format.ts and bun test src/persist src/workspace.test.ts.",
    viewer:
      "Edit up/down for the viewer.json and config.json change, then run bun format.ts and bun test src/persist src/preferences.test.ts.",
  }[kind],
);
