import { readFileSync } from "node:fs";
import { join } from "node:path";
import { world as accounts } from "./accounts";
import { table, type World } from "../sandbox";

export const world: World = {
  seed(s) {
    accounts.seed(s);
    for (const name of ["account-colors", "account-palette", "provider-flair", "attention-radar", "completion-jar"])
      for (const file of ["trick.toml", "main.mjs"])
        s.write(
          join(s.home, ".config/corgi/tricks", name, file),
          readFileSync(join(s.root, `examples/tricks/${name}/${file}`), "utf8"),
        );
  },
  arrange(s) {
    accounts.arrange(s);
  },
  intro(s) {
    return [
      "Five Corgi Tricks: account colors, a saved color picker in agent cards, provider flourishes, clickable waiting agents and a resettable completion jar.",
      ...table([
        ["block", "type in a fake agent: its name appears in the attention overlay"],
        ["work, stop", "type each in turn: add a star to the completion jar"],
        ["hover agent", "choose a color for its account in the popover card"],
        ["prefix U", "focus trick buttons; Tab / Shift-Tab, Enter, Esc"],
        ["shell", "corgi tricks list; corgi tricks reload keeps the jar's count"],
        ["config", join(s.home, ".config/corgi/tricks")],
      ]),
    ];
  },
};
