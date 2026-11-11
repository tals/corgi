import type { View, Surface, InputReceipt } from "./pane/surface";
import type { Provider } from "./providers";
import * as composer from "./instant_composer";
import { Echo } from "./instant_echo";
import { Receipts } from "./instant_receipts";
import * as style from "./instant_style";
import * as telemetry from "./telemetry";

export type Target = Provider | "terminal";

export const timeout_ms = 750;
interface Pending {
  draft: composer.Draft;
  expires: number;
  sequence: number;
  uncertain: boolean;
}
type Stop = "input" | "mismatch" | "timeout";
type Status = Stop | "ready" | "predicting" | "layout" | "hidden" | "completion" | "unseeded";

/** A bounded draft journal, projected into a private Ghostty surface. Hiding the
 * projection never discards the journal, and confirmation never replays input. */
export class Prediction {
  sequence = 0;
  private receipts = new Receipts();
  private dim = false;
  private context = "";
  private provider: Target | null = null;
  private view: View | null = null;
  private base: composer.Draft | null = null;
  private pending: Pending[] = [];
  private past: composer.Draft[] = [];
  private base_expires = 0;
  private lagging = false;
  private completion = false;
  private submitted: { sequence: number; expires: number } | null = null;
  private stopped: Stop | null = null;
  private ready = false;
  private status: Status = "unseeded";
  private shape: composer.Composer | null = null;
  private output: Surface | null = null;
  private composer_seen = false;
  private echo = new Echo(() => this.budget());

  constructor(private readonly budget: () => number = () => timeout_ms) {}

