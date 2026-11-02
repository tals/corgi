import * as resources from "./trackers/resource_os";
import * as os from "./os";

export const memory_limit = 128n * 1024n * 1024n;
export const process_limit = 8;
const burst_ns = 1_000_000_000;

/** One second of CPU burst, replenished at 10% of one core. */
export class Budget {
  private credit = burst_ns;
  private previous = new Map<number, resources.Counters>();
  constructor(private at = performance.now()) {}
  check(samples: Map<number, resources.Counters>, now = performance.now()): string | null {
    if (samples.size > process_limit) return "ProcessLimit";
    let memory = 0n,
      cpu = 0n;
    for (const [pid, sample] of samples) {
      memory += sample.memory;
      const previous = this.previous.get(pid);
      const used = sample.cpu_ns - (previous?.start === sample.start ? previous.cpu_ns : 0n);
      if (used > 0n) cpu += used;
    }
    this.credit = Math.min(burst_ns, this.credit + Math.max(0, now - this.at) * 100_000) - Number(cpu);
    this.at = now;
    this.previous = samples;
    if (memory > memory_limit) return "MemoryLimit";
    return this.credit < 0 ? "CpuLimit" : null;
  }
}

/** Linux walks only this tree; macOS uses the existing native inventory. */
export function sample(root: number): Map<number, resources.Counters> {
  let pids = os.processTree([root], process_limit + 1);
  if (!pids) {
    const inventory = resources.inventory().items;
    pids = [root];
    for (let i = 0; i < pids.length && pids.length <= process_limit; i++)
      for (const p of inventory)
        if (p.parent === pids[i] && !pids.includes(p.pid)) {
          pids.push(p.pid);
          if (pids.length > process_limit) break;
        }
  }
  const samples = new Map<number, resources.Counters>();
  for (const pid of pids) {
    const counters = resources.counters(pid);
    if (counters) samples.set(pid, counters);
  }
  return samples;
}
