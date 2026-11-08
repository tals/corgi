import * as crypto from "node:crypto";
import * as buffer from "node:buffer";
import * as json from "./json";
import * as wire from "./protocol";

export const protocol = wire.transports.websocket;
/** The daemon committed a rollback to a version without this transport. */
export const rolled_back = 4000;
export const capacity = 4 * 1024 * 1024;
const header_limit = 16384;
const guid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Only parser state crosses a daemon handoff; the descriptor and output queue stay with the peer. */
export interface State {
  ready: boolean;
  closing: boolean;
  input: string;
  fragment: string | null;
}
export function state(value: unknown): State {
  const fields = json.object(value);
  if (
    typeof fields.ready !== "boolean" ||
    typeof fields.closing !== "boolean" ||
    typeof fields.input !== "string" ||
    (fields.fragment !== null && typeof fields.fragment !== "string")
  )
    throw Error("InvalidWebSocketState");
  for (const bytes of [fields.input, fields.fragment])
    if (
      bytes !== null &&
      (bytes.length > Math.ceil((capacity + 14) / 3) * 4 || Buffer.from(bytes, "base64").toString("base64") !== bytes)
    )
      throw Error("InvalidWebSocketState");
  if (!fields.ready && (fields.closing || fields.fragment !== null)) throw Error("InvalidWebSocketState");
  return { ready: fields.ready, closing: fields.closing, input: fields.input, fragment: fields.fragment };
}

/** Unmasked server frame. Compression, when selected by RPC, is inside the binary payload. */
export function frame(bytes: Buffer, opcode = 2): Buffer {
  const size = bytes.length < 126 ? 2 : bytes.length <= 65535 ? 4 : 10;
  const out = Buffer.allocUnsafe(size + bytes.length);
  out[0] = 0x80 | opcode;
  if (size === 2) out[1] = bytes.length;
  else if (size === 4) {
    out[1] = 126;
    out.writeUInt16BE(bytes.length, 2);
  } else {
    out[1] = 127;
    out.writeBigUInt64BE(BigInt(bytes.length), 2);
  }
  bytes.copy(out, size);
  return out;
}

