/** Feature-attribution checks; ordinary stream/spinner guards remain unchanged. */
import assert from "node:assert/strict";
import * as progress from "./viewer_progress";
export { sequence, reading, validate, validateCadence, validateAnimation } from "./viewer_progress";

export async function probe(read: () => string, quiet: boolean) {
  const decorations: { details: string[]; resource_labels: boolean }[] = [];
  const result = await progress.probe(() => {
    const screen = read(),
      rows = screen.split("\n"),
      cells = progress.spinners(screen);
    decorations.push({
      // This fixed160x48 fixture has a27-column sidebar, then its divider.
      // Blank-activity working rows retain their informative spinner at2,
      // while decoration occupies the detail area beginning at5.
      details: cells.map(cell => [...rows[cell.row]].slice(cell.column + 3, 27).join("")),
      resource_labels: rows.some(row => /\b(?:CPU|Memory|GPU)\b/.test([...row].slice(0, 27).join(""))),
    });
    return screen;
  });
  if (quiet) {
    assert.ok(
      decorations.every(sample => sample.details.length > 0),
      "Missing quiet working detail rows",
    );
    assert.ok(
      decorations.every(sample => sample.details.every(detail => detail.trim() === "")),
      "Zero intensity must keep this blank-activity fixture's decorative details blank",
    );
    assert.ok(
      decorations.every(sample => !sample.resource_labels),
      "Resource labels remain visible while disabled",
    );
  }
  return {
    ...result,
    feature_quality: {
      quiet,
      spinner_contract: "Working spinners remain informative at intensity0; ordinary10–16Hz guard still applies",
      decoration_contract: "Zero intensity hides decorative corgis; blank activity remains blank",
      decorations,
    },
  };
}

function resources(value: unknown) {
  assert.ok(value && typeof value === "object", "Missing resource snapshot");
  const v = value as Record<string, unknown>;
  assert.equal(typeof v.sampled_at, "number");
  assert.ok(Array.isArray(v.gpus) && Array.isArray(v.workspaces));
  return { sampled_at: v.sampled_at as number, gpus: v.gpus.length, workspaces: v.workspaces.length };
}
export function validateResources(before: unknown, after: unknown, enabled: boolean) {
  const a = resources(before),
    b = resources(after);
  if (enabled) {
    assert.ok(a.sampled_at > 0 && b.sampled_at > a.sampled_at, "Enabled resource sampler did not advance");
    assert.ok(Date.now() - b.sampled_at < 10000, "Resource readings are stale");
  } else {
    assert.deepEqual(a, { sampled_at: 0, gpus: 0, workspaces: 0 }, "Resource sampler not stopped before window");
    assert.deepEqual(b, a, "Resource sampler ran during disabled window");
  }
  return { enabled, before: a, after: b, outside_cpu_window: true };
}
