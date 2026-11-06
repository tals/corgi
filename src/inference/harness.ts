import { hydrate } from "../persist/checkpoint";
import { Provider, adapter } from "../providers";
import type { Client, Event, Inference } from "../providers/adapter";
import { parse } from "../json";
import { Tokens } from "../usage/live";
import { sub } from "../usage/tokens";
import * as discovery from "../discovery";
import { cancelled, type Stopping } from "../stopping";
import { System, Tracker } from "./usage";
export { Provider };
export type { Stopping };
export type Choice = "auto" | Provider | "off";
export const Choice = {
  provider: (choice: Choice): Provider | null => Provider.parse(choice),
};
export type Config = {
  provider: Provider;
  model: string | null;
  account: string;
  executable: string | null;
  disabled: boolean;
  timeout_ms: number;
};
export type Request = {
  instructions: string;
  content: string;
  conversation?: string | null;
  schema?: string | null;
  fresh_content?: string | null;
};
export class Response {
  value = "";
  fresh = false;
  usage = new Tokens();
  get len() {
    return Buffer.byteLength(this.value);
  }
  text() {
    return this.value;
  }
  set(value: string) {
    if (Buffer.byteLength(value) > 8192) throw Error("OutputTooLarge");
    if (value.includes("�")) throw Error("InvalidOutput");
    this.value = value;
  }
}
let harnesses = 0;
const capacity = 4;
/** Every pool's connections together: the summaries' four, worktree
 * briefs' four, and two still opening. */
