import { createConnection, type Socket } from "node:net";
import { parse, stringify } from "./json";
import { milliTimestamp } from "./clock";
import type { History, Entry } from "./launch/history";
import { type Preview, preview as previewValue } from "./agent_launcher";
import { Provider } from "./providers";
export class Stream {
  socket = "";
  fd: Socket | null = null;
  input = "";
  cwd = "";
  workspace = 0;
  preview: Preview = previewValue();
  received = false;
  retry_at = 0;
  history: History = { pending: true, entries: [] };
  changed = false;
  disconnect() {
    this.fd?.destroy();
    this.fd = null;
    this.input = "";
  }
  current(cwd: string): Preview {
    if (cwd === this.cwd) return this.preview;
    // Provider visibility survives a directory change; model settings don't.
    const result = previewValue();
    result.installed = { ...this.preview.installed };
    for (const provider of Provider.all) result.options[provider].signed_in = this.preview.options[provider].signed_in;
    return result;
  }
  pending(cwd: string) {
    if (cwd === this.cwd) this.preview.pending = true;
  }
  poll(workspace: number, cwd: string) {
    if (!this.socket) return false;
    if (this.workspace !== workspace || this.cwd !== cwd) {
      const initial = this.current(cwd);
      this.disconnect();
      this.cwd = cwd;
      this.workspace = workspace;
      this.preview = initial;
      this.received = false;
      this.retry_at = 0;
      this.changed = true;
    }
    if (!this.fd && milliTimestamp() >= this.retry_at) {
      this.retry_at = milliTimestamp() + 1000;
      const connection = createConnection(this.socket);
      this.fd = connection;
      connection.once("connect", () => {
        connection.write(stringify({ op: "agent.subscribe", protocol: 1, workspace, cwd }) + "\n");
        connection.write(stringify({ op: "agent.history", protocol: 1, follow: true }) + "\n");
      });
      connection.on("data", chunk => {
        try {
          this.changed = this.feed(chunk.toString()) || this.changed;
        } catch {
          this.disconnect();
        }
      });
      connection.once("error", () => {
        if (this.fd === connection) this.disconnect();
      });
      connection.once("close", () => {
        if (this.fd === connection) this.disconnect();
      });
    }
    const changed = this.changed;
    this.changed = false;
    return changed;
  }
  feed(bytes: string) {
    this.input += bytes;
    if (Buffer.byteLength(this.input) > 16 * 1024 * 1024) throw new Error("InputTooLarge");
    let changed = false;
    while (true) {
      const i = this.input.indexOf("\n");
      if (i < 0) break;
      const line = this.input.slice(0, i);
      this.input = this.input.slice(i + 1);
      changed = this.receive(parse(line)) || changed;
    }
    return changed;
  }
  receive(message: any) {
    if (message.type === "agent.history") {
      const update =
        message.update ?? (message.history ? { full: true, entries: message.history.entries, removed: [] } : null);
      if (!update) return false;
      this.applyHistory(update);
      return true;
    }
    if (message.type !== "agent.preview" || message.cwd !== this.cwd) return false;
    const sent = previewValue(message.preview);
    let preview = sent;
    if (preview.pending) {
      if (this.received) {
        preview = previewValue(parse(stringify(this.preview)));
        preview.pending = true;
        preview.installed = sent.installed;
      }
      for (const provider of Provider.all) {
        const option = preview.options[provider];
        if (option.signed_in === null) option.signed_in = this.preview.options[provider].signed_in;
      }
    }
    const changed = stringify(this.preview) !== stringify(preview);
    this.preview = preview;
    this.received = true;
    return changed;
  }
  applyHistory(update: { full: boolean; entries: Entry[]; removed?: { provider: string; session: string }[] }) {
    const key = (e: { provider: string; session: string }) => e.provider + ":" + e.session,
      replaced = new Set([...update.entries, ...(update.removed ?? [])].map(key));
    this.history = {
      pending: false,
      entries: [
        ...(update.full ? [] : this.history.entries.filter(e => !replaced.has(key(e)))),
        ...structuredClone(update.entries),
      ].sort((a, b) => b.updated_at - a.updated_at),
    };
  }
}
