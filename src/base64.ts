export function encode(bytes: Uint8Array | string): string { return Buffer.from(bytes).toString("base64"); }
export function decode(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw Error("InvalidBase64");
  return Buffer.from(value, "base64");
}
