//! What a command the prompt's model runs tells its session: a search's
//! progress, and a memory line it wrote. A lightweight local callback:
//! loading the CLI reporter must not load the provider adapters or native
//! viewer. stdout remains the model's result.
import type { Change } from "./prompt_memory";
import type { State } from "./prompt_search";
import type { Request } from "./protocol";

export class Reporter {
  private disabled = false;
  constructor(
    private socket: string,
    private headless: number,
  ) {}
  /** The reporter for the prompt session this command runs in, as its
   * environment names it; null outside one, as in the user's own shell. */
  static here(env: Record<string, string | undefined> = process.env): Reporter | null {
    const headless = Number(env.CORGI_HEADLESS_ID);
    return env.CORGI_SOCKET && Number.isSafeInteger(headless) && headless > 0
      ? new Reporter(env.CORGI_SOCKET, headless)
      : null;
  }
  /** Calls are ordered: the search awaits each bounded update. */
  send(search: State): Promise<void> {
    return this.call("headless.search", { id: this.headless, search });
  }
  /** Tells the session a line `corgi memory` wrote, so its thread shows it
   * and /erase can strike it. */
  memory(change: Change): Promise<void> {
    const { file, line, was } = change;
    return this.call("headless.memory", {
      id: this.headless,
      file,
      line,
      was_file: was?.file ?? "",
      was_line: was?.line ?? "",
    });
  }
  /** One HTTP request; a daemon that doesn't answer in time hears no more. */
  private async call<Op extends "headless.search" | "headless.memory">(op: Op, payload: Request<Op>): Promise<void> {
    if (this.disabled) return;
    try {
      const response = await fetch("http://corgi/rpc", {
        unix: this.socket,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op, ...payload }),
        signal: AbortSignal.timeout(500),
      } as RequestInit);
      if ((await response.json())?.ok !== true) this.close();
    } catch {
      this.close();
    }
  }
  close(): void {
    this.disabled = true;
  }
}
