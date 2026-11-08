export interface Input {
  bytes: Uint8Array;
  paste: boolean;
}
/** Frame escape sequences before looking for global shortcuts; pasted bytes remain data. */
export class Parser {
  private buffer: number[] = [];
  private pasting = false;
  private at = 0;
  feed(bytes: Uint8Array, now = Date.now()): Input[] {
    for (const byte of bytes) this.buffer.push(byte);
    if (bytes.length) this.at = now;
    const result: Input[] = [];
    let used = 0;
    while (used < this.buffer.length) {
      let length = 1;
      const byte = this.buffer[used];
      const available = this.buffer.length - used;
      if (byte === 27) {
        if (available < 2) break;
        length = 2;
        if (this.buffer[used + 1] === 91 || this.buffer[used + 1] === 79) {
          while (length < available && !(this.buffer[used + length] >= 0x40 && this.buffer[used + length] <= 0x7e))
            length++;
          if (length === available && length < 256) break;
          length = Math.min(length + 1, available);
        }
      } else if (byte >= 32 && byte !== 127) {
        length = 0;
        while (length < Math.min(4096, available)) {
          const cp = this.buffer[used + length];
          if (cp < 32 || cp === 127) break;
          const size = cp >= 0xc2 && cp <= 0xf4 ? (cp < 0xe0 ? 2 : cp < 0xf0 ? 3 : 4) : 1;
          if (length + size > available) break;
          length += size;
        }
        if (length === 0) break;
      }
      const bytes = Uint8Array.from(this.buffer.slice(used, used + length));
      const sequence = Buffer.from(bytes).toString();
      if (sequence === "\x1b[200~") this.pasting = true;
      result.push({ bytes, paste: this.pasting });
      if (sequence === "\x1b[201~") this.pasting = false;
      used += length;
    }
    this.buffer.splice(0, used);
    return result;
  }
  expire(now = Date.now()): Input[] {
    if (!this.buffer.length || now - this.at < 50 || this.pasting) return [];
    const bytes = Uint8Array.from(this.buffer.splice(0));
    return [{ bytes, paste: false }];
  }
}
