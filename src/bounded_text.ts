/** Byte strings that JSON must encode as byte arrays, as Zig does for invalid UTF-8. */
export class RawText extends String {
  constructor(public bytes: Buffer) {
    super(bytes.toString("utf8"));
  }
  toJSON() {
    return [...this.bytes];
  }
}
export function decodeBytes(bytes: Uint8Array): string | RawText {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new RawText(Buffer.from(bytes));
  }
}
export function truncateUtf8(value: string | Uint8Array, capacity: number) {
  const bytes = Buffer.from(value);
  let take = Math.min(bytes.length, Math.max(0, capacity));
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (take > 0) {
    try {
      return decoder.decode(bytes.subarray(0, take));
    } catch {
      take--;
    }
  }
  return "";
}
export function ascii(value: string, capacity: number) {
  const bytes = Buffer.from(value).subarray(0, capacity);
  return Array.from(bytes, b => (b >= 32 && b < 127 ? String.fromCharCode(b) : " ")).join("");
}
export function BoundedText(capacity: number) {
  return class Bounded {
    static capacity = capacity;
    value: string;
    private raw_bytes?: Buffer;
    constructor(value = "") {
      this.value = truncateUtf8(value, capacity);
    }
    static init(value: string | Uint8Array) {
      const bytes = Buffer.from(value);
      if (bytes.length > capacity) throw Error("TooLong");
      const text = decodeBytes(bytes),
        result = new this(typeof text === "string" ? text : "");
      if (text instanceof RawText) {
        result.raw_bytes = bytes;
        result.value = bytes.toString("utf8");
      }
      return result;
    }
    static fromJSON(value: unknown) {
      let bytes: Buffer;
      if (typeof value === "string") bytes = Buffer.from(value);
      else if (Array.isArray(value)) {
        for (const n of value) {
          if (typeof n !== "number" || !Number.isInteger(n)) throw Error("UnexpectedToken");
          if (n < 0 || n > 255) throw Error("Overflow");
        }
        bytes = Buffer.from(value);
      } else throw Error("UnexpectedToken");
      if (bytes.length > capacity) throw Error("LengthMismatch");
      return this.init(bytes);
    }
    static jsonParseFromValue(value: unknown) {
      return this.fromJSON(value);
    }
    static jsonParse(source: string) {
      return this.fromJSON(JSON.parse(source));
    }
    static initTruncated(value: string) {
      return new this(value);
    }
    static ascii(value: string) {
      return new this(ascii(value, capacity));
    }
    text() {
      return this.value;
    }
    get len() {
      return this.raw_bytes?.length ?? Buffer.byteLength(this.value);
    }
    append(value: string) {
      const suffix = truncateUtf8(value, capacity - this.len);
      if (this.raw_bytes) {
        this.raw_bytes = Buffer.concat([this.raw_bytes, Buffer.from(suffix)]);
        this.value = this.raw_bytes.toString("utf8");
      } else this.value += suffix;
    }
    toJSON() {
      return this.raw_bytes ? [...this.raw_bytes] : this.value;
    }
  };
}
export const Path = BoundedText(10 * 1024);
