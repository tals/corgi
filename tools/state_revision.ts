import { join } from "node:path";
import * as state_revision from "../scripts/state_revision";

const args = process.argv.slice(2),
  description = args.shift();
let kind: "state" | "workspaces" = "state";
const usage = (): never => {
  console.error('Usage: bun tools/state_revision.ts "Describe the saved-state change" [--workspaces]');
  process.exit(1);
};
if (!description) usage();
while (args.length) {
  switch (args.shift()) {
    case "--workspaces":
      if (kind !== "state") usage();
      kind = "workspaces";
      break;
    default:
      usage();
  }
}
const next = await state_revision.create(join(import.meta.dir, ".."), description!, kind);
console.log(`Created src/persist/revisions/${next.name}.ts`);
console.log(
  kind === "state"
    ? "The generated steps discard auxiliary state. Edit up/down to retain it, then run bun format.ts and bun test src/persist."
    : "Edit up/down for the workspace change, then run bun format.ts and bun test src/persist src/workspace.test.ts.",
);
