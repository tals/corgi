/** Sequence receipts for the visible streaming fixture, sampled outside CPU windows. */
export function sequence(screen: string): number | null {
  let latest: number | null = null;
  for (const match of screen.matchAll(/Working \(esc to interrupt\) (\d+)/g)) {
    const value = Number(match[1]);
    if (Number.isSafeInteger(value)) latest = Math.max(latest ?? 0, value);
  }
  return latest;
}
export function reading(before: number | null, after: number | null, source: number | null, seconds: number) {
  const delta = before !== null && after !== null ? after - before : null;
  return {
    visible_before: before,
    visible_after: after,
    source_after: source,
    visible_delta: delta,
    visible_lines_per_second: delta === null ? null : delta / seconds,
    source_minus_visible: source !== null && after !== null ? source - after : null,
  };
}
export function validate(progress: ReturnType<typeof reading>) {
  const rate = progress.visible_lines_per_second,
    lag = progress.source_minus_visible;
  if (rate === null || lag === null) throw Error("Missing visible/source streaming sequence");
  // Requested cadence is 20 Hz; allow timer jitter while rejecting a stalled/throttled viewer.
  if (rate < 12 || rate > 26) throw Error(`Unexpected visible progress: ${rate.toFixed(2)} lines/s`);
  if (lag < 0 || lag > 10) throw Error(`Visible streaming output trails source by ${lag} lines`);
}

export type Sample = { at_ms: number; sequence: number | null };
export function cadence(samples: Sample[]) {
  if (samples.length < 2) throw Error("A cadence trace needs two samples");
  const start = samples[0].at_ms,
    seconds = (samples.at(-1)!.at_ms - start) / 1000;
  if (!(seconds > 0)) throw Error("A cadence trace needs positive duration");
  let previous = samples[0].sequence,
    previousAt = start,
    changedAt = start,
    changes = 0,
    maxGap = 0;
  for (const sample of samples.slice(1)) {
    if (sample.at_ms < previousAt) throw Error("Cadence samples must be ordered");
    previousAt = sample.at_ms;
    maxGap = Math.max(maxGap, sample.at_ms - changedAt);
    if (sample.sequence !== null && (previous === null || sample.sequence > previous)) {
      if (previous !== null) changes++;
      previous = sample.sequence;
      changedAt = sample.at_ms;
    }
  }
  return {
    seconds,
    visible_changes: changes,
    visible_changes_per_second: changes / seconds,
    max_observed_gap_ms: maxGap,
  };
}
export function validateCadence(value: ReturnType<typeof cadence>) {
  if (value.visible_changes_per_second < 12)
    throw Error(`Visible streaming sequence changes only ${value.visible_changes_per_second.toFixed(2)} times/s`);
  if (value.max_observed_gap_ms > 250)
    throw Error(`Visible streaming sequence stayed unchanged for ${value.max_observed_gap_ms.toFixed(1)} ms`);
}
export type Spinner = { row: number; column: number; glyph: string };
export type AnimationSample = { at_ms: number; spinners: Spinner[] };
/** The working glyph occupies the first few sidebar cells, outside pane output. */
export function spinners(screen: string): Spinner[] {
  const lines = screen.split("\n"),
    first = lines.findIndex(line => line.includes("agents:")),
    found: Spinner[] = [];
  if (first < 0) return found;
  for (let row = first + 1; row < lines.length; row++) {
    const cells = [...lines[row]].slice(0, 8);
    const column = cells.findIndex(cell => "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏".includes(cell));
    if (column >= 0) found.push({ row, column, glyph: cells[column] });
  }
  return found;
}
export function animationCadence(samples: AnimationSample[]) {
  let last = "",
    sequence = 0;
  const positions = (sample: AnimationSample) => sample.spinners.map(cell => `${cell.row}:${cell.column}`).join(","),
    first = samples[0] ? positions(samples[0]) : "",
    trace = samples.map(sample => {
      const glyphs = sample.spinners.map(cell => cell.glyph).join("");
      if (glyphs !== last) sequence++;
      last = glyphs;
      return { at_ms: sample.at_ms, sequence };
    });
  return {
    ...cadence(trace),
    nominal_glyph_period_ms: 80,
    minimum_visible_spinners: Math.min(...samples.map(sample => sample.spinners.length)),
    stable_positions: !!first && samples.every(sample => positions(sample) === first),
    samples,
  };
}
export function validateAnimation(value: ReturnType<typeof animationCadence>) {
  if (!value.stable_positions || value.minimum_visible_spinners < 1)
    throw Error("Missing or unstable working-spinner cells in the sidebar");
  if (value.visible_changes_per_second < 10 || value.visible_changes_per_second > 16)
    throw Error(`Unexpected visible UI animation cadence: ${value.visible_changes_per_second.toFixed(2)} changes/s`);
  if (value.max_observed_gap_ms > 250)
    throw Error(`Visible UI animation stayed unchanged for ${value.max_observed_gap_ms.toFixed(1)} ms`);
}
/** A separate presentation check, never included in the CPU utilization sample. */
export async function probe(read: () => string) {
  const started_at = new Date().toISOString(),
    start = performance.now(),
    samples: Sample[] = [],
    animation: AnimationSample[] = [];
  for (;;) {
    const screen = read(),
      visible = sequence(screen),
      at_ms = performance.now() - start;
    samples.push({ at_ms, sequence: visible });
    animation.push({ at_ms, spinners: spinners(screen) });
    if (at_ms >= 3000) break;
    await Bun.sleep(Math.min(25, 3000 - at_ms));
  }
  return {
    started_at,
    requested_seconds: 3,
    sample_interval_ms: 25,
    outside_cpu_window: true,
    ...cadence(samples),
    animation: animationCadence(animation),
    samples,
  };
}
