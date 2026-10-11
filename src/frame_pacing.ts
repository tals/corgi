//! Keeps a slow link from queueing frames. A frame carries a status request,
//! which the host answers once it has drawn everything before it. While an
//! answer is late, frames wait, and the next one written carries all their
//! changes. Frames never wait on a host that keeps up.

/** Device status report; the host answers "ok". */
export const request = "\x1b[5n";
export const answer = "\x1b[0n";
/** How late an answer is before frames wait for it. */
export const hold_after_ms = 500;
/** A request this old counts as lost, and the next frame asks again. */
const lost_after_ms = 5000;
/** How long a leaving viewer waits for the last answer, so it does not reach the shell. */
export const settle_ms = 500;
/** Answer times are kept per column this wide, for Terminal capabilities' chart. */
export const column_ms = 2000;
/** Four minutes of columns. */
const columns_kept = 120;
/** Each answer's weight in the running mean and variance, as TCP's SRTT. */
const weight = 1 / 8;

/** How long the host takes to answer, in ms. */
export interface Timing {
  mean: number;
  sd: number;
}
/** The timing at a column's last answer, and whether a request was lost in it. */
export interface Column {
  /** `now / column_ms`, rounded down. */
  at: number;
  timing: Timing | null;
  lost: boolean;
}

export class Pacer {
  /** When the unanswered request was written. */
  private asked: number | null = null;
  /** Hosts that never answer are never waited on. */
  private answers = false;
  timing: Timing | null = null;
  private variance = 0;
  /** Recent columns with an answer or a loss, oldest first. */
  columns: Column[] = [];
  /** Answers late enough to hold frames, and the slowest of all. */
  late = 0;
  slowest = 0;
  lost = 0;
  /** What to write after a frame: a request, unless one is unanswered. */
  stamp(now: number): string {
    if (this.asked !== null) return "";
    this.asked = now;
    return request;
  }
  answered(now: number): void {
    if (this.asked !== null) this.measure(now - this.asked, now);
    this.asked = null;
    this.answers = true;
  }
  /** Whether frames wait for the host's answer at `now`. */
  waiting(now: number): boolean {
    if (this.asked === null || !this.answers) return false;
    if (now - this.asked >= lost_after_ms) {
      this.asked = null;
      this.lost++;
      this.column(now).lost = true;
      return false;
    }
    return now - this.asked >= hold_after_ms;
  }
  /** Whether an answer the host will send is still on its way. */
  unanswered(): boolean {
    return this.asked !== null && this.answers;
  }
  private measure(ms: number, now: number) {
    if (this.timing === null) this.timing = { mean: ms, sd: 0 };
    else {
      const diff = ms - this.timing.mean,
        step = weight * diff;
      this.variance = (1 - weight) * (this.variance + diff * step);
      this.timing = { mean: this.timing.mean + step, sd: Math.sqrt(this.variance) };
    }
    if (ms >= hold_after_ms) this.late++;
    this.slowest = Math.max(this.slowest, ms);
    this.column(now).timing = this.timing;
  }
  private column(now: number): Column {
    const at = Math.floor(now / column_ms),
      last = this.columns.at(-1);
    if (last?.at === at) return last;
    const column: Column = { at, timing: null, lost: false };
    this.columns.push(column);
    if (this.columns.length > columns_kept) this.columns.shift();
    return column;
  }
}

/** Whether `bytes` holds nothing but answers, which are not typing. */
export function onlyAnswers(bytes: Uint8Array): boolean {
  const text = Buffer.from(bytes).toString("latin1");
  return text.length > 0 && text.replaceAll(answer, "") === "";
}
