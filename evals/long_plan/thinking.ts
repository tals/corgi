import { Stdio } from "../../src/providers/stdio";
import * as effort from "../../src/providers/effort";

export const brief =
  "For this bookkeeping task, minimize deliberation. Reuse the accepted state, check only what the new evidence changes, and submit the smallest correct operation list. Avoid re-deriving unchanged history. Keep every evidence, failure-history, constraint and foreground rule above.";

/** Eval-only override of the summary process's fixed low effort. */
export class Thinking {
  original = Stdio.spawn;
  launches: { model: string; effort: effort.Effort }[] = [];
  constructor(readonly level: effort.Effort) {
    const experiment = this;
    Stdio.spawn = function (command, options) {
      if (!command.includes("--effort") || !command.includes("--system-prompt"))
        throw Error("UnexpectedInferenceLaunch");
      experiment.launches.push({ model: command[command.indexOf("--model") + 1], effort: level });
      return experiment.original.call(this, effort.apply("--effort", command, level), options);
    };
  }
  close() {
    Stdio.spawn = this.original;
  }
}
