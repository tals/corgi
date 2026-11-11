//! Daemon-owned guided sign-ins. A reconnect keeps the session; an abandoned
//! viewer's lease expires and discards unfinished account creation.
import * as accountLock from "./account_lock";
import * as signin from "./signin";
import * as accounts from "./accounts";
import * as surface from "./pane/surface";
import type { Provider } from "./providers";
import type * as protocol from "./protocol";

export type Result = { status: number; start: boolean; message: string };
export type Snapshot = {
  revision: number;
  cols: number;
  rows: number;
  provider: Provider | null;
  account: string;
  name: string | null;
  working: string | null;
  typing: boolean;
  drawn: signin.Drawn;
  child: surface.View | null;
  result: Result | null;
};
type Entry = {
  release: () => void;
  signin: signin.Signin;
  revision: number;
  input_seq: number;
  touched: number;
  result: Result | null;
};
export const lease_ms = 120_000;
export class Sessions {
  private entries = new Map<string, Entry>();
  private settling = new Set<Promise<void>>();
  constructor(
    private changed: () => void,
    private now = Date.now,
  ) {}
  get busy(): boolean {
    return this.settling.size > 0 || [...this.entries.values()].some(e => !e.signin.over);
  }
  open(q: protocol.RequestInput<"account.signin.open">): void {
    if (!/^[a-zA-Z0-9-]{16,64}$/.test(q.id)) throw Error("InvalidSignin");
    this.size(q.cols, q.rows);
    if (this.entries.has(q.id)) return;
    if (this.entries.size >= 16) throw Error("TooManySignins");
    const known = q.account ? accounts.find(q.provider, q.account) : null;
    if (!q.add && !known) throw Error("AccountNotFound");
    if (known && [...this.entries.values()].some(e => !e.signin.over && e.signin.dir === known.dir))
      throw Error("AccountInUse");
    let entry: Entry;
    const host: signin.Host = {
      staged: (provider, dir) => {
        entry.release = accountLock.take(provider, dir);
      },
      changed: () => {
        entry.revision++;
      },
      done: (status, start, message) => {
        this.settle(entry, () => {
          entry.result = { status, start, message };
          entry.revision++;
        });
      },
    };
    const s = q.add ? signin.adding(q.provider, null, host) : signin.signingIn(known!, host);
    s.cwd = q.cwd;
    const release = known ? accountLock.take(q.provider, known.dir) : () => {};
    entry = { release, signin: s, revision: 1, input_seq: 0, touched: this.now(), result: null };
    this.entries.set(q.id, entry);
    void s.open(q.cols, q.rows).catch(error => s.close(1, false, signin.problem(error)));
  }
  private size(cols: number, rows: number): void {
    if (cols < 1 || rows < 1 || cols > 1000 || rows > 1000) throw Error("InvalidSize");
  }
  async sync(q: protocol.Request<"account.signin.sync">): Promise<Snapshot | null> {
    const e = this.entries.get(q.id);
    if (!e) throw Error("SigninExpired");
    this.size(q.cols, q.rows);
    e.touched = this.now();
    const s = e.signin;
    if (s.cols !== q.cols || s.rows !== q.rows) s.resize(q.cols, q.rows);
    if (q.input_seq > e.input_seq) {
      if (q.input_seq !== e.input_seq + 1) throw Error("InvalidSigninSequence");
      e.input_seq = q.input_seq;
      if (q.x >= 0 && q.y >= 0) await s.click(q.x, q.y);
      else if (q.input) {
        const bytes = Buffer.from(q.input, "base64");
        if (bytes.length > 1024 * 1024) throw Error("InputTooLarge");
        if (q.raw) s.send(bytes);
        else await s.input(bytes);
      }
      e.revision++;
    }
    if (e.revision === q.revision) return null;
    const drawn = s.draw(0, 0);
    return {
      revision: e.revision,
      cols: s.cols,
      rows: s.rows,
      provider: s.provider,
      account: s.account,
      name: s.name,
      working: s.working,
      typing: s.typing,
      drawn,
      child: s.typing && s.child ? surface.captureView(0, s.child) : null,
      result: e.result,
    };
  }
  close(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.signin.abandon();
    this.entries.delete(id);
    this.settle(e);
  }
  private settle(e: Entry, done = () => {}): void {
    const jobs = [e.signin.finishing, e.signin.stopping].filter(p => p !== null);
    const complete = () => {
      e.release();
      done();
      this.changed();
    };
    if (!jobs.length) return complete();
    const pending = Promise.allSettled(jobs).then(() => {
      this.settling.delete(pending);
      complete();
    });
    this.settling.add(pending);
  }
  expire(): void {
    for (const [id, e] of this.entries) if (this.now() - e.touched >= lease_ms) this.close(id);
  }
  destroy(): void {
    for (const id of this.entries.keys()) this.close(id);
  }
}
