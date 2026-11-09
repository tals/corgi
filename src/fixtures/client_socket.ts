import * as json from "../json";
import type * as peer from "../peer";

/** Keeps what a client sends, as a test's stand-in for its WebSocket. */
export class Recorder implements peer.Transport {
  sent: Buffer[] = [];
  buffered = 0;
  closed: { code?: number; reason?: string } | null = null;
  send(bytes: Buffer): void {
    this.sent.push(Buffer.from(bytes));
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
  get text(): string {
    return Buffer.concat(this.sent).toString();
  }
  /** The JSON lines sent, parsed. */
  lines(): any[] {
    return this.text
      .split("\n")
      .filter(Boolean)
      .map(line => json.parse(line));
  }
}
