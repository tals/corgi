import type { Revision } from "../formats";
import * as values from "../revision_values";

export const revision: Revision = {
  id: "3a005bd21b0d",
  parent: "38dc0fb4d7d7",
  description: "Retire transferred connections and resume links",
  up(value) {
    // Format 7 hands over no connections: clients reconnect and resume their
    // links. A format-6 sender's listener and clients are older peers, which
    // the candidate answers and closes.
    const fields = values.object(value);
    fields.retired = {
      listener: fields.listener ?? -1,
      clients: values
        .items(value, "clients")
        .map(client => ({ fd: values.object(client).fd, viewer: values.object(client).viewer === true })),
    };
    delete fields.listener;
    delete fields.clients;
    fields.links ??= [];
    return value;
  },
  down(value) {
    const fields = values.object(value);
    fields.listener = values.object(fields.retired ?? {}).listener ?? -1;
    // Old peers need a reply client. Viewer and link state can be discarded.
    fields.clients = fields.requester >= 0 ? [client(fields.requester)] : [];
    delete fields.retired;
    delete fields.instance;
    delete fields.links;
    delete fields.start_lock;
    delete fields.older_updater;
    return value;
  },
};

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
  };
}
