//! Keeps a slow link from queueing frames. A frame carries a status request,
//! which the host answers once it has drawn everything before it. While an
//! answer is late, frames wait, and the next one written carries all their
//! changes. Frames never wait on a host that keeps up.

/** Device status report; the host answers "ok". */
export const request = "\x1b[5n";
export const answer = "\x1b[0n";
/** How late an answer is before frames wait for it. */
const hold_after_ms = 500;
/** A request this old counts as lost, and the next frame asks again. */
const lost_after_ms = 5000;
/** How long a leaving viewer waits for the last answer, so it does not reach the shell. */
export const settle_ms = 500;

export class Pacer {
  /** When the unanswered request was written. */
  private asked: number | null = null;
  /** Hosts that never answer are never waited on. */
  private answers = false;
  /** What to write after a frame: a request, unless one is unanswered. */
  stamp(now: number): string {
    if (this.asked !== null) return "";
    this.asked = now;
    return request;
  }
  answered(): void {
    this.asked = null;
    this.answers = true;
  }
  /** Whether frames wait for the host's answer at `now`. */
  waiting(now: number): boolean {
    if (this.asked === null || !this.answers) return false;
    if (now - this.asked >= lost_after_ms) {
      this.asked = null;
      return false;
    }
    return now - this.asked >= hold_after_ms;
  }
  /** Whether an answer the host will send is still on its way. */
  unanswered(): boolean {
    return this.asked !== null && this.answers;
  }
}

/** Whether `bytes` holds nothing but answers, which are not typing. */
export function onlyAnswers(bytes: Uint8Array): boolean {
  const text = Buffer.from(bytes).toString("latin1");
  return text.length > 0 && text.replaceAll(answer, "") === "";
}
