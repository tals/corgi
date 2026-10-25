import { field, number } from "../providers/common";
export { field };
export const max = (1n << 64n) - 1n;
export const add = (a: bigint, b: bigint) => (a + b > max ? max : a + b);
export const sub = (a: bigint, b: bigint) => (a > b ? a - b : 0n);
export { number };
export class Counts {
  turns = 0n;
  tools = 0n;
  input = 0n;
  cached_input = 0n;
  output = 0n;
  tokens_known = false;
  constructor(v: Partial<Counts> = {}) {
    Object.assign(this, v);
  }
  add(other: Counts) {
    this.turns = add(this.turns, other.turns);
    this.tools = add(this.tools, other.tools);
    this.input = add(this.input, other.input);
    this.cached_input = add(this.cached_input, other.cached_input);
    this.output = add(this.output, other.output);
    this.tokens_known ||= other.tokens_known;
  }
  any() {
    return this.turns > 0n || this.tools > 0n || this.input > 0n || this.output > 0n;
  }
}
export class Window {
  since = 0;
  counts = new Counts();
  visit(now: number) {
    const changed = this.counts.any();
    this.since = Math.max(this.since, now);
    this.counts = new Counts();
    return changed;
  }
  record(since: number, delta: Counts) {
    if (since !== this.since) return false;
    const changed = delta.any() || (delta.tokens_known && !this.counts.tokens_known);
    this.counts.add(delta);
    return changed;
  }
}
export class Tracker {
  samples = Array.from({ length: 128 }, () => ({
    id: 0n,
    input: 0n,
    cached_input: 0n,
    output: 0n,
  }));
  tools = Array<bigint>(256).fill(0n);
  responses = Array<bigint>(128).fill(0n);
  next_response = 0;
  next_sample = 0;
  next_tool = 0;
  static key(id: string) {
    return Bun.hash.wyhash(id, 0n) | 1n;
  }
  static restore(value: any) {
    const tracker = new Tracker();
    if (!value) return tracker;
    if (
      !Array.isArray(value.samples) ||
      value.samples.length !== 128 ||
      !Array.isArray(value.tools) ||
      value.tools.length !== 256 ||
      value.next_sample >= 128 ||
      value.next_tool >= 256
    )
      throw Error("InvalidCheckpoint");
    tracker.samples = value.samples.map((sample: any) => ({
      id: BigInt(sample.id),
      input: BigInt(sample.input),
      cached_input: BigInt(sample.cached_input),
      output: BigInt(sample.output),
    }));
    tracker.tools = value.tools.map(BigInt);
    tracker.next_sample = value.next_sample;
    tracker.next_tool = value.next_tool;
    if (value.responses !== undefined) {
      if (
        !Array.isArray(value.responses) ||
        value.responses.length !== 128 ||
        !Number.isInteger(value.next_response) ||
        value.next_response < 0 ||
        value.next_response >= 128
      )
        throw Error("InvalidCheckpoint");
      tracker.responses = value.responses.map(BigInt);
      tracker.next_response = value.next_response;
    }
    return tracker;
  }
  response(id: string) {
    const hash = Tracker.key(id);
    if (!id || this.responses.includes(hash)) return 0n;
    this.responses[this.next_response] = hash;
    this.next_response = (this.next_response + 1) % 128;
    return 1n;
  }
  tool(id: string) {
    const hash = Tracker.key(id);
    if (!id || this.tools.includes(hash)) return 0n;
    this.tools[this.next_tool] = hash;
    this.next_tool = (this.next_tool + 1) % 256;
    return 1n;
  }
  tokens(id: string, input: bigint, output: bigint, baseline: boolean) {
    return this.tokensCached(id, input, 0n, output, baseline);
  }
  tokensCached(id: string, input: bigint, cached: bigint, output: bigint, baseline: boolean) {
    const hash = Tracker.key(id);
    const old = this.samples.find(sample => sample.id === hash);
    if (old) {
      const delta = new Counts({
        input: sub(input, old.input),
        cached_input: sub(cached, old.cached_input),
        output: sub(output, old.output),
        tokens_known: true,
      });
      old.input = input > old.input ? input : old.input;
      old.cached_input = cached > old.cached_input ? cached : old.cached_input;
      old.output = output > old.output ? output : old.output;
      return delta;
    }
    this.samples[this.next_sample] = {
      id: hash,
      input,
      cached_input: cached,
      output,
    };
    this.next_sample = (this.next_sample + 1) % 128;
    return new Counts({
      input: baseline ? 0n : input,
      cached_input: baseline ? 0n : cached,
      output: baseline ? 0n : output,
      tokens_known: true,
    });
  }
  hasSample(id: string) {
    return this.samples.some(sample => sample.id === Tracker.key(id));
  }
}
