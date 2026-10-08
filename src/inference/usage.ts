import { Meter, Tokens, View } from "../usage/live";
import { number, add, sub } from "../usage/tokens";
import { field, str } from "../providers/common";
export class System {
  meter = new Meter();
  reports = 0n;
  constructor() {
    this.meter.value.known = true;
  }
  markPartial(reason: string) {
    this.meter.value.partial = true;
  }
}
export class Tracker {
  threads = new Map<string, Tokens>();
  deinit() {
    this.threads.clear();
  }
  begin(id: string) {
    if (!this.threads.has(id)) this.threads.set(id, new Tokens());
  }
  ingest(value: any, system: System, now: number) {
    if (str(value, "method") === "thread/tokenUsage/updated") {
      const params = field(value, "params");
      const previous = this.threads.get(str(params, "threadId"));
      if (!previous) return;
      const total = field(field(params, "tokenUsage"), "total");
      const input = number(total, "inputTokens"),
        output = number(total, "outputTokens");
      if (input === null || output === null) return;
      const current = new Tokens({
        input,
        output,
        cached_input: number(total, "cachedInputTokens") ?? 0n,
      });
      const delta = new Tokens();
      for (const key of ["input", "cached_input", "output"] as const) {
        delta[key] = sub(current[key], previous[key]);
        if (current[key] < previous[key])
          system.markPartial("counter regression");
        previous[key] =
          current[key] > previous[key] ? current[key] : previous[key];
      }
      system.meter.add(delta, now);
      system.reports = add(system.reports, 1n);
    } else if (str(value, "type") === "result") {
      const usage = field(value, "usage");
      const input = number(usage, "input_tokens"),
        output = number(usage, "output_tokens");
      if (input === null || output === null) return;
      const cached = number(usage, "cache_read_input_tokens") ?? 0n;
      const created = number(usage, "cache_creation_input_tokens") ?? 0n;
      system.meter.add(
        new Tokens({
          input: add(add(input, cached), created),
          cached_input: cached,
          output,
        }),
        now,
      );
      system.reports = add(system.reports, 1n);
    }
  }
}
