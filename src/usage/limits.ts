import { Locked } from "./account_cache";
import type { Info } from "./account";
import type { Provider } from "../providers";
import type { Window } from "./account";
import type { Reading } from "./spend";
export const cells = 14;
/** Days in each cell of the spend spark, which covers the last four weeks. */
export const spend_days = 2;
const day = 86400;
export type Spark = Array<number | null>;
export const none = () => [Array(cells).fill(null), Array(cells).fill(null)] as [Spark, Spark];
/** The month's spend at the last reading in a cell's days, in the reading's
 * minor units; null when Corgi read none of them. `earlier` when the cell
 * ends before the current month began. */
export type SpendCell = { minor: number | null; earlier: boolean };
export const noSpend = (): SpendCell[] => Array.from({ length: cells }, () => ({ minor: null, earlier: false }));
/** A preview's spend cells, or none for an older one without them. */
export function spendCells(value: unknown): SpendCell[] {
  const sent = Array.isArray(value) ? value : [];
  return noSpend().map((empty, i) => {
    const cell = sent[i];
    if (!cell || typeof cell !== "object") return empty;
    const minor = cell.minor;
    return {
      minor: typeof minor === "number" && Number.isFinite(minor) && minor >= 0 ? minor : null,
      earlier: cell.earlier === true,
    };
  });
}
/** A UTC day's last spend reading: the day, its period's start and the spend. */
type Daily = [number, number, number];
export class State {
  tracks = Array.from({ length: 2 }, () => ({
    minutes: 0,
    reset_at: 0,
    spark: Array(cells).fill(null) as Spark,
  }));
  spend: Daily[] = [];
  find(minutes: number) {
    return (
      this.tracks.find(t => t.minutes === minutes) ??
      this.tracks.find(t => t.minutes === 0) ??
      ((this.tracks[1] = this.tracks[0]),
      (this.tracks[0] = {
        minutes: 0,
        reset_at: 0,
        spark: Array(cells).fill(null),
      }))
    );
  }
  record(windows: [Window | null, Window | null], at: number) {
    const result = none();
    windows.forEach((w, i) => {
      if (!w || w.minutes === null || w.reset_at === null || w.minutes <= 0) return;
      const span = w.minutes * 60;
      let track = this.find(w.minutes);
      if (Math.abs(track.reset_at - w.reset_at) * cells > span) {
        track.minutes = w.minutes;
        track.reset_at = w.reset_at;
        track.spark = Array(cells).fill(null);
      }
      const start = track.reset_at - span;
      if (at >= start && at < track.reset_at) track.spark[Math.floor(((at - start) * cells) / span)] = w.used;
      result[i] = [...track.spark];
    });
    return result;
  }
  /** Keeps each day's last reading, for about the last month. */
  recordSpend(reading: Reading, at: number) {
    const today = Math.floor(at / day),
      entry: Daily = [today, reading.period_start, reading.used_minor],
      last = this.spend.at(-1);
    if (last && last[0] > today) return;
    if (last && last[0] === today) this.spend[this.spend.length - 1] = entry;
    else this.spend.push(entry);
    this.spend = this.spend.filter(([d]) => d > today - cells * spend_days - 4);
  }
  /** The last four weeks of the month's running spend in two-day cells,
   * paired from the current month's first day so its start falls between
   * cells. Each cell holds its last day's reading. */
  spendCells(reading: Reading, now: number): SpendCell[] {
    const today = Math.floor(now / day),
      first = Math.floor(reading.period_start / day),
      current = first + Math.floor((today - first) / spend_days) * spend_days;
    return Array.from({ length: cells }, (_, i) => {
      const from = current - (cells - 1 - i) * spend_days,
        last = this.spend.findLast(([d]) => d >= from && d < from + spend_days);
      return { minor: last?.[2] ?? null, earlier: from + spend_days <= first };
    });
  }
}
/** Readings an older Corgi kept in eleven cells go to the last of the cells
 * now covering the same time. */
function resample(spark: unknown): Spark {
  const old = Array.isArray(spark) ? spark : [],
    result: Spark = Array(cells).fill(null);
  old.forEach((value, i) => {
    if (typeof value !== "number") return;
    const at = old.length === cells ? i : Math.min(cells - 1, Math.ceil(((i + 1) * cells) / old.length) - 1);
    result[at] = value;
  });
  return result;
}
function restore(value: any): State {
  const state = new State();
  if (Array.isArray(value?.tracks) && value.tracks.length === 2)
    state.tracks = value.tracks.map((t: any) => ({
      minutes: Number.isSafeInteger(t?.minutes) ? t.minutes : 0,
      reset_at: Number.isSafeInteger(t?.reset_at) ? t.reset_at : 0,
      spark: resample(t?.spark),
    }));
  if (Array.isArray(value?.spend))
    state.spend = value.spend.filter(
      (entry: unknown): entry is Daily =>
        Array.isArray(entry) && entry.length === 3 && entry.every(n => Number.isSafeInteger(n) && n >= 0),
    );
  return state;
}

const Store = Locked(() => new State(), "limit-history", restore);
const fresh = (state: State) => state.spend.length === 0 && state.tracks.every(t => t.minutes === 0);
/** Records `info`'s reading in its login's history and returns the sparks.
 * `login` names whoever signed in, so folders signed in to one account share
 * a history and two workspaces of one email keep theirs apart. */
export async function update(
  provider: Provider,
  login: string,
  info: Info,
  stopping: any = false,
): Promise<{ sparks: [Spark, Spark]; spend: SpendCell[] }> {
  const empty = { sparks: none(), spend: noSpend() },
    windows = typeof info.limits === "object" ? info.limits.windows : null;
  if (info.usage_fetched_at <= 0 || (windows === null && info.spend === null)) return empty;
  try {
    const file = await Store.open(provider, login, stopping);
    try {
      const before = JSON.stringify(file.state);
      // Corgi used to keep one history per email.
      if (fresh(file.state) && info.account.len && info.account.text() !== login) {
        const old = await Store.open(provider, info.account.text(), stopping);
        try {
          file.state.tracks = old.state.tracks;
        } finally {
          old.close();
        }
      }
      const sparks = windows ? file.state.record(windows, info.usage_fetched_at) : none();
      if (info.spend) file.state.recordSpend(info.spend, info.usage_fetched_at);
      if (JSON.stringify(file.state) !== before) await file.save();
      return { sparks, spend: info.spend ? file.state.spendCells(info.spend, info.usage_fetched_at) : noSpend() };
    } finally {
      file.close();
    }
  } catch {
    return empty;
  }
}
