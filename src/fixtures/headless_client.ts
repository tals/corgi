import type { Client, Event, Input, Saved } from "../providers/adapter";

/** A headless provider's client that keeps what it's sent and hands over the
 * events a test queues. */
export class FakeClient implements Client {
  ready = true;
  closed = false;
  sent: Input[] = [];
  queued: Event[] = [];
  send(input: Input) {
    this.sent.push(input);
  }
  take() {
    return this.queued.splice(0);
  }
  async wait() {}
  close() {
    this.closed = true;
  }
  save(): Saved {
    return { state: null, handles: [] };
  }
}
