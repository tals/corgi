import { field, str, timestampMs } from "../providers/common";
import { Codex as ProviderCodex } from "../providers/codex";
import { number, add } from "./tokens";
export class Tokens {
  input = 0n;
  cached_input = 0n;
  output = 0n;
  constructor(v: Partial<Tokens> = {}) {
    Object.assign(this, v);
  }
  total() {
    return add(this.input, this.output);
  }
  add(o: Tokens) {
    this.input = add(this.input, o.input);
    this.cached_input = add(this.cached_input, o.cached_input);
    this.output = add(this.output, o.output);
  }
}
export class View {
  tokens = new Tokens();
  known = false;
  partial = false;
  losses = 0;
  since = 0;
  updated_at = 0;
  recent_tokens = 0n;
  constructor(v: Partial<View> = {}) {
    Object.assign(this, v);
  }
}
export class Meter {
  value = new View();
  buckets = Array.from({ length: 5 }, () => ({ minute: -1, tokens: 0n }));
  lose() {
    this.value.partial = true;
    this.value.losses = Math.min(0xffffffff, this.value.losses + 1);
  }
  add(tokens: Tokens, timestamp: number) {
    this.value.known = true;
    this.value.tokens.add(tokens);
    if (!this.value.since) this.value.since = timestamp;
    this.value.updated_at = Math.max(this.value.updated_at, timestamp);
    const minute = Math.floor(timestamp / 60000),
      index = ((minute % 5) + 5) % 5;
    let slot = this.buckets[index];
    if (slot.minute > minute) return;
    if (slot.minute !== minute)
      slot = this.buckets[index] = { minute, tokens: 0n };
    slot.tokens = add(slot.tokens, tokens.total());
  }
  view(now: number) {
    const out = new View({
        ...this.value,
        tokens: new Tokens(this.value.tokens),
      }),
      minute = Math.floor(now / 60000);
    for (const b of this.buckets)
      if (b.minute >= minute - 4 && b.minute <= minute)
        out.recent_tokens = add(out.recent_tokens, b.tokens);
    return out;
  }
}
const min = (a: bigint, b: bigint) => (a < b ? a : b);
export function parseTokens(v: any, camel: boolean) {
  const input = number(v, camel ? "inputTokens" : "input_tokens"),
    output = number(v, camel ? "outputTokens" : "output_tokens");
  if (input === null || output === null) return null;
  return new Tokens({
    input,
    cached_input: min(
      input,
      number(v, camel ? "cachedInputTokens" : "cached_input_tokens") ?? 0n,
    ),
    output,
  });
}
export class Codex {
  meter = new Meter();
  previous: Tokens | null = null;
  child = false;
  owned_from: bigint | null = null;
  catch_up = false;
  ordinal: bigint | null = null;
  baseline_next = false;
  header(
    value: any,
    child: boolean,
    tracked_since: number,
    complete_prefix: boolean,
  ) {
    this.child = child;
    const r = ProviderCodex.Rollout.decode(value);
    this.owned_from = number(r.payload, "subagent_history_start_ordinal");
    const created =
      timestampMs(str(r.payload, "timestamp")) ?? timestampMs(r.timestamp);
    this.catch_up =
      child &&
      complete_prefix &&
      this.owned_from !== null &&
      created !== null &&
      tracked_since > 0 &&
      created >= tracked_since;
    if (child && (!this.catch_up || this.owned_from === null))
      this.meter.lose();
  }
  ingest(value: any, appended: boolean, now: number) {
    const r = ProviderCodex.Rollout.decode(value);
    if (r.type !== "event_msg" || r.payloadType() !== "token_count") return;
    const ordinal = number(value, "ordinal");
    if (this.owned_from !== null) {
      if (ordinal === null) {
        this.meter.lose();
        return;
      }
      if (ordinal < this.owned_from) return;
    }
    if (ordinal !== null) {
      if (this.ordinal !== null && ordinal <= this.ordinal) return;
      this.ordinal = ordinal;
    }
    const info = field(r.payload, "info"),
      total = parseTokens(field(info, "total_token_usage"), false);
    if (!total) return;
    this.sample(
      total,
      parseTokens(field(info, "last_token_usage"), false),
      appended || this.catch_up,
      Math.min(timestampMs(r.timestamp) ?? now, now),
    );
  }
  native(value: any, active: boolean, now: number) {
    const total = parseTokens(field(value, "total"), true);
    if (total)
      this.sample(total, parseTokens(field(value, "last"), true), active, now);
  }
  sample(total: Tokens, last: Tokens | null, count: boolean, stamp: number) {
    const p = this.previous,
      regressed =
        p &&
        (total.input < p.input ||
          total.output < p.output ||
          total.cached_input < p.cached_input);
    if (!count || this.baseline_next) {
      if (regressed) {
        this.meter.lose();
        return;
      }
      this.previous = total;
      this.baseline_next = false;
      return;
    }
    let delta = new Tokens();
    if (p) {
      if (
        p.input === total.input &&
        p.output === total.output &&
        p.cached_input === total.cached_input
      )
        return;
      if (regressed) {
        this.meter.lose();
        return;
      }
      delta = new Tokens({
        input: total.input - p.input,
        cached_input: total.cached_input - p.cached_input,
        output: total.output - p.output,
      });
      if (last) {
        if (delta.input > last.input || delta.output > last.output)
          this.meter.lose();
        delta.input = min(delta.input, last.input);
        delta.cached_input = min(delta.cached_input, last.cached_input);
        delta.output = min(delta.output, last.output);
      }
    } else if (last)
      delta = new Tokens({
        input: min(total.input, last.input),
        cached_input: min(total.cached_input, last.cached_input),
        output: min(total.output, last.output),
      });
    else {
      this.meter.lose();
      this.previous = total;
      return;
    }
    this.previous = total;
    this.meter.add(delta, stamp);
  }
}
