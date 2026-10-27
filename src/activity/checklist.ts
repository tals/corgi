//! A provider's checklist as Corgi keeps it: always the whole list, stamped
//! with when it was true. Providers that edit one item at a time fold their
//! edits into a whole list before handing it over.
import { truncateUtf8 } from "../bounded_text";

export const statuses = ["pending", "active", "blocked", "done", "dropped"] as const;
export type Status = (typeof statuses)[number];
/** `group` names the run of items it heads, such as an omp phase; "" when the provider has none. */
export type Item = { text: string; status: Status; group: string };
export const max_items = 64,
  text_bytes = 512,
  group_bytes = 160;

function label(value: string, limit: number): string {
  const clean = value
    .slice(0, limit * 8)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/[\p{Cc}\p{Cf}\s]+/gu, " ")
    .trim();
  return truncateUtf8(clean, limit).trim();
}

export class List {
  /** `partial` when items may be missing. `at` is when the list was true,
   * in µs, or 0 when its source can't say. */
  constructor(
    readonly items: readonly Item[] = [],
    readonly partial = false,
    readonly at = 0,
  ) {}
  /** A list of provider text: cleans labels and bounds the inventory. */
  static of(items: { text: string; status: Status; group?: string }[], partial = false, at = 0): List {
    const kept: Item[] = [];
    for (const item of items) {
      const text = label(item.text, text_bytes);
      if (!text) continue;
      if (kept.length === max_items) {
        partial = true;
        break;
      }
      kept.push({ text, status: item.status, group: label(item.group ?? "", group_bytes) });
    }
    return new List(kept, partial, at);
  }
  /** This list, timed from `at` when its source gave no time. */
  stamped(at: number): List {
    return this.at ? this : new List(this.items, this.partial, at);
  }
}
