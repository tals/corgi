import { createInterface } from "node:readline";
import { AsyncLocalStorage } from "node:async_hooks";
import { pathToFileURL } from "node:url";
import * as tricks from "./tricks";
import * as style from "./trick_style";
import * as markup from "./trick_markup";
import * as elements from "./trick_elements";
import * as trickPalette from "./trick_palette";

export interface Drawing {
  kind: "overlay";
  anchor?: tricks.Overlay["anchor"];
  text?: string;
  content?: elements.Content;
  color?: tricks.Color;
}
export type Ui = typeof elements.ui & {
  color(value: tricks.Color): void;
  marker(value: tricks.Color): void;
  append(content: elements.Content): void;
};
export interface UiContext {
  event: tricks.UiEvent;
  agent: tricks.Agent;
  previous: tricks.Agent | null;
  ui: Ui;
}
export interface Corgi {
  readonly palette: typeof style.palette & { map: ReturnType<typeof trickPalette.maps> };
  readonly brand: typeof style.brand;
  readonly ui: typeof elements.ui;
  escape(text: string): string;
  draw(key: string, view: Drawing): void;
  clear(key: string): void;
  refresh(): void;
  focus(agent: tricks.Agent | string): Promise<void>;
  get<T>(key: string, fallback: T): Promise<T>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}
type Selected<P extends tricks.EventPattern> = Extract<
  tricks.Event,
  { event: P extends "metadata:*" ? (typeof tricks.metadata_events)[number] : P }
>;
export type Handler<E = tricks.Event> = (event: E) => void | Promise<void>;
export interface On {
  (event: tricks.UiEvent, handler: Handler<UiContext>): void;
  <P extends tricks.EventPattern>(events: P | P[], handler: Handler<Selected<P>>): void;
  (handler: Handler<Selected<"metadata:*">>): void;
}
export interface Trick {
  register(on: On, corgi: Corgi): void | Promise<void>;
}
type Message =
  | tricks.Event
  | { event: "ready" }
  | { event: "ui.refresh" }
  | { event: "palette.changed"; name: string; state: trickPalette.State }
  | { event: "ui.press"; action: string; viewer: number }
  | { id: string | null; error?: string; result?: unknown };