  configure(provider: Target | null, context = "", dim = false): void {
    if (dim !== this.dim) {
      this.dim = dim;
      this.echo.shade(dim);
      this.refresh(performance.now());
    }
    if (provider === this.provider && context === this.context) return;
    // Identity can arrive after an idle screen. Discard old speculation,
    // then inspect the last authoritative surface with the new provider.
    const view = this.view;
    this.reset();
    this.view = null;
    this.provider = provider;
    this.composer_seen = false;
    this.echo = new Echo(() => this.budget());
    this.echo.shade(dim);
    this.context = context;
    if (view) this.receive(view);
  }
  reset(): void {
    this.echo.reset();
    this.base = null;
    this.pending = [];
    this.past = [];
    this.base_expires = 0;
    this.lagging = false;
    this.completion = false;
    this.submitted = null;
    this.stopped = null;
    this.output = null;
    this.ready = false;
  }
  delivered(through: number, receipt: InputReceipt): void {
    this.receipts.delivered(through, receipt);
    // Generic echo uses the daemon's settling heuristic. A recognized editor
    // can draw later than that timer, so only its pixels confirm draft progress.
    if (this.view && !this.composer_seen) this.echo.receive(this.view, performance.now(), this.receipts.through);
  }
  receive(view: View, now = performance.now()): void {
    this.surface(now);
    this.receipts.receive(view.input_ack);
    const changed =
      !this.view ||
      view.stamp.revision !== this.view.stamp.revision ||
      view.stamp.identity !== this.view.stamp.identity;
    if (this.view && this.view.stamp.identity !== view.stamp.identity) this.reset();
    this.view = view;
    this.shape =
      this.provider && this.provider !== "terminal" && view.stamp.offset === null
        ? composer.inspect(view.surface, this.provider)
        : null;
    if (this.shape) {
      this.composer_seen = true;
      this.echo.reset();
    }
    if (this.provider && !this.composer_seen) {
      this.echo.receive(view, now, this.receipts.through);
      return;
    }
    if (view.stamp.offset !== null) {
      this.reset();
      return;
    }
    if (!this.shape) {
      this.output = null;
      this.report("hidden");
      return;
    }
    this.lagging = false;
    // A cleared box after a Return typed from an empty one looks like the
    // start; an acknowledged Return says it's the end.
    if (
      this.submitted &&
      this.pending.length &&
      this.base?.text === "" &&
      this.receipts.through >= this.submitted.sequence &&
      composer.matches(this.shape, this.base)
    )
      this.recover();
    else if (this.base) {
      const candidates = [this.base, ...this.pending.map(p => p.draft)];
      const matches = candidates.flatMap((draft, i) => (composer.matches(this.shape!, draft) ? [i] : []));
      if (matches.length) {
        // Ambiguous pixels only confirm the common prefix. A delivery receipt
        // is not evidence that the app has processed or rendered those keys.
        let index = matches[0];
        if (this.expired(now) && matches.every(i => same(candidates[i], candidates[matches.at(-1)!])))
          index = matches.at(-1)!;
        if (index > 0) {
          this.past.push(this.base, ...this.pending.slice(0, index - 1).map(p => p.draft));
          this.past = this.past.slice(-128);
          this.base = this.pending[index - 1].draft;
          this.base_expires = this.pending[index - 1].expires;
          this.pending.splice(0, index);
          this.completion = !composer.predictable(this.base);
        }
        this.ready = true;
        if (!this.pending.some(p => p.uncertain) && !this.expired(now)) this.stopped = null;
      } else if (
        !this.stopped &&
        this.past.some(draft => composer.matches(this.shape!, draft)) &&
        now < (this.pending[0]?.expires ?? this.base_expires)
      ) {
        // Keep a confirmed later state visible through an intermediate redraw.
        this.lagging = true;
      } else {
        const wasStopped = this.stopped !== null;
        this.stopped = "mismatch";
        // Unknown edits may change the draft. Once the outstanding journal has
        // timed out, reacquire a recognizable document instead of staying dead.
        if (this.submitted || !this.pending.length || (wasStopped && changed && now >= this.pending.at(-1)!.expires)) {
          this.recover();
        }
      }
    } else if (changed) {
      this.recover();
    }
    this.refresh(now);
  }
  input(bytes: string | Uint8Array | number[], now = performance.now()): void {
    const data = composer.input(typeof bytes === "string" ? bytes : Buffer.from(bytes).toString());
    if (/^[\x20-\x7e]{2,}$/.test(data)) {
      for (const character of data) this.input(character, now);
      return;
    }
    const sequence = ++this.sequence;
    if (!this.provider || !this.view) return;
    if (!this.composer_seen) {
      this.echo.input(data, now, sequence);
      return;
    }
    this.refresh(now);
    if (data === "\x03") {
      this.reset();
      return;
    }
    this.unsubmit(now);
    if (this.submitted) return;
    if (!this.ready || !this.base) return;
    if (data === "\r") {
      this.submitted = { sequence, expires: now + this.budget() };
      return;
    }
    const previous = this.pending.at(-1)?.draft ?? this.base;
    const draft = composer.edit(previous, data, true, this.shape ?? undefined);
    if (this.pending.length >= 128) {
      this.reset();
      telemetry.count("prediction.capacity");
      return;
    }
    if (!draft) this.stopped = "input";
    if (draft && !composer.predictable(draft)) this.completion = true;
    // Known no-ops need no new confirmation. Unknown input is a barrier: later
    // typing is tentative until its own echo proves which document was edited.
    if (draft && same(draft, previous)) return;
    this.pending.push({ draft: draft ?? previous, expires: now + this.budget(), sequence, uncertain: !draft });
    this.refresh(now);
  }
  surface(now = performance.now()): Surface | null {
    if (this.provider && !this.composer_seen) return this.echo.surface(now);
    if (this.expired(now)) {
      this.stopped = "timeout";
      this.output = null;
      this.report("timeout");
      this.unsubmit(now);
    }
    return this.output;
  }
  /** A Return the agent never acted on stops holding later typing. */
  private unsubmit(now: number): void {
    if (this.submitted && now >= this.submitted.expires) this.recover();
  }
  private recover(): void {
    if (!this.shape) return;
    const known = [...this.past, ...(this.base ? [this.base] : []), ...this.pending.map(p => p.draft)];
    const drafts = known.flatMap(draft => {
      const found = composer.locate(this.shape!, draft.text);
      return found ? [found] : [];
    });
    const recovered =
      drafts.length && drafts.every(draft => same(draft, drafts[0])) ? drafts[0] : composer.seed(this.shape);
    this.base = recovered;
    this.pending = [];
    this.past = [];
    this.submitted = null;
    this.stopped = null;
    this.lagging = false;
    this.ready = recovered !== null;
    this.completion = recovered !== null && !composer.predictable(recovered);
  }
  private refresh(now: number): void {
    if (this.expired(now)) this.stopped = "timeout";
    const draft = this.pending.at(-1)?.draft ?? (this.lagging ? this.base : null);
    let status: Status = this.stopped ?? (!this.ready ? "unseeded" : !this.shape ? "hidden" : "ready");
    this.output = null;
    if (!this.stopped && this.shape && draft) {
      if (this.completion || !composer.predictable(draft)) status = "completion";
      else {
        this.output = composer.project(this.shape, draft);
        status = this.output ? "predicting" : "layout";
      }
    }
    this.report(status);
    if (this.dim && this.output && this.shape && this.base && draft) {
      // Only what this draft adds to the confirmed one, wherever the box moved.
      const { start, end } = style.changed(this.base.text, draft.text);
      const layout = composer.wrap(draft, this.shape.width, this.shape.provider);
      const top = this.output.cursor!.y - layout.cursor.y;
      this.output = style.dim(
        this.output,
        layout.starts.map((at, i) => ({
          y: top + i,
          start: 2 + Math.max(0, start - at),
          end: 2 + Math.min(layout.lines[i].length, end - at),
        })),
      );
    }
  }
  private report(status: Status): void {
    if (status === this.status) return;
    this.status = status;
    telemetry.event(`prediction.${status}`, {
      pane: this.view?.surface.pane ?? 0,
      provider: this.provider ?? "off",
      sequence: this.sequence,
      delivered: this.receipts.through,
      pending: this.pending.length,
      width: this.shape?.width ?? 0,
      height: this.shape?.height ?? 0,
      x: this.shape?.cursor.x ?? -1,
      y: this.shape?.cursor.y ?? -1,
    });
  }
  private expired(now: number): boolean {
    return (
      (this.pending.length > 0 && now >= this.pending[0].expires) ||
      (this.submitted !== null && now >= this.submitted.expires) ||
      (this.lagging && !this.pending.length && now >= this.base_expires)
    );
  }
}

function same(a: composer.Draft, b: composer.Draft): boolean {
  return a.text === b.text && a.cursor === b.cursor;
}
