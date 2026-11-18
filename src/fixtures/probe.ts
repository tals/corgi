import * as terminal_info from "../terminal_info";
import { Parser, type Input } from "../terminal_input";

export class Probe extends terminal_info.Probe {
  readonly parser = new Parser();
  feed(bytes: Uint8Array | string, now = Date.now()): Buffer {
    return this.take(this.parser.feed(typeof bytes === "string" ? Buffer.from(bytes) : bytes, now), now);
  }
  expire(now: number): Buffer {
    this.tick(now);
    return this.take(this.parser.expire(now), now);
  }
  private take(input: Input[], now: number): Buffer {
    return Buffer.concat(input.filter(event => !this.accept(event, now)).map(event => event.bytes));
  }
}

/** What passes through `probe` as input when the terminal sends `bytes` one byte at a time. */
export function fragmented(probe: Probe, bytes: string): string {
  return Buffer.concat(Array.from(Buffer.from(bytes), byte => probe.feed(Buffer.from([byte])))).toString();
}