/** RFC 6455 server framing over an owned descriptor, including partial-frame handoff. */
export class Server {
  private ready = false;
  private storage: Buffer = Buffer.alloc(0);
  private offset = 0;
  private used = 0;
  private get input(): Buffer {
    return this.storage.subarray(this.offset, this.used);
  }
  private fragments: Buffer | null = null;
  private fragment_bytes = 0;
  closing = false;
  get idle(): boolean {
    return this.ready && this.offset === this.used && this.fragments === null && !this.closing;
  }
  constructor(
    private readonly write: (bytes: Buffer) => void,
    private readonly read: (bytes: Buffer) => void,
    state?: State,
  ) {
    if (state) {
      this.ready = state.ready;
      this.closing = state.closing;
      this.storage = Buffer.from(state.input, "base64");
      this.used = this.storage.length;
      if (state.fragment !== null) {
        const bytes = Buffer.from(state.fragment, "base64");
        this.fragments = bytes;
        this.fragment_bytes = bytes.length;
      }
      this.bound();
      if (!this.ready && this.input.length > header_limit) throw Error("InvalidWebSocketState");
    }
  }
  save(): State {
    return {
      ready: this.ready,
      closing: this.closing,
      input: this.input.toString("base64"),
      fragment: this.fragments === null ? null : this.fragments.subarray(0, this.fragment_bytes).toString("base64"),
    };
  }
  private bound(): void {
    if (
      this.fragment_bytes > capacity ||
      this.input.length > capacity + 14 ||
      this.input.length + this.fragment_bytes > capacity + 139
    )
      throw Error("MessageTooLarge");
  }
  receive(bytes: Buffer): void {
    if (this.closing) return;
    const pending = this.used - this.offset;
    if (pending + bytes.length > capacity + 65550) throw Error("MessageTooLarge");
    if (this.storage.length - this.used < bytes.length) {
      if (this.storage.length >= pending + bytes.length) this.storage.copyWithin(0, this.offset, this.used);
      else {
        const grown = Buffer.allocUnsafe(
          Math.max(pending + bytes.length, Math.min(capacity + 65550, this.storage.length * 2)),
        );
        this.input.copy(grown);
        this.storage = grown;
      }
      this.offset = 0;
      this.used = pending;
    }
    bytes.copy(this.storage, this.used);
    this.used += bytes.length;
    if (!this.ready && !this.upgrade()) return;
    while (!this.closing && this.input.length >= 2) {
      const first = this.input[0],
        second = this.input[1],
        final = (first & 0x80) !== 0,
        opcode = first & 15,
        short = second & 127;
      if (first & 0x70 || !(second & 0x80)) throw Error("InvalidWebSocketFrame");
      if (![0, 2, 8, 9, 10].includes(opcode)) throw Error("InvalidWebSocketOpcode");
      const control = opcode >= 8;
      if (control && (!final || short > 125)) throw Error("InvalidWebSocketControl");
      let length = short,
        head = 2;
      if (short === 126) {
        if (this.input.length < 4) return;
        length = this.input.readUInt16BE(2);
        head = 4;
        if (length < 126) throw Error("InvalidWebSocketLength");
      } else if (short === 127) {
        if (this.input.length < 10) return;
        const large = this.input.readBigUInt64BE(2);
        if (large <= 65535n || large > BigInt(capacity)) throw Error("InvalidWebSocketLength");
        length = Number(large);
        head = 10;
      }
      if (length + (control ? 0 : this.fragment_bytes) > capacity) throw Error("MessageTooLarge");
      if (!control && (opcode === 0) !== (this.fragments !== null)) throw Error("InvalidWebSocketFragment");
      const end = head + 4 + length;
      if (this.input.length < end) return;
      const payload = Buffer.from(this.input.subarray(head + 4, end));
      for (let i = 0; i < length; i++) payload[i] ^= this.input[head + (i & 3)];
      this.offset += end;
      switch (opcode) {
        case 8:
          if (length === 1) throw Error("InvalidWebSocketClose");
          if (length >= 2) {
            const code = payload.readUInt16BE(0);
            if (
              !(code >= 3000 && code <= 4999) &&
              !(code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code))
            )
              throw Error("InvalidWebSocketClose");
            if (!buffer.isUtf8(payload.subarray(2))) throw Error("InvalidWebSocketClose");
          }
          this.closing = true;
          this.write(frame(payload, 8));
          return;
        case 9:
          this.write(frame(payload, 10));
          break;
        case 10:
          break;
        default:
          if (this.fragments !== null || !final) {
            const required = this.fragment_bytes + payload.length;
            if (this.fragments === null || this.fragments.length < required) {
              const grown = Buffer.allocUnsafe(
                Math.min(capacity, Math.max(required, (this.fragments?.length ?? 512) * 2)),
              );
              this.fragments?.copy(grown, 0, 0, this.fragment_bytes);
              this.fragments = grown;
            }
            payload.copy(this.fragments, this.fragment_bytes);
            this.fragment_bytes += payload.length;
            if (final) {
              const message = this.fragments.subarray(0, this.fragment_bytes);
              this.fragments = null;
              this.fragment_bytes = 0;
              this.read(message);
            }
          } else this.read(payload);
      }
    }
    this.bound();
  }
  fail(code = 1002): void {
    if (!this.ready || this.closing) return;
    this.closing = true;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code);
    this.write(frame(payload, 8));
  }
  private upgrade(): boolean {
    const end = this.input.indexOf("\r\n\r\n");
    if (end < 0) {
      if (this.input.length > header_limit) throw Error("WebSocketHeaderTooLarge");
      return false;
    }
    if (end > header_limit) throw Error("WebSocketHeaderTooLarge");
    const [request, ...lines] = this.input.subarray(0, end).toString("latin1").split("\r\n"),
      headers = new Map<string, string>();
    if (request !== "GET /rpc HTTP/1.1") throw Error("InvalidWebSocketUpgrade");
    for (const line of lines) {
      const colon = line.indexOf(":");
      if (colon <= 0) throw Error("InvalidWebSocketUpgrade");
      const name = line.slice(0, colon).toLowerCase(),
        value = line.slice(colon + 1).trim();
      if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) throw Error("InvalidWebSocketUpgrade");
      const previous = headers.get(name);
      if (
        previous !== undefined &&
        !["connection", "upgrade", "sec-websocket-protocol", "sec-websocket-extensions"].includes(name)
      )
        throw Error("InvalidWebSocketUpgrade");
      headers.set(name, previous === undefined ? value : `${previous}, ${value}`);
    }
    const key = headers.get("sec-websocket-key") ?? "",
      tokens = (name: string) => (headers.get(name) ?? "").split(",").map(value => value.trim());
    if (
      !headers.get("host") ||
      !tokens("upgrade").some(value => value.toLowerCase() === "websocket") ||
      !tokens("connection").some(value => value.toLowerCase() === "upgrade") ||
      headers.get("sec-websocket-version") !== "13" ||
      !tokens("sec-websocket-protocol").includes(protocol) ||
      !/^[A-Za-z0-9+/]{22}==$/.test(key) ||
      Buffer.from(key, "base64").length !== 16 ||
      headers.has("transfer-encoding") ||
      (headers.has("content-length") && headers.get("content-length") !== "0")
    )
      throw Error("InvalidWebSocketUpgrade");
    const accept = crypto
      .createHash("sha1")
      .update(key + guid)
      .digest("base64");
    this.offset += end + 4;
    this.ready = true;
    this.write(
      Buffer.from(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: ${protocol}\r\n\r\n`,
      ),
    );
    return true;
  }
}
