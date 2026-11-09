//! How a viewer reaches one machine's daemon. A path is made by a factory an
//! endpoint is given, and opens the connections the endpoint talks over:
//! the control connection, and the data connection pane contents take. The
//! endpoint keeps its link, typing and stream across paths; what differs from
//! one way of reaching a daemon to another stays here.
import { Connection } from "./rpc";
import type { Stats } from "./connection_stats";
import type * as telemetry from "./telemetry";
import type * as imageUpload from "./image_upload";
import * as errors from "./errors";
import * as protocol from "./protocol";

export type Kind = "control" | "data";
/** What a failure means: try again, ask the user about access, or give up. */
export type Issue = "error" | "auth" | "host-key" | "fatal";
export interface Path {
  /** Opens a connection to the daemon and greets it. */
  open(kind: Kind, stats: Stats, trace: telemetry.Details): Promise<{ connection: Connection; hello: Hello }>;
  /** How long without a frame counts as stalled. */
  stallMs(stats: Stats): number;
  /** Whether a quiet connection gets a fresh path tried beside it. */
  readonly races: boolean;
  /** Where the daemon listens for HTTP here, if anywhere. */
  readonly socket: string | null;
  /** Where the machine's new panes open. */
  readonly home: string;
  /** A pasted image's path on the machine, once it's there. */
  readonly upload: Upload | null;
  /** What `error` means here, and what to show for it. */
  diagnose(error: unknown): { issue: Issue; detail: string };
  /** What an unfinished `open` is waiting on, in words. */
  progress(): string;
  close(): void;
}
export type Hello = protocol.Reply<"hello">;
export type Upload = (
  path: string,
  mime: string,
  instance: string,
  signal: AbortSignal,
  progress?: imageUpload.Progress,
) => Promise<string>;
/** Makes a path. `fresh` asks for one that shares nothing with paths before
 * it; `race` for one tried beside a quiet connection, which gives up sooner. */
export type Factory = (fresh: boolean, race: boolean) => Path;

/** A connection gone this long without an answer counts as stalled. */
export const stalled_ms = 1000;

/** This machine's daemon, on its socket. `start` starts it if it isn't running, once. */
export function local(socket: string, start?: () => Promise<void>): Factory {
  let started = !start;
  return () => {
    const opened: Connection[] = [];
    return {
      races: false,
      socket,
      home: process.cwd(),
      upload: null,
      async open(_kind, stats, trace) {
        if (!started) {
          await start!();
          started = true;
        }
        const connection = new Connection(socket, { timeout_ms: 10_000, stats, trace });
        opened.push(connection);
        return { connection, hello: await connection.call("hello") };
      },
      stallMs: () => stalled_ms,
      diagnose: error => ({ issue: incompatible(error) ? "fatal" : "error", detail: "" }),
      progress: () => "",
      close() {
        for (const connection of opened) connection.close();
      },
    };
  };
}
/** The daemon's instance, when it speaks this viewer's protocols. */
export function compatible(hello: Hello): string {
  if (hello.protocol !== protocol.version || hello.viewer_protocol !== protocol.viewer_version || !hello.instance)
    throw Error("IncompatibleRemoteCorgi");
  return hello.instance;
}
/** Whether the daemon speaks another viewer protocol than this viewer. */
export function incompatible(error: unknown): boolean {
  switch (errors.name(error)) {
    case "IncompatibleViewerProtocol":
    case "ServerRolledBack":
    case "UnsupportedViewerProtocol":
    case "UnsupportedProtocol":
    case "ProtocolRequired":
    case "IncompatibleRemoteCorgi":
      return true;
    default:
      return false;
  }
}
