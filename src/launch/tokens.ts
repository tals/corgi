//! Shell-style command words without shell evaluation.
export const max_length = 2048;
export class Tokens {
  pos = 0;
  start = 0;
  constructor(public source: string) {}
  next() {
    while (this.pos < this.source.length && /\s/.test(this.source[this.pos])) this.pos++;
    this.start = this.pos;
    if (this.pos === this.source.length) return null;
    let quote = "",
      out = "";
    while (this.pos < this.source.length) {
      const ch = this.source[this.pos];
      if (!quote && /\s/.test(ch)) break;
      this.pos++;
      if (ch === quote) {
        quote = "";
        continue;
      }
      if (!quote && (ch === "'" || ch === '"')) {
        quote = ch;
        continue;
      }
      if (ch === "\\" && quote !== "'") {
        if (this.pos === this.source.length) return null;
        out += this.source[this.pos++];
      } else {
        if (!quote && ";|&<>()$`".includes(ch)) return null;
        out += ch;
      }
      if (Buffer.byteLength(out) >= max_length) return null;
    }
    return quote ? null : out;
  }
}
