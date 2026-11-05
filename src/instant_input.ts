import type { View, Surface } from "./pane/surface";
import type { Provider } from "./providers";
import * as composer from "./instant_composer";

export const timeout_ms = 750;
interface Pending {
  draft: composer.Draft;
  at: number;
}

/** Bounded visual speculation. Neither a frame nor an RPC receipt can replay a key. */
export class Prediction {
  private context = "";
  private provider: Provider | null = null;
  private view: View | null = null;
  private base: composer.Draft | null = null;
  private pending: Pending[] = [];
  private paused = false;
  private blocked = false;
  private shape: composer.Composer | null = null;
  private output: Surface | null = null;

  configure(provider: Provider | null, context = ""): void {
    if (provider === this.provider && context === this.context) return;
    const view = context === this.context ? this.view : null;
    this.reset();
    this.view = null;
    this.provider = provider;
    this.context = context;
    if (view) this.receive(view);
  }
  reset(): void {
    this.base = null;
    this.pending = [];
    this.paused = false;
    this.output = null;
    this.blocked = true;
  }
  receive(view: View, now = performance.now()): void {
    this.surface(now);
    const changed =
      !this.view ||
      view.stamp.revision !== this.view.stamp.revision ||
      view.stamp.identity !== this.view.stamp.identity;
    if (
      this.view &&
      (this.view.stamp.identity !== view.stamp.identity ||
        this.view.surface.cols !== view.surface.cols ||
        this.view.surface.rows !== view.surface.rows)
    )
      this.reset();
    this.view = view;
    this.shape = this.provider && view.stamp.offset === null ? composer.inspect(view.surface, this.provider) : null;
    if (!this.shape) {
      // A completion popup may temporarily cover the box. Keep the bounded draft
      // history for matching when it closes, but never draw over the popup.
      if (this.pending.length && view.stamp.offset === null) this.paused = true;
      else this.reset();
      this.output = null;
      return;
    }
    if (this.pending.length) {
      const candidates = [this.base!, ...this.pending.map(p => p.draft)];
      const matches = candidates.flatMap((draft, i) => (composer.matches(this.shape!, draft) ? [i] : []));
      if (matches.length !== 1) {
        // Repeated pixels cannot confirm an offset. Keep the bounded history
        // until a later edit disambiguates it, showing only remote output meanwhile.
        if (matches.length > 1) this.paused = true;
        else this.reset();
        this.output = null;
        return;
      }
      const index = matches[0];
      if (index > 0) {
        this.base = this.pending[index - 1].draft;
        this.pending.splice(0, index);
        this.paused = !composer.predictable(this.base);
      }
    } else if (changed) {
      this.blocked = false;
      if (!this.base || !composer.matches(this.shape, this.base)) {
        this.base = composer.seed(this.shape);
      }
      this.paused = this.base !== null && !composer.predictable(this.base);
    }
    this.refresh(now);
  }
  input(bytes: string | Uint8Array | number[], now = performance.now()): void {
    if (!this.provider || !this.view) return;
    this.refresh(now);
    if (this.blocked) return;
    this.base ??= this.shape ? composer.seed(this.shape) : null;
    if (!this.base) return;
    const data = typeof bytes === "string" ? bytes : Buffer.from(bytes).toString();
    const previous = this.pending.at(-1)?.draft ?? this.base;
    const draft = composer.edit(previous, data);
    if (!draft || this.pending.length >= 128) {
      this.reset();
      return;
    }
    // No-op boundary movement must not create a second identical confirmation.
    if (draft.text === previous.text && draft.cursor === previous.cursor) return;
    this.pending.push({ draft, at: now });
    if (!composer.predictable(draft)) this.paused = true;
    this.refresh(now);
  }
  surface(now = performance.now()): Surface | null {
    if (this.pending.length && now - this.pending[0].at >= timeout_ms) this.reset();
    return this.output;
  }
  private refresh(now: number): void {
    if (this.pending.length && now - this.pending[0].at >= timeout_ms) this.reset();
    const draft = this.pending.at(-1)?.draft;
    this.output = !this.paused && this.shape && draft ? composer.project(this.shape, draft) : null;
  }
}
