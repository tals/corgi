import * as errors from "../errors";
import * as migrations from "./migrations";
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
export function downgrade(manifest: ReturnType<typeof captureManifest>, listener: number) {
  if (manifest.version !== 7 || manifest.runtime.version !== 6) throw Error("UnsupportedStateVersion");
  const { instance: _, links: __, start_lock: ___, older_updater: ____, ...rest } = manifest;
  return { ...rest, version: 6, listener, clients: [client(manifest.requester)] };
}
/** A format-6 client with nothing attached. */
function client(fd: number) {
  return {
    fd,
    input: "",
    output: "",
    viewer: false,
    viewer_id: 0,
    active_seq: 0,
    view_workspace: 0,
    view_focus: null,
    interests: [],
    watched: true,
    controls: [],
    next_control: 1n,
    last_control: 0n,
    protocol_version: null,
    subscribed: false,
    subscribed_output: true,
    startup_wait: null,
    watching: false,
    watch_viewer: 0,
    launch_preview: null,
    headless_start: null,
    snapshot_revision: null,
    touched: Date.now(),
  };
}
