//! The API worker owns in-flight requests. Its pipes survive daemon handoff
//! just like a provider's stdio client.
import { resolve } from "node:path";
import type { Client, Event, Inference, Input, Place, Saved } from "../adapter";
import { Stdio } from "../stdio";
import { field, str, number } from "../common";
import { API } from "./api";
import { Tokens } from "../../usage/live";
export class OpenCode2 implements Client {
  ready = false;
  session = "";
  constructor(
    readonly io: Stdio,
    readonly at: Place | null = null,
    readonly inference = false,
  ) {}
  static start(at: Place, inference: Inference | null) {
    // Its API reaches the one service the default settings run. Its tools
    // run there too, in that service's environment, so `at.env` can't reach them.
    if (at.account) throw Error("HeadlessAccountUnsupported");
    const command = import.meta.filename.startsWith("/$bunfs/")
      ? [process.execPath]
      : [process.execPath, resolve(import.meta.dir, "../../main.ts")];
    // The worker hears the instructions over its pipe; saved state keeps none.
    const { instructions: _, ...kept } = at;
    const client = new OpenCode2(Stdio.spawn([...command, "__opencode2"], { cwd: at.cwd }), kept, inference !== null);
    client.io.write({ at, inference });
    return client;
  }
  send(input: Input) {
    this.io.write(input);
  }
  take(): Event[] {
    const events: Event[] = [];
    for (const value of this.io.read()) {
      const error = str(value, "error");
      if (error) throw Error(error);
      const event = field(value, "event") as Event | null;
      if (!event) continue;
      if (event.kind === "ready") this.ready = true;
      if (event.kind === "conversation" && event.shown) this.session = event.session;
      if (event.kind === "usage") {
        const normalized = (v: unknown) =>
          new Tokens({
            input: number(v, "input") ?? 0n,
            cached_input: number(v, "cached_input") ?? 0n,
            output: number(v, "output") ?? 0n,
          });
        if (event.part) event.part.tokens = normalized(event.part.tokens);
        if (event.total)
          event.total = {
            total: normalized(event.total.total),
            last: event.total.last ? normalized(event.total.last) : null,
          };
      }
      events.push(event);
    }
    if (this.io.exited) events.push({ kind: "ended" });
    return events;
  }
  wait(deadline: number) {
    return this.io.wait(deadline);
  }
  close() {
    // A session that keeps nothing goes with its client, as a summary's does.
    const remove = this.inference || this.at?.persist === false;
    if (this.io.owner === "runtime" && this.at && this.session)
      void new API(this.at.executable, this.at.cwd)
        .call(remove ? "DELETE" : "POST", `/api/session/${this.session}` + (remove ? "" : "/interrupt?resume=false"))
        .catch(() => {});
    this.io.close();
  }
  adopt() {
    this.io.adopt();
  }
  processes() {
    return this.io.pid > 0 ? [this.io.pid] : [];
  }
  save(live: boolean): Saved {
    const saved = this.io.save(live);
    return {
      ...saved,
      state: {
        ...(saved.state as object),
        ready: this.ready,
        at: this.at,
        session: this.session,
        inference: this.inference,
      },
    };
  }
  static restore(saved: Saved, live: boolean) {
    const client = new OpenCode2(
      Stdio.restore(saved, live),
      field(saved.state, "at"),
      field(saved.state, "inference") === true,
    );
    client.ready = field(saved.state, "ready") === true;
    client.session = str(saved.state, "session");
    return client;
  }
}
