//! Corgi throws errors by name (`throw Error("Timeout")`) and tells them
//! apart by that name, never by display text.

/** Whether `error` is the failure named `name`. */
export function is<N extends string>(error: unknown, name: N): error is Error & { message: N } {
  return error instanceof Error && error.message === name;
}
/** The daemon's error reply as a failure named by its `err`, keeping the fields beside it. */
export function fromReply(reply: { err: string; [field: string]: unknown }): Error {
  return Object.assign(Error(reply.err), { reply });
}
/** The error reply `error` was made from, or null. */
export function reply(error: unknown): object | null {
  return error instanceof Error && "reply" in error && typeof error.reply === "object" ? error.reply : null;
}
/** The failure's name, or null when something other than an Error was thrown. */
export function name(error: unknown): string | null {
  return error instanceof Error ? error.message : null;
}
