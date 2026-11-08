import { appendFileSync } from "node:fs";
import type { Socket } from "node:net";
import type { Readable } from "node:stream";

/** Read-only diagnostics before SSH encryption; disabled in measured trials. */
export class Inspect {
  private pending = Buffer.alloc(0);
  private upgraded = false;
  bytes = 0;
  header = "";
  frames = 0;
  payload = 0;
  compressed = 0;
  masked = 0;
  hello: object | null = null;
  read(chunk: Buffer): void {
    this.bytes += chunk.length;
    this.pending = Buffer.concat([this.pending, chunk]);
    if (!this.upgraded) {
      const end = this.pending.indexOf("\r\n\r\n");
      if (end < 0) return;
      this.header = this.pending.subarray(0, end + 4).toString();
      this.pending = this.pending.subarray(end + 4);
      this.upgraded = true;
    }
    while (this.pending.length >= 2) {
      const bytes = this.pending,
        short = bytes[1] & 127,
        masked = Boolean(bytes[1] & 128),
        extended = short === 126 ? 2 : short === 127 ? 8 : 0,
        head = 2 + extended + (masked ? 4 : 0);
      if (bytes.length < head) break;
      const length = short === 126 ? bytes.readUInt16BE(2) : short === 127 ? Number(bytes.readBigUInt64BE(2)) : short;
      if (length > 4 * 1024 * 1024) throw Error("OversizedDiagnosticFrame");
      if (bytes.length < head + length) break;
      const data = (bytes[0] & 15) === 2;
      if (data) {
        this.frames++;
        this.payload += length;
        if (bytes[0] & 64) this.compressed++;
        if (masked) this.masked++;
        if (!this.hello && !(bytes[0] & 64)) {
          const payload = Buffer.from(bytes.subarray(head, head + length));
          if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= bytes[2 + extended + (i % 4)];
          try {
            const message = JSON.parse(payload.toString().split("\n")[0]);
            if (message.op === "hello" || message.type === "hello")
              this.hello = {
                op: message.op,
                type: message.type,
                accept_encoding: message.accept_encoding,
                content_encoding: message.content_encoding,
              };
          } catch {}
        }
      }
      this.pending = bytes.subarray(head + length);
    }
  }
  result() {
    return {
      bytes: this.bytes,
      header: this.header,
      frames: this.frames,
      payload: this.payload,
      compressed: this.compressed,
      masked: this.masked,
      hello: this.hello,
      incomplete: this.pending.length,
    };
  }
}

export function inspect(machine: string, upstream: Socket, downstream: Readable): () => void {
  const file = process.env.CORGI_EVAL_CODEC_PROOF;
  if (!file) return () => {};
  const up = new Inspect(),
    down = new Inspect();
  upstream.on("data", bytes => up.read(bytes));
  downstream.on("data", bytes => down.read(bytes));
  let done = false;
  return () => {
    if (done) return;
    done = true;
    appendFileSync(file, JSON.stringify({ machine, pid: process.pid, up: up.result(), down: down.result() }) + "\n");
  };
}