const max_harnesses = 10;
/** A summary conversation and the tool-less client it runs in. */
export class Slot {
  turns = 0;
  used = 0n;
  tracker = new Tracker();
  closed = false;
  key: string | null;
  instructions: string;
  schema: string | null;
  constructor(
    public client: Client,
    request: Request,
  ) {
    this.key = request.conversation ?? null;
    this.instructions = request.instructions;
    this.schema = request.schema ?? null;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.client.close();
    harnesses--;
    this.tracker.clear();
  }
}
function inference(r: Request, model: string | null): Inference {
  return { instructions: r.instructions, model, schema: r.schema ?? null };
}
export class Pool {
  config: Config;
  slots: Array<Slot | null>;
  clock = 0n;
  started = false;
  working = false;
  system_usage = new System();
  private opening = new Set<Slot>();
  private generation = 0;
  /** `size` is how many conversations the pool keeps open at once. */
  constructor(options: { config?: Partial<Config>; size?: number } = {}) {
    this.slots = Array(options.size ?? capacity).fill(null);
    this.config = {
      provider: Provider.all[0],
      model: null,
      account: "",
      executable: null,
      disabled: false,
      timeout_ms: 45000,
      ...options.config,
    };
  }
  capture() {
    if (this.working) throw Error("InferenceBusy");
    return {
      config: this.config,
      clock: this.clock,
      started: this.started,
      system_usage: this.system_usage,
      slots: this.slots.map(slot =>
        slot
          ? {
              client: slot.client.save(true),
              key: slot.key,
              instructions: slot.instructions,
              schema: slot.schema,
              turns: slot.turns,
              used: slot.used,
              usage: [...slot.tracker.threads].map(([thread, tokens]) => ({ thread, tokens })),
            }
          : null,
      ),
    };
  }
  restore(saved: any) {
    if (this.slots.some(Boolean)) throw Error("InferenceBusy");
    this.config = { ...this.config, ...saved.config };
    this.clock = BigInt(saved.clock);
    this.started = saved.started;
    this.system_usage = hydrate(new System(), saved.system_usage);
    const { inference } = adapter(this.config.provider);
    this.slots = saved.slots.map((entry: any) => {
      if (!entry) return null;
      if (!entry.client || entry.usage.length > 32 || entry.turns > 32) throw Error("InvalidCheckpoint");
      if (harnesses >= max_harnesses) throw Error("TooManyHarnesses");
      const slot = new Slot(inference.restore(entry.client, true), {
        instructions: entry.instructions,
        content: "",
        conversation: entry.key,
        schema: entry.schema,
      });
      slot.turns = entry.turns;
      slot.used = BigInt(entry.used);
      for (const usage of entry.usage) slot.tracker.threads.set(usage.thread, hydrate(new Tokens(), usage.tokens));
      harnesses++;
      return slot;
    });
  }
  inherit() {
    for (const slot of this.slots) slot?.client.adopt?.();
  }
  [Symbol.dispose]() {
    this.close();
  }
  close() {
    this.generation++;
    for (const slot of this.opening) slot.close();
    for (const slot of this.slots) slot?.close();
    this.slots.fill(null);
  }
  matches(s: Slot, r: Request) {
    return (
      s.key !== null &&
      r.conversation != null &&
      s.key === r.conversation &&
      s.instructions === r.instructions &&
      s.schema === (r.schema ?? null)
    );
  }
  select(request: Request) {
    const match = this.slots.findIndex(s => s && this.matches(s, request));
    if (match >= 0) return match;
    if (request.conversation == null && adapter(this.config.provider).inference.renew) {
      const anonymous = this.slots.findIndex(s => s && s.key === null);
      if (anonymous >= 0) return anonymous;
    }
    const vacant = this.slots.findIndex(s => s === null);
    if (vacant >= 0) return vacant;
    let oldest = 0;
    for (let i = 1; i < this.slots.length; i++) if (this.slots[i]!.used < this.slots[oldest]!.used) oldest = i;
    return oldest;
  }
  /** Reads `s` until `done` says it's finished, failing on a request, an exit,
   * a timeout or a stop. */
  private async drain(s: Slot, stopping: Stopping | undefined, deadline: number, done: (e: Event) => boolean) {
    for (;;) {
      if (s.closed || cancelled(stopping)) throw Error("Cancelled");
      for (const e of s.client.take()) {
        if (e.kind === "usage") s.tracker.ingest(e, this.system_usage, Date.now());
        else if (e.kind === "request") throw Error("UnexpectedToolRequest");
        else if (e.kind === "ended") throw Error("HarnessExited");
        if (done(e)) return;
      }
      if (Date.now() >= deadline) throw Error("Timeout");
      await s.client.wait(deadline);
    }
  }
  async open(request: Request, stopping?: Stopping, deadline = Date.now() + this.config.timeout_ms) {
    if (cancelled(stopping)) throw Error("Cancelled");
    const generation = this.generation,
      provider = adapter(this.config.provider),
      // Nobody asked for the agent here, so a shim that would install it doesn't start.
      executable = this.config.executable ?? (await discovery.resolve(this.config.provider));
    if (generation !== this.generation || cancelled(stopping)) throw Error("Cancelled");
    if (harnesses >= max_harnesses) throw Error("TooManyHarnesses");
    const slot = new Slot(
      provider.inference.start(inference(request, this.config.model), {
        cwd: "/tmp",
        account: this.config.account,
        executable,
      }),
      request,
    );
    harnesses++;
    this.opening.add(slot);
    try {
      if (!slot.client.ready) await this.drain(slot, stopping, deadline, () => slot.client.ready);
      if (slot.closed || generation !== this.generation || cancelled(stopping)) throw Error("Cancelled");
      return slot;
    } catch (error) {
      slot.close();
      throw error;
    } finally {
      this.opening.delete(slot);
    }
  }
  async infer(request: Request, stopping?: Stopping): Promise<Response> {
    if (this.config.disabled) throw Error("Disabled");
    if (cancelled(stopping)) throw Error("Cancelled");
    const freshLength = Buffer.byteLength(request.fresh_content ?? "");
    if (
      Buffer.byteLength(request.instructions) + Math.max(Buffer.byteLength(request.content), freshLength) >
      512 * 1024
    )
      throw Error("InputTooLarge");
    if (request.schema != null) {
      if (Buffer.byteLength(request.schema) > 32768) throw Error("InputTooLarge");
      const schema = parse(request.schema);
      if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw Error("InvalidSchema");
    }
    if (request.conversation != null && (!request.conversation || Buffer.byteLength(request.conversation) > 512))
      throw Error("InvalidConversation");
    if (this.working) throw Error("InferenceBusy");
    this.working = true;
    const generation = this.generation,
      deadline = Date.now() + this.config.timeout_ms,
      index = this.select(request);
    try {
      let s = this.slots[index];
      if (s && (!this.matches(s, request) || s.turns >= 32)) {
        const { renew } = adapter(this.config.provider).inference;
        if (renew?.(s.client, inference(request, this.config.model))) {
          s.key = request.conversation ?? null;
          s.instructions = request.instructions;
          s.schema = request.schema ?? null;
          s.turns = 0;
        } else {
          s.close();
          s = this.slots[index] = null;
        }
      }
      if (!s) {
        s = await this.open(request, stopping, deadline);
        if (generation !== this.generation || cancelled(stopping)) {
          s.close();
          throw Error("Cancelled");
        }
        this.slots[index] = s;
      }
      s.used = ++this.clock;
      const fresh = s.turns === 0;
      const reports = this.system_usage.reports,
        before = new Tokens(this.system_usage.meter.value.tokens);
      s.client.send({
        kind: "prompt",
        text: fresh && request.fresh_content != null ? request.fresh_content : request.content,
      });
      let answer = "",
        outcome = "";
      await this.drain(s, stopping, deadline, e => {
        if (e.kind === "message") answer = e.text;
        if (e.kind === "turn" && e.phase === "ended") outcome = e.outcome;
        return outcome !== "";
      });
      if (outcome !== "completed") throw Error("InferenceFailed");
      const response = new Response();
      response.set(answer);
      if (!response.len) throw Error("EmptyOutput");
      if (request.schema != null) {
        try {
          parse(response.text());
        } catch {
          throw Error("InvalidOutput");
        }
      }
      if (this.system_usage.reports === reports) this.system_usage.markPartial("turn completed without a usage report");
      const after = this.system_usage.meter.value.tokens;
      for (const key of ["input", "cached_input", "output"] as const)
        response.usage[key] = sub(after[key], before[key]);
      response.fresh = fresh;
      s.turns++;
      this.started = true;
      return response;
    } catch (error) {
      if (generation === this.generation) {
        this.slots[index]?.close();
        this.slots[index] = null;
      }
      this.system_usage.markPartial("inference failed");
      throw error;
    } finally {
      this.working = false;
    }
  }
}