/** This pipe has one writer: the daemon running the same protocol. */
function message(line: string): Message {
  const value = tricks.object(JSON.parse(line));
  if (value.event === "palette.changed")
    return { event: "palette.changed", name: trickPalette.name(value.name), state: trickPalette.read(value.state) };
  if (value.event === "ui.refresh") return { event: "ui.refresh" };
  if (value.event === "ui.press") {
    if (!Number.isSafeInteger(value.viewer) || Number(value.viewer) < 1) throw Error("InvalidViewer");
    return { event: "ui.press", action: tricks.key(value.action), viewer: Number(value.viewer) };
  }
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
  private patches = new Map<string, { agent?: string; json: string; actions: string[] }>();
  private callbacks = new Map<string, elements.Press>();
  private agents = new Map<string, tricks.Agent>();
  private interaction = new AsyncLocalStorage<{ viewer: number; active: boolean }>();
  private refreshing = false;
  private ui_handlers = new Map<tricks.Surface, Handler<UiContext>[]>();
  private handlers: { events: tricks.EventName[]; run: Handler }[] = [];
  private on: On;
  readonly corgi: Corgi;
  private palettes: ReturnType<typeof trickPalette.maps>;
  constructor(
    private trick: Trick,
    private send: (value: object) => void,
    private fail: (error: Error) => void,
  ) {
    this.on = ((
      events: tricks.EventPattern | tricks.UiEvent | tricks.EventPattern[] | Handler,
      handler?: Handler | Handler<UiContext>,
    ) => {
      if (this.stopped) throw Error("TrickStopped");
      if (this.started) throw Error("RegistrationClosed");
      if (this.handlers.length + [...this.ui_handlers.values()].reduce((n, h) => n + h.length, 0) >= 256)
        throw Error("TooManyHandlers");
      const run = typeof events === "function" ? events : handler;
      if (typeof run !== "function") throw Error("ExpectedHandler");
      const surface = tricks.surface(events);
      if (surface) {
        const handlers = this.ui_handlers.get(surface) ?? [];
        handlers.push(run as Handler<UiContext>);
        this.ui_handlers.set(surface, handlers);
        return;
      }
      const subscription = tricks.subscription({ events: typeof events === "function" ? "metadata:*" : events });
      this.handlers.push({ events: subscription.events, run: run as Handler });
    }) as On;
    const key = (value: string) => {
      if (value.startsWith("ui-")) throw Error("ReservedKey");
      return tricks.key(value);
    };
    this.palettes = trickPalette.maps(command => this.call(command));
    this.corgi = {
      palette: Object.freeze({
        ...style.palette,
        map: this.palettes,
      }),
      brand: style.brand,
      ui: elements.ui,
      escape: markup.escape,
      draw: (name, view) => {
        if (view.content !== undefined) {
          if (view.text !== undefined) throw Error("AmbiguousDrawing");
          const encoded = elements.encode(view.content, tricks.color(view.color));
          this.save(
            key(name),
            tricks.view({ kind: view.kind, anchor: view.anchor, content: encoded.content }),
            encoded.callbacks,
          );
          return;
        }
        if (typeof view.text !== "string" || view.text.length > 6144) throw Error("InvalidString");
        const color = tricks.color(view.color);
        const lines = view.text.split("\n");
        if (lines.length > 12) throw Error("InvalidLines");
        this.save(
          key(name),
          tricks.view({
            kind: view.kind,
            anchor: view.anchor,
            lines: lines.map(line => markup.parse(line).map(span => ({ ...span, color: span.color ?? color }))),
          }),
          [],
        );
      },
      clear: name => this.remove(key(name)),
      refresh: () => {
        if (this.stopped) throw Error("TrickStopped");
        if (this.refreshing) return;
        this.refreshing = true;
        this.receive(JSON.stringify({ event: "ui.refresh" }));
      },
      focus: async agent => {
        const interaction = this.interaction.getStore();
        if (!interaction?.active) throw Error("NoInteraction");
        await this.call({
          op: "ui.focus",
          viewer: interaction.viewer,
          agent: tricks.agentId(typeof agent === "string" ? agent : agent.id),
        });
      },
      get: async <T>(key: string, fallback: T) => ((await this.call({ op: "kv.get", key })) as T) ?? fallback,
      set: async (key, value) => {
        await this.call({ op: "kv.set", key, value });
      },
      delete: async key => {
        await this.call({ op: "kv.delete", key });
      },
    };
  }
  private remove(key: string) {
    const old = this.patches.get(key);
    for (const action of old?.actions ?? []) this.callbacks.delete(action);
    this.patches.delete(key);
    this.write({ op: "ui.remove", key });
  }
  private save(key: string, view: tricks.View, callbacks: elements.Press[], agent?: string) {
    const old = this.patches.get(key),
      json = JSON.stringify(view);
    if (old?.json === json) {
      old.actions.forEach((action, index) => this.callbacks.set(action, callbacks[index]));
      return;
    }
    if (!old && this.patches.size >= tricks.max_views) throw Error("TooManyViews");
    const actions = callbacks.map(() => String(++this.next));
    const drawing = view.content
      ? {
          ...view,
          content: tricks.mapActions(
            view.content,
            action => actions[Number(action)],
            slot => `${key}.${slot}`,
          ),
        }
      : view;
    this.write({ op: "ui.set", key, view: drawing });
    for (const action of old?.actions ?? []) this.callbacks.delete(action);
    actions.forEach((action, index) => this.callbacks.set(action, callbacks[index]));
    this.patches.set(key, { agent, json, actions });
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
    const events = [...new Set(this.handlers.flatMap(h => h.events))];
    if (this.ui_handlers.size && !events.includes("agent.changed")) events.push("agent.changed");
    if (events.length) if (!events.includes("agent.removed")) events.push("agent.removed");
    this.write({ op: "subscribe", events });
  }
  private async draw(agent: tricks.Agent, previous: tricks.Agent | null) {
    for (const [surface, handlers] of this.ui_handlers) {
      const key = `ui-${surface}-${agent.id.replaceAll(":", "-")}`;
      const patch: tricks.Decoration = { kind: "decorate", surface, where: { id: agent.id }, suffix: [] };
      const parts: elements.Content[] = [];
      let active = true;
      const check = () => {
        if (!active) throw Error("DrawingClosed");
        if (this.stopped) throw Error("TrickStopped");
      };
      const ui: Ui = {
        ...elements.ui,
        color: value => {
          check();
          patch.color = tricks.color(value);
        },
        marker: value => {
          check();
          patch.marker = tricks.color(value);
        },
        append: content => {
          check();
          if (parts.length >= tricks.max_nodes) throw Error("DrawingTooLarge");
          parts.push(content);
          if (typeof content !== "string") return;
          const spans = markup.parse(content);
          if (!spans.length) return;
          if (patch.suffix.length) patch.suffix.push({ text: " " });
          patch.suffix.push(...spans);
          if (patch.suffix.length > 16) throw Error("InvalidSpans");
        },
      };
      try {
        for (const handler of handlers) await handler({ event: `ui:agent.${surface}`, agent, previous, ui });
      } finally {
        active = false;
      }
      const old = this.patches.get(key);
      let callbacks: elements.Press[] = [];
      if (parts.some(part => typeof part !== "string")) {
        const encoded = elements.encode(elements.ui.row(...parts));
        patch.content = encoded.content;
        patch.suffix = [];
        callbacks = encoded.callbacks;
      }
      if (!patch.color && !patch.marker && !patch.suffix.length && !patch.content) {
        if (old) this.remove(key);
        continue;
      }
      this.save(key, patch, callbacks, agent.id);
    }
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
              await this.trick.register(this.on, this.corgi);
              this.started = true;
              this.subscribe();
            } else if (value.event === "palette.changed") {
              this.palettes.update(value.name, value.state);
              for (const agent of this.agents.values()) await this.draw(agent, agent);
            } else if (value.event === "ui.refresh") {
              this.refreshing = false;
              for (const agent of this.agents.values()) await this.draw(agent, agent);
            } else if (value.event === "ui.press") {
              const callback = this.callbacks.get(value.action);
              if (!callback) return;
              const interaction = { viewer: value.viewer, active: true };
              try {
                await this.interaction.run(interaction, callback);
              } finally {
                interaction.active = false;
              }
              for (const agent of this.agents.values()) await this.draw(agent, agent);
            } else {
              if (!this.started) throw Error("NotStarted");
              for (const handler of this.handlers) if (handler.events.includes(value.event)) await handler.run(value);
              if (value.event === "agent.changed" && this.ui_handlers.size) {
                this.agents.set(value.agent.id, value.agent);
                await this.draw(value.agent, value.previous);
              }
              if (value.event === "agent.removed") {
                this.agents.delete(value.agent.id);
                for (const [key, patch] of this.patches)
                  if (patch.agent === value.agent.id) {
                    this.remove(key);
                  }
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
    this.patches.clear();
    this.callbacks.clear();
    this.agents.clear();
    this.fail(error);
  }
}
export async function run(entry: string): Promise<void> {
  // stdout is the protocol; a sketch's ordinary logging belongs on stderr.
  console.log = console.error;
  const module: Trick = await import(pathToFileURL(entry).href);
  if (typeof module.register !== "function") throw Error("ExpectedRegister");
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
