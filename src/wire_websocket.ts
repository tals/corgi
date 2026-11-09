//! What both ends of a daemon WebSocket agree on. Bun frames the messages;
//! each carries part of the same JSON-lines stream a request sends.
/** The WebSocket subprotocol, which `hello` names among its transports. */
export const protocol = "corgi-stream-v1";
/** The daemon handed off to a newer process: reconnect and resume the link. */
export const reloading = 1012;
/** Too many clients; try again later. */
export const try_again = 1013;
/** Text messages: the stream is bytes. */
export const unsupported = 1003;
/** XXX: Remove for next protocol bump. The daemon committed a rollback to a
 * version without this transport. */
export const rolled_back = 4000;
export const capacity = 4 * 1024 * 1024;
