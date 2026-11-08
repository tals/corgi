import type { InputReceipt } from "./pane/surface";

/** Control replies and screen frames can arrive in either order. */
export class Receipts {
  through = 0;
  private ack: InputReceipt | null = null;
  private sent: { through: number; receipt: InputReceipt }[] = [];

  delivered(through: number, receipt: InputReceipt): void {
    this.sent.push({ through, receipt });
    if (this.sent.length > 256) this.sent.shift();
    this.advance();
  }
  receive(ack: InputReceipt | undefined): void {
    if (!ack) return;
    if (this.ack?.epoch === ack.epoch && this.ack.sequence > ack.sequence) return;
    this.ack = ack;
    this.advance();
  }
  private advance(): void {
    if (!this.ack) return;
    for (const sent of this.sent)
      if (sent.receipt.epoch === this.ack.epoch && sent.receipt.sequence <= this.ack.sequence)
        this.through = Math.max(this.through, sent.through);
    this.sent = this.sent.filter(sent => sent.through > this.through);
  }
}
