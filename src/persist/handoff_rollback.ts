import * as errors from "../errors";
import * as migrations from "./migrations";
import type { captureManifest } from "./handoff";

// XXX: Remove for next protocol bump. Only the WS-only handoff 7 → 6 change is reversible here.
export function supported(error: unknown): boolean {
  return (
    errors.is(error, "UnsupportedStateVersion") &&
    migrations.handoff_version === 7 &&
    migrations.checkpoint_version === 6
  );
}
export function downgrade(manifest: ReturnType<typeof captureManifest>) {
  if (manifest.version !== 7 || manifest.runtime.version !== 6) throw Error("UnsupportedStateVersion");
  const removed = new Set(manifest.clients.filter(client => client.websocket).map(client => client.link));
  const clients = manifest.clients.filter(client => !client.websocket).map(({ websocket: _, ...client }) => client);
  if (!clients.some(client => client.fd === manifest.requester)) throw Error("InvalidRollbackRequester");
  return {
    ...manifest,
    version: 6,
    clients,
    links: manifest.links.filter(link => !removed.has(link.id)),
  };
}
