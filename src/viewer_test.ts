//! Deterministic stdio harness for the actual viewer controller and
//! transport. Only the test build exposes this entry point. Mirrors
//! viewer_test.zig.
import { parse, stringify } from "./json";
import * as viewer from "./viewer";
import { Controller } from "./controller";
import { parse as parseAction } from "./action";
import { advance } from "./clock";
import type { Transport } from "./mirror";

export async function runTest(connection: Transport, cwd = process.cwd()): Promise<void> {
  const view = new Controller(connection);
  const lines = new Lines();
  try {
    const bell = { seq: await viewer.open(view, cwd, {}, connection.socket ?? "") };
    for (let line = await lines.next(); line !== null; line = await lines.next()) {
      const value = parse(line);
      const op = typeof value.op === "string" ? value.op : "";
      if (op === "input") await view.input(Buffer.from(typeof value.data === "string" ? value.data : ""));
      // Viewer-local delays (hover cards, command preview debounce).
      if (op === "advance") advance(Number(value.ms));
      if (op === "action") {
        const act = parseAction(
          typeof value.name === "string" ? value.name : "",
          typeof value.value === "string" ? value.value : "",
        );
        // viewer.sync execs the new binary before perform; the driver cannot.
        if (act.name === "relaunch") throw Error("UnknownAction");
        await view.perform(act);
      }
      if (op === "focus") view.focusPane(typedId(value, "pane"));
      if (op === "workspace") view.switchWorkspace(typedId(value, "workspace"));
      // The stdio driver has no host terminal to negotiate image support.
      if (op === "badge") {
        view.corgi_badge = !value.visible
          ? "none"
          : value.emoji !== undefined
            ? value.emoji
              ? "emoji"
              : "image"
            : "image";
        view.supports_kitty_graphics = view.corgi_badge === "image";
      }
      if (op === "size") {
        view.width = Number(value.cols);
        view.height = Number(value.rows);
        view.input_state.active = true;
      }
      await view.expireInput();
      const previous_bell = bell.seq;
      let active = await viewer.sync(view, bell, false);
      // A layout change from another viewer can change the visible set. A
      // second exchange captures the newly reconciled selection immediately.
      if (active) active = await viewer.sync(view, bell, false);
      const frame = view.frame();
      await viewer.presented(view);
      const model = view.current().model;
      process.stdout.write(
        stringify({
          bell_seq: bell.seq,
          bell_kind: view.last_bell_kind,
          rang: BigInt(bell.seq) !== BigInt(previous_bell),
          data: frame,
          workspace: view.current().id,
          tab: model.count > 0 ? model.tabs[view.layoutView().selection.active].id : 0,
          pane: view.focused()?.id ?? 0,
          prefix: view.prefix,
          dialog: view.name_dialog !== null,
          detached: !active,
          effects: view.effects,
        }) + "\n",
      );
      view.clearEffects();
      if (!active) return;
    }
  } finally {
    viewer.close(view);
    lines.close();
  }
}
function typedId(value: any, field: string): number {
  const id = value[field];
  if (id === undefined) throw Error("MissingTarget");
  if (!Number.isInteger(id) || id <= 0 || id > 0xffffffff) throw Error("InvalidTarget");
  return id;
}
/** Requests from stdin, one per line. Lines that arrive while a request is
 * being handled wait in order. */
class Lines {
  private buffer = "";
  private ready: string[] = [];
  private ended = false;
  private waiter: (() => void) | null = null;
  private decoder = new TextDecoder();
  private onData = (chunk: Buffer) => {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = this.buffer.indexOf("\n")) >= 0) {
      this.ready.push(this.buffer.slice(0, end).replace(/\r$/, ""));
      this.buffer = this.buffer.slice(end + 1);
    }
    this.wake();
  };
  private onEnd = () => {
    this.ended = true;
    this.wake();
  };
  constructor() {
    process.stdin.on("data", this.onData);
    process.stdin.on("end", this.onEnd);
    process.stdin.on("error", this.onEnd);
    process.stdin.resume();
  }
  private wake() {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.();
  }
  async next(): Promise<string | null> {
    while (this.ready.length === 0 && !this.ended) await new Promise<void>(resolve => (this.waiter = resolve));
    return this.ready.shift() ?? null;
  }
  close() {
    process.stdin.off("data", this.onData);
    process.stdin.off("end", this.onEnd);
    process.stdin.off("error", this.onEnd);
    process.stdin.pause();
  }
}
