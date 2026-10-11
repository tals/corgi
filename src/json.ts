// Preserve the integer tokens used by Zig's u64 IDs, hashes and counters.
export function parse(text: string): any {
  return JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) => {
    if (typeof value === "number" && !Number.isSafeInteger(value) && context?.source && /^-?\d+$/.test(context.source))
      return BigInt(context.source);
    return value;
  });
}
export function stringify(value: unknown, space?: number): string {
  return JSON.stringify(
    value,
    (_key, value) => (typeof value === "bigint" ? JSON.rawJSON(String(value)) : value),
    space,
  );
}
export function clone<T>(value: T): T {
  return parse(stringify(value));
}
export function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("UnexpectedToken");
  return value as Record<string, any>;
}

// Vendor records tolerate missing or mistyped fields. Own wire formats use
// the strict protocol/checkpoint decoders instead.
export function field(value: unknown, key: string): any {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, key)
    ? ((value as Record<string, unknown>)[key] ?? null)
    : null;
}
export function str(value: unknown, key: string): string {
  const item = field(value, key);
  return typeof item === "string" ? item : "";
}
export function int(value: unknown, key: string): bigint | null {
  return integerReader(64, true)(field(value, key)) ?? null;
}
export function uint(value: unknown, key: string): bigint | null {
  return integerReader(64)(field(value, key)) ?? null;
}
export function float(value: unknown, key: string): number | null {
  const item = field(value, key);
  return typeof item === "number" || typeof item === "bigint" ? Number(item) : null;
}
export function boolean(value: unknown, key: string): boolean {
  return field(value, key) === true;
}
export function list(value: unknown, key: string): any[] {
  const item = field(value, key);
  return Array.isArray(item) ? item : [];
}
export function firstStr(value: unknown, keys: string[]): string {
  for (const key of keys) {
    const item = str(value, key);
    if (item) return item;
  }
  return "";
}

export type Reader<T> = (value: unknown) => T | undefined;
export type Shape<T> = { [K in keyof T]: { default: T[K]; read: Reader<T[K]> } };
// TypeScript erases field types; this small schema supplies Zig's comptime T.
export function decode<T>(shape: Shape<T>, value: unknown): T {
  const output = {} as T;
  for (const key of Object.keys(shape) as (keyof T)[]) {
    const spec = shape[key],
      item = field(value, String(key));
    output[key] = spec.read(item) ?? structuredClone(spec.default);
  }
  return output;
}
function integerReader(bits: 64, signed?: boolean): Reader<bigint>;
function integerReader(bits: 8 | 16 | 32, signed?: boolean): Reader<number>;
function integerReader(bits: 8 | 16 | 32 | 64, signed = false): Reader<number | bigint> {
  return value => {
    if (typeof value !== "bigint" && (typeof value !== "number" || !Number.isSafeInteger(value))) return;
    const n = BigInt(value),
      min = signed ? -(1n << BigInt(bits - 1)) : 0n,
      max = 1n << BigInt(bits - (signed ? 1 : 0));
    if (n < min || n >= max) return;
    return bits === 64 ? n : Number(n);
  };
}
export const readers = {
  string: ((v: unknown) => (typeof v === "string" ? v : undefined)) as Reader<string>,
  boolean: ((v: unknown) => (typeof v === "boolean" ? v : undefined)) as Reader<boolean>,
  float: ((v: unknown) => (typeof v === "number" || typeof v === "bigint" ? Number(v) : undefined)) as Reader<number>,
  raw: ((v: unknown) => v) as Reader<unknown>,
  integer: integerReader,
  enum:
    <T extends string>(values: readonly T[]): Reader<T> =>
    v =>
      typeof v === "string" && values.includes(v as T) ? (v as T) : undefined,
  object:
    <T>(shape: Shape<T>): Reader<T> =>
    v =>
      v !== null && typeof v === "object" && !Array.isArray(v) ? decode(shape, v) : undefined,
};
