import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import * as tricks from "./tricks";

export type Paint = Partial<Pick<tricks.Decoration, "marker" | "color" | "suffix">>;
export type Drawing =
  | (Omit<tricks.Overlay, "anchor"> & { anchor?: tricks.Overlay["anchor"] })
  | (Paint & { kind: "decorate"; where?: tricks.Selector });
export interface Corgi {
  subscribe(events: tricks.EventPattern | tricks.EventPattern[], where?: tricks.Selector): void;
  paint(agent: tricks.Agent, style: Paint | null): void;
  draw(key: string, view: Drawing): void;
  clear(key: string): void;
  get<T>(key: string, fallback: T): Promise<T>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}
export interface Sketch {
  setup?(corgi: Corgi): void | Promise<void>;
  loop?(corgi: Corgi, event: tricks.Event): void | Promise<void>;
}
type Message = tricks.Event | { event: "ready" } | { id: string | null; error?: string; result?: unknown };
/** This pipe has one writer: the daemon running the same protocol. */
function message(line: string): Message {
  const value = tricks.object(JSON.parse(line));
  if (value.event === "ready") {
    if (value.version !== tricks.version) throw Error("UnsupportedTrickVersion");
    return { event: "ready" };
  }
  if (tricks.events.some(event => value.event === event)) return value as unknown as tricks.Event;
  if (value.id !== null && typeof value.id !== "string") throw Error("InvalidReply");
  if (value.error !== undefined && typeof value.error !== "string") throw Error("InvalidReply");
  return { id: value.id, error: value.error, result: value.result };
}
export class Runner {
  private next = 0n;
  private pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  private jobs: Promise<void> = Promise.resolve();
  private queued = 0;
  private queued_events = 0;
  private started = false;
  private ready = false;
  private stopped = false;
  private painted = new Map<string, string>();
  private subscription: tricks.Subscription;
  readonly corgi: Corgi;
  constructor(
    private sketch: Sketch,
    private send: (value: object) => void,
    private fail: (error: Error) => void,
  ) {
    this.subscription = tricks.subscription({ events: sketch.loop ? "metadata:*" : [] });
    const clear = (key: string) => this.write({ op: "ui.remove", key });
    this.corgi = {
      subscribe: (events, where = {}) => {
        this.subscription = tricks.subscription({ events, where });
        for (const key of this.painted.values()) clear(key);
        this.painted.clear();
        if (this.started) this.subscribe();
      },
      paint: (agent, style) => {
        const key = "agent-" + agent.id.replaceAll(":", "-");
        if (style === null) {
          clear(key);
          this.painted.delete(agent.id);
        } else {
          this.corgi.draw(key, { ...style, kind: "decorate", where: { id: agent.id } });
          this.painted.set(agent.id, key);
        }
      },
      draw: (key, view) => this.write({ op: "ui.set", key, view: tricks.view(view) }),
      clear,
      get: async <T>(key: string, fallback: T) => ((await this.call({ op: "kv.get", key })) as T) ?? fallback,
      set: async (key, value) => {
        await this.call({ op: "kv.set", key, value });
      },
      delete: async key => {
        await this.call({ op: "kv.delete", key });
      },
    };
  }
  private write(value: object) {
    if (this.stopped) throw Error("TrickStopped");
    this.send(value);
  }
  private call(value: object): Promise<unknown> {
    const id = String(++this.next);
    return new Promise((resolve, reject) => {
      if (this.pending.size >= 256) {
        reject(Error("TooManyRequests"));
        return;
      }
      this.pending.set(id, { resolve, reject });
      try {
        this.write({ ...value, id });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  private subscribe() {
    const events = [...this.subscription.events];
    if (events.length)
      for (const event of ["agent.changed", "agent.removed"] as const) if (!events.includes(event)) events.push(event);
    this.write({ op: "subscribe", events, where: this.subscription.where });
  }
  receive(line: string) {
    if (this.stopped) return;
    try {
      const value = message(line);
      if (!("event" in value)) {
        if (value.id === null) {
          if (value.error) throw Error(value.error);
          return;
        }
        const pending = this.pending.get(value.id);
        this.pending.delete(value.id);
        if (value.error) pending?.reject(Error(value.error));
        else pending?.resolve(value.result);
        return;
      }
      // Replies bypass this queue so an async hook can await a durable write.
      this.queued += Buffer.byteLength(line);
      if (++this.queued_events > 256 || this.queued > 1024 * 1024) throw Error("SlowConsumer");
      this.jobs = this.jobs
        .then(async () => {
          if (this.stopped) return;
          const timeout = setTimeout(() => this.close(Error("HandlerTimeout")), 5000);
          try {
            if (value.event === "ready") {
              if (this.ready) throw Error("AlreadyStarted");
              this.ready = true;
              await this.sketch.setup?.(this.corgi);
              this.started = true;
              this.subscribe();
            } else {
              if (!this.started) throw Error("NotStarted");
              if (this.subscription.events.includes(value.event)) await this.sketch.loop?.(this.corgi, value);
              if (
                value.event === "agent.removed" ||
                (value.event === "agent.changed" && !tricks.matches(this.subscription.where, value.agent))
              ) {
                const key = this.painted.get(value.agent.id);
                if (key) this.corgi.clear(key);
                this.painted.delete(value.agent.id);
              }
            }
          } finally {
            clearTimeout(timeout);
          }
        })
        .catch(error => this.close(error))
        .finally(() => {
          this.queued -= Buffer.byteLength(line);
          this.queued_events--;
        });
    } catch (error) {
      this.close(error instanceof Error ? error : Error(String(error)));
    }
  }
  close(error = Error("TrickDisconnected")) {
    if (this.stopped) return;
    this.stopped = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.fail(error);
  }
}
export async function run(entry: string): Promise<void> {
  // stdout is the protocol; a sketch's ordinary logging belongs on stderr.
  console.log = console.error;
  const module: Sketch = await import(pathToFileURL(entry).href);
  if (
    (module.setup !== undefined && typeof module.setup !== "function") ||
    (module.loop !== undefined && typeof module.loop !== "function") ||
    (!module.setup && !module.loop)
  )
    throw Error("ExpectedSetupOrLoop");
  await new Promise<void>((_resolve, reject) => {
    const input = createInterface({ input: process.stdin });
    const runner = new Runner(
      module,
      value => {
        const line = JSON.stringify(value) + "\n";
        if (Buffer.byteLength(line) > tricks.max_bytes || process.stdout.writableLength > 1024 * 1024)
          throw Error("OutputLimit");
        process.stdout.write(line);
      },
      error => {
        input.close();
        reject(error);
      },
    );
    input.on("line", line => runner.receive(line));
    input.on("close", () => runner.close());
    process.stdout.on("error", error => runner.close(error));
  });
}
