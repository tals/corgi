import { readFileSync } from "node:fs";
import { join } from "node:path";
import { world as accounts } from "./accounts";
import { table, type World } from "../sandbox";

export const world: World = {
  seed(s) {
    accounts.seed(s);
    for (const name of ["account-colors", "provider-flair", "attention-radar", "completion-jar"])
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
      "Four Corgi Tricks: green personal and blue company rails, provider flourishes, attention radar and a persistent completion jar.",
      ...table([
        ["block", "type in a fake agent: its name appears in the attention overlay"],
        ["work, stop", "type each in turn: add a star to the completion jar"],
        ["shell", "corgi tricks list; corgi tricks reload keeps the jar's count"],
        ["config", join(s.home, ".config/corgi/tricks")],
      ]),
    ];
  },
};
