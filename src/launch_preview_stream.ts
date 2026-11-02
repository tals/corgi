import { parse, stringify } from "./json";
import { milliTimestamp } from "./clock";
import type { History, Entry } from "./launch/history";
import type { Account } from "./launcher_resume";
import { type Preview, option as optionValue, preview as previewValue } from "./agent_launcher";
import { Provider } from "./providers";
import { call, type Transport } from "./mirror";
export class Stream {
  private connection: Transport | null = null;
  private unsubscribe: (() => void) | null = null;
  private subscribed = false;
  private subscribing = false;
  private history_asked = false;
  private preview_revision = 0;
  changedEvent: () => void = () => {};
  cwd = "";
  workspace = 0;
  preview: Preview = previewValue();
  received = false;
  retry_at = 0;
  history: History = { pending: true, entries: [] };
  changed = false;
  connect(connection: Transport) {
    this.disconnect();
    this.connection = connection;
    this.unsubscribe =
      connection.onEvent?.(event => {
        if (this.receive(event)) {
          this.changed = true;
          this.changedEvent();
        }
      }) ?? null;
  }
  disconnect() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.connection = null;
    this.subscribed = false;
    this.history_asked = false;
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
  poll(workspace: number, cwd: string) {
    if (!this.connection) return false;
    if (this.workspace !== workspace || this.cwd !== cwd) {
      const initial = this.current(cwd);
      this.cwd = cwd;
      this.workspace = workspace;
      this.preview = initial;
      this.received = false;
      this.subscribed = false;
      this.retry_at = 0;
      this.changed = true;
    }
    if (!this.subscribed && !this.subscribing && milliTimestamp() >= this.retry_at) {
      this.retry_at = milliTimestamp() + 1000;
      this.subscribing = true;
      void this.subscribe(this.connection, workspace, cwd).finally(() => {
        this.subscribing = false;
      });
    }
    const changed = this.changed;
    this.changed = false;
    return changed;
  }
  private async subscribe(connection: Transport, workspace: number, cwd: string) {
    try {
      const revision = this.preview_revision;
      const preview = await call(connection, "agent.subscribe", { workspace, cwd });
      if (this.connection !== connection) return;
      // A pushed update in the same socket read can precede this continuation.
      if (this.preview_revision === revision) this.changed = this.receive(preview) || this.changed;
      if (!this.history_asked) {
        await call(connection, "agent.history", { follow: true });
        if (this.connection !== connection) return;
        this.history_asked = true;
      }
      this.subscribed = this.workspace === workspace && this.cwd === cwd;
      this.changedEvent();
    } catch {
      // Retry on the shared connection after a transient daemon failure.
    }
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
    this.preview_revision++;
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
