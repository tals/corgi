export class Passes {
  done = 0n;
  wanted = 0n;
  next() {
    this.done = BigInt.asUintN(64, this.done + 1n);
    return this.done < this.wanted;
  }
  request() {
    if (this.wanted < this.done + 2n) this.wanted = this.done + 2n;
    return this.wanted;
  }
}
export function settle(worker: { passes: Passes; wake: { signal(): void } }) {
  const target = worker.passes.request();
  worker.wake.signal();
  return target;
}
export function reached(worker: { passes: Passes }, target: bigint) {
  return worker.passes.done >= target;
}
