import { Model } from "../providers/model";
import { Claude } from "../providers/claude";
import { Codex } from "../providers/codex";
import { field, str, timestampMs } from "../providers/common";
import { number, add, max } from "./tokens";
export class View {
  used = 0n;
  window = 0n;
  compacts_at = 0n;
  at = 0;
  constructor(v: Partial<View> = {}) {
    Object.assign(this, v);
  }
  pressure() {
    if (!this.at || !this.window) return null;
    const limit = this.compacts_at > 0n && this.compacts_at < this.window ? this.compacts_at : this.window;
    return Number(this.used) / Number(limit);
  }
  band() {
    const p = this.pressure();
    return p === null ? null : p < 0.7 ? "calm" : p < 0.85 ? "near" : "high";
  }
  percent() {
    if (!this.window) return 0n;
    const mul = this.used * 100n;
    return add(mul > max ? max : mul, this.window / 2n) / this.window;
  }
}
export class Points {
  entries: Array<{ model: string; tokens: bigint }> = [];
  next = 0;
  learn(model: string, tokens: bigint) {
    if (!model || !tokens) return;
    const old = this.entries.find(e => e.model === model);
    if (old) {
      old.tokens = tokens;
      return;
    }
    if (this.entries.length < 8) this.entries.push({ model, tokens });
    else {
      this.entries[this.next] = { model, tokens };
      this.next = (this.next + 1) % 8;
    }
  }
  get(model: string) {
    return this.entries.find(e => e.model === model)?.tokens ?? 0n;
  }
}
export class Reading {
  used = 0n;
  window = 0n;
  at = 0;
  model = new Model();
  auto_compaction = 0n;
  in_turn = false;
  claude(value: any) {
    const line = Claude.Line.decode(value);
    if (!line) return;
    const turn = line.turn();
    if (turn) this.in_turn = turn === "open";
    const stamp = timestampMs(line.timestamp);
    if (stamp === null) return;
    if (line.type === "assistant") {
      const model = Model.resolve(str(line.message, "model"));
      if (!model.window) return;
      const usage = field(line.message, "usage"),
        input = number(usage, "input_tokens");
      if (input === null) return;
      this.used = add(
        add(input, number(usage, "cache_read_input_tokens") ?? 0n),
        number(usage, "cache_creation_input_tokens") ?? 0n,
      );
      this.window = model.window;
      this.at = stamp;
      this.model = model;
    } else if (line.type === "system" && line.subtype === "compact_boundary") {
      const meta = field(value, "compactMetadata");
      // Claude also compacts an idle session, at any size, before its prompt
      // cache expires; only a compaction inside a turn marks a full window.
      if (str(meta, "trigger") === "auto" && this.in_turn)
        this.auto_compaction = number(meta, "preTokens") ?? this.auto_compaction;
      this.used = number(meta, "postTokens") ?? 0n;
      this.at = stamp;
    }
  }
  codex(value: any) {
    const r = Codex.Rollout.decode(value);
    if (r.type !== "event_msg" || r.payloadType() !== "token_count") return;
    const stamp = timestampMs(r.timestamp),
      info = field(r.payload, "info"),
      window = number(info, "model_context_window"),
      last = field(info, "last_token_usage");
    if (stamp === null || window === null) return;
    let used = number(last, "total_tokens");
    if (used === null) {
      const input = number(last, "input_tokens");
      if (input === null) return;
      used = add(input, number(last, "output_tokens") ?? 0n);
    }
    this.used = used;
    this.window = window;
    this.at = stamp;
  }
  view(points: Points) {
    return new View({
      used: this.used,
      window: this.window,
      at: this.at,
      compacts_at: this.auto_compaction || points.get(this.model.id.text()),
    });
  }
}
