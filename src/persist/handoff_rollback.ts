import * as errors from "../errors";
import * as json from "../json";
import * as migrations from "./migrations";
import * as state_formats from "./state_formats";
import type { captureManifest } from "./handoff";

// XXX: Remove for next protocol bump. A format-6 build adopts the listener
// and its clients' connections instead of binding the socket itself. Rolling
// back to one keeps running programs; this build's own clients can't follow.
export function supported(error: unknown): boolean {
  return (
    errors.is(error, "UnsupportedStateVersion") &&
    migrations.handoff_version === 7 &&
    migrations.checkpoint_version === 6
  );
}
/** Format 6 of `manifest`, for a candidate that reads no newer: it adopts
 * `listener`, and its reply to the reload goes to the requester as a client. */
export function downgrade(manifest: Record<string, any>, listener: number) {
  if (manifest.version !== 7 || manifest.runtime.version !== 6) throw Error("UnsupportedStateVersion");
  const saved = json.object(
    state_formats.handoff.down(
      json.clone({ ...manifest, retired: { listener, clients: [] } }),
      migrations.legacy.handoff[6],
    ),
  );
  saved.version = 6;
  return saved as Omit<ReturnType<typeof captureManifest>, "instance" | "links" | "start_lock" | "older_updater"> & {
    listener: number;
    clients: { fd: number; viewer: boolean }[];
  };
}
