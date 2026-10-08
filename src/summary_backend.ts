import { Pool } from "./inference/harness";
import { model } from "./inference/setup";
import type { Provider } from "./providers";
import { stringify } from "./json";
import * as contract from "./activity/prompt";
import * as clock from "./clock";
export { contract };
export type Input = contract.Input;
export type Source = {
  actor: number;
  panes: number[];
  agent_name: string;
  session: string;
  tools_since_last: bigint;
};
export type Discard =
  | "not_working"
  | "session_changed"
  | "turn_changed"
  | "evidence_changed"
  | "superseded";
function log(value: any) {
  if (process.argv.some((arg) => arg === "serve" || arg === "__handoff"))
    process.stderr.write("info(activity_summary): " + stringify(value) + "\n");
}
export function outcome(request: bigint, discard: Discard | null) {
  if (!request) return;
  log({
    event: "outcome",
    at: clock.milliTimestamp(),
    context: { pid: process.pid, request },
    status: discard === null ? "applied" : "discarded",
    reason: discard,
  });
}
export class Backend {
  pool = new Pool();
  next_request = 0n;
  use(provider: Provider | null) {
    this.pool.deinit();
    this.pool.started = false;
    this.pool.config.disabled = provider === null;
    if (provider) this.pool.config.provider = provider;
    this.pool.config.model = model(provider) || null;
    this.pool.config.executable = process.env.CORGI_INFERENCE_BIN ?? null;
  }
  deinit() {
    this.pool.deinit();
  }
  async infer(
    input: Input,
    turn: string,
    conversation: string,
    source: Source,
    stopping: any = false,
  ) {
    const request = ++this.next_request,
      context = { pid: process.pid, request, source, turn, conversation };
    const content = contract.content({ ...input, history: null }),
      fresh = input.history?.length ? contract.content(input) : null;
    log({
      event: "request",
      at: clock.milliTimestamp(),
      context,
      provider: this.pool.config.provider,
      model: this.pool.config.model,
      instructions: contract.instructions,
      schema: contract.schema,
      input: content,
      fresh_input: fresh,
    });
    let response;
    try {
      response = await this.pool.infer(
        {
          instructions: contract.instructions,
          schema: contract.schema,
          content,
          fresh_content: fresh,
          conversation,
        },
        stopping,
      );
    } catch (error) {
      log({
        event: "result",
        at: clock.milliTimestamp(),
        context,
        status: "inference_error",
        err: (error as Error).message,
        output: null,
      });
      return { request, decision: null };
    }
    try {
      const decision = contract.parse(response.text());
      log({
        event: "result",
        at: clock.milliTimestamp(),
        context,
        status: decision.label === null ? "abstained" : "validated",
        output: response.text(),
        label: decision.label?.text() ?? null,
        fresh_conversation: response.fresh,
        usage: response.usage,
      });
      return { request, decision };
    } catch (error) {
      log({
        event: "result",
        at: clock.milliTimestamp(),
        context,
        status: "rejected",
        err: (error as Error).message,
        output: response.text(),
        fresh_conversation: response.fresh,
        usage: response.usage,
      });
      return { request, decision: null };
    }
  }
}
