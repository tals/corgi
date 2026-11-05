import { Provider, adapter } from "../providers";
import * as accounts from "../accounts";
import * as discovery from "../discovery";
import { Quit } from "../subprocess";
import { Option, compare } from "./models";
import { Failure } from "../failure";
import { getLogger } from "../log";
const log = getLogger("inference.models");
export const refresh_ms = 3 * 60 * 1000;
function membership(known: readonly accounts.Known[]): string {
  return JSON.stringify(known.map(a => [a.provider, a.dir, a.name]).sort());
}
export class Catalog {
  available: Option[] = [];
  loading = false;
  next = 0;
  private quit = new Quit();
  private failure = new Failure();
  private paused = false;
  private job: Promise<void> | null = null;
  private accounts_key: string | null = null;
  /** Every viewer and background request shares the same account-aware throttle. */
  refresh(): Promise<void> {
    const known = accounts.known(),
      key = membership(known);
    if (key !== this.accounts_key) {
      this.accounts_key = key;
      this.next = 0;
    }
    if (this.job) return this.job;
    if (this.paused || this.quit.aborted || Date.now() < this.next) return Promise.resolve();
    this.loading = true;
    this.job = this.read(known, key)
      .catch(() => {
        if (!this.quit.aborted && this.failure.changed("ModelsUnavailable")) log.warn("Model discovery failed");
      })
      .finally(() => {
        const changed = key !== membership(accounts.known());
        this.next = changed ? 0 : Date.now() + refresh_ms;
        this.loading = false;
        this.job = null;
        if (changed && !this.paused && !this.quit.aborted) return this.refresh();
      });
    return this.job;
  }
  private async read(known: readonly accounts.Known[], key: string) {
    await discovery.check();
    if (this.quit.aborted) return;
    const found: Option[] = [];
    let failed = false;
    for (const provider of Provider.all) {
      const read = adapter(provider).inference.models;
      if (!read || !discovery.installed(provider)) continue;
      for (const account of ["", ...known.filter(a => a.provider === provider).map(a => a.dir)]) {
        if (this.quit.aborted) return;
        try {
          for (const model of await read(account, this.quit))
            found.push(
              Object.assign(new Option(), {
                provider,
                model: model.id,
                name: model.name,
                account,
                account_name:
                  adapter(provider).inference.catalog === "native"
                    ? model.user || accounts.label(provider, account)
                    : [model.user, accounts.label(provider, account)].filter(Boolean).join(" · "),
                plan: model.plan ?? "",
                subscription: model.subscription,
                input_cost: model.input_cost,
                output_cost: model.output_cost,
                ready: model.ready ?? null,
              }),
            );
        } catch {
          failed = true;
          found.push(...this.available.filter(m => m.provider === provider && m.account === account));
        }
      }
    }
    if (this.quit.aborted || key !== membership(accounts.known())) return;
    this.available = found.sort(compare);
    if (failed && this.failure.changed("ModelsUnavailable")) log.warn("Model discovery failed");
    if (!failed) this.failure.clear();
  }
  async pause() {
    this.paused = true;
    this.quit.signal();
    await this.job;
    this.quit = new Quit();
  }
  resume() {
    this.paused = false;
  }
  close() {
    this.quit.signal();
  }
}
