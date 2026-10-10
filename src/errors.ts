//! Corgi throws errors by name (`throw Error("Timeout")`) and tells them
//! apart by that name, never by display text.

/** Whether `error` is the failure named `name`. */
export function is<N extends string>(error: unknown, name: N): error is Error & { message: N } {
  return error instanceof Error && error.message === name;
}
/** The failure's name, or null when something other than an Error was thrown. */
export function name(error: unknown): string | null {
  return error instanceof Error ? error.message : null;
}
