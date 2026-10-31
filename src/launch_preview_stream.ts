import { createConnection, type Socket } from "node:net";
import { parse, stringify } from "./json";
import { milliTimestamp } from "./clock";
import type { History, Entry } from "./launch/history";
import type { Account } from "./launcher_resume";
import { type Preview, option as optionValue, preview as previewValue } from "./agent_launcher";
import { Provider } from "./providers";
import * as protocol from "./protocol";
export class Stream {
  socket = "";
  fd: Socket | null = null;
  input = "";
  cwd = "";
  workspace = 0;
  /** It asks for every account's reading, as Manage agents lists them all. */
  all = false;
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
  current(cwd: string, known: readonly (Account & { managed?: boolean })[] = []): Preview {
    if (!this.received && this.preview.accounts.length === 0 && known.length > 0)
      this.preview = {
        ...this.preview,
        accounts: known.map(a => ({ ...a, managed: a.managed ?? false, option: optionValue({ pending: true }) })),
      };
    if (cwd === this.cwd) return this.preview;
    // Provider and account visibility survives a directory change; model
    // settings don't.
    const result = previewValue();
    result.installed = { ...this.preview.installed };
    result.outdated = { ...this.preview.outdated };
    result.names = { ...this.preview.names };
    const inFolder = (option: Preview["options"][Provider]) =>
      optionValue({ ...option, pending: true, model: "", model_name: "", source: "" });
    for (const provider of Provider.all) result.options[provider] = inFolder(this.preview.options[provider]);
    result.accounts = this.preview.accounts.map(a => ({
      ...a,
      option: inFolder(a.option),
    }));
    return result;
  }
  pending(cwd: string) {
    if (cwd === this.cwd) this.preview.pending = true;
  }
  poll(workspace: number, cwd: string, all = false) {
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
    if (this.all !== all) {
      this.all = all;
      // The subscription takes it in place, keeping its readings and history;
      // a connection still opening subscribes with it.
      if (this.fd && !this.fd.connecting) this.subscribe(this.fd, workspace, cwd);
    }
    if (!this.fd && milliTimestamp() >= this.retry_at) {
      this.retry_at = milliTimestamp() + 1000;
      const connection = createConnection(this.socket);
      this.fd = connection;
      connection.once("connect", () => {
        this.subscribe(connection, workspace, cwd);
        connection.write(stringify(protocol.envelope("agent.history", { follow: true })) + "\n");
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
  private subscribe(connection: Socket, workspace: number, cwd: string) {
    connection.write(stringify(protocol.envelope("agent.subscribe", { workspace, cwd, all: this.all })) + "\n");
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
      const keep = (next: Preview["options"][Provider], old: Preview["options"][Provider] | undefined) =>
        next.pending === true && old ? { ...old, pending: true } : next;
      for (const provider of Provider.all)
        preview.options[provider] = keep(sent.options[provider], this.preview.options[provider]);
      preview.accounts = sent.accounts.map(a => ({
        ...a,
        option: keep(
          a.option,
          this.preview.accounts.find(old => old.provider === a.provider && old.account === a.account)?.option,
        ),
      }));
    }
    if (preview.pending && Provider.all.every(p => sent.options[p].pending === null)) {
      if (this.received) {
        preview = previewValue(parse(stringify(this.preview)));
        preview.pending = true;
        preview.installed = sent.installed;
        preview.outdated = sent.outdated;
      } else if (preview.accounts.length === 0) {
        // A folder's first read lists no accounts yet; keep the ones carried over.
        preview.accounts = this.preview.accounts;
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
