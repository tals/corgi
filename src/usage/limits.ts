import { Locked } from "./account_cache";
import type { Info } from "./account";
import type { Provider } from "../providers";
import type { Window } from "./account";
export const cells = 11;
export type Spark = Array<number | null>;
export const none = () =>
  [Array(cells).fill(null), Array(cells).fill(null)] as [Spark, Spark];
export class State {
  tracks = Array.from({ length: 2 }, () => ({
    minutes: 0,
    reset_at: 0,
    spark: Array(cells).fill(null) as Spark,
  }));
  find(minutes: number) {
    return (
      this.tracks.find((t) => t.minutes === minutes) ??
      this.tracks.find((t) => t.minutes === 0) ??
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
      if (!w || w.minutes === null || w.reset_at === null || w.minutes <= 0)
        return;
      const span = w.minutes * 60;
      let track = this.find(w.minutes);
      if (Math.abs(track.reset_at - w.reset_at) * cells > span) {
        track.minutes = w.minutes;
        track.reset_at = w.reset_at;
        track.spark = Array(cells).fill(null);
      }
      const start = track.reset_at - span;
      if (at >= start && at < track.reset_at)
        track.spark[Math.floor(((at - start) * cells) / span)] = w.used;
      result[i] = [...track.spark];
    });
    return result;
  }
}

const Store = Locked(() => new State(), "limit-history");
export async function update(
  provider: Provider,
  info: Info,
  stopping: any = false,
): Promise<[Spark, Spark]> {
  if (typeof info.limits !== "object" || info.usage_fetched_at <= 0)
    return none();
  try {
    const file = await Store.open(provider, info.account.text(), stopping);
    try {
      const before = JSON.stringify(file.state);
      const result = file.state.record(
        info.limits.windows,
        info.usage_fetched_at,
      );
      if (JSON.stringify(file.state) !== before) await file.save();
      return result;
    } finally {
      file.close();
    }
  } catch {
    return none();
  }
}
