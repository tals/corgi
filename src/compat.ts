// Event-loop tasks yield promises instead of blocking an OS condition variable.
export class Condition {
  private waiters = new Set<() => void>();
  signal() {
    this.waiters.values().next().value?.();
  }
  broadcast() {
    for (const wake of [...this.waiters]) wake();
  }
  wait(timeout_ms?: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wake = () => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        resolve();
      };
      this.waiters.add(wake);
      if (timeout_ms !== undefined)
        timer = setTimeout(() => {
          this.waiters.delete(wake);
          reject(Error("Timeout"));
        }, timeout_ms);
    });
  }
}
export const timedWait = (condition: Condition, ns: number | bigint) => condition.wait(Number(ns) / 1e6);
