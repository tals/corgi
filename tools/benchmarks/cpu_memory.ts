/** One Linux memory snapshot after measurement and cadence checks, in KiB. */
import { readFileSync } from "node:fs";

export function read(pid: number) {
  const fields: Record<string, number> = {};
  for (const line of readFileSync(`/proc/${pid}/smaps_rollup`, "utf8").split("\n")) {
    const match =
      /^(Rss|Pss|Pss_Anon|Pss_File|Pss_Shmem|Shared_Clean|Shared_Dirty|Private_Clean|Private_Dirty|Swap):\s+(\d+) kB$/.exec(
        line,
      );
    if (match) fields[match[1]] = Number(match[2]);
  }
  return { pid, outside_cpu_window: true, kib: fields };
}
