import { actions, type Action } from "../src/activity/prompt";

/** `action` lists the decisions a step accepts, when it matters which one. */
export type CaseStep = {
  evidence: string;
  turn?: string;
  expect: "abstain" | "label";
  all?: string[];
  action?: Action[];
};
export type Scenario = { id: string; category: string; steps: CaseStep[] };
export type Observation = {
  id: string;
  status: string;
  err?: string | null;
  raw: string | null;
  action?: string | null;
  label: string | null;
  elapsed_ms: number;
  input?: unknown;
};
export type Result = {
  model: string;
  provider: string;
  id: string;
  scenario: string;
  category: string;
  repeat: number;
  expected: CaseStep;
  observation: Observation | null;
  failures: string[];
};

// These assertions are evaluation rubrics, not a production phrase blacklist.
const generic =
  /^(?:thinking|working|processing|ready|awaiting task details|awaiting instructions|awaiting clarification|waiting for (?:input|instructions|details)|needs? (?:input|clarification))(?:\b|$)/i;
const inputClaim = /\b(?:awaiting|waiting|needs?)\b.*\b(?:user|input|instructions|clarification|task details)\b/i;

export function grade(step: CaseStep, output: Observation | null): string[] {
  if (!output) return ["missing result"];
  if (output.status === "error" || output.status === "invalid") return [`${output.status}: ${output.err ?? "unknown"}`];
  if (!["abstained", "label"].includes(output.status)) return [`unknown status: ${output.status}`];
  let raw: unknown;
  try {
    raw = JSON.parse(output.raw ?? "");
  } catch {
    return ["invalid JSON response"];
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).sort().join() !== "action,label")
    return ["invalid response schema"];
  const { action, label: value } = raw as { action: unknown; label: unknown };
  if (!actions.includes(action as Action)) return ["invalid action"];
  if (value !== null && typeof value !== "string") return ["invalid label type"];
  if (output.status === "abstained" && output.label !== null) return ["inconsistent abstention"];
  if (output.status === "label" && typeof output.label !== "string") return ["inconsistent label"];
  const failures: string[] = [];
  if (step.expect === "abstain" && output.status !== "abstained") failures.push("expected abstention");
  if (step.expect === "label" && output.status !== "label") failures.push("unnecessary abstention");
  if (step.action && !step.action.includes(output.action as Action))
    failures.push(`expected ${step.action.join(" or ")}, got ${output.action}`);
  if (output.label !== null) {
    const label = output.label;
    const words = label.split(" ").filter(Boolean).length;
    if (words < 2 || words > 6 || Buffer.byteLength(label) > 80 || /[\x00-\x1f\x7f-\x9f]/.test(label))
      failures.push("invalid label format");
    if (generic.test(label) || inputClaim.test(label)) failures.push("generic or unsupported input-status label");
    for (const pattern of step.all ?? [])
      if (!new RegExp(pattern, "i").test(label)) failures.push(`missing topic: ${pattern}`);
  }
  return failures;
}

export function scorecard(results: Result[]): string {
  const lines = [
    "| Model | Pass | Abstention | Activity | Sequences | Injection | Errors | p50 / p95 |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const model of [...new Set(results.map(r => r.model))]) {
    const rows = results.filter(r => r.model === model);
    const ratio = (subset: Result[]) => `${subset.filter(r => !r.failures.length).length}/${subset.length}`;
    const times = rows
      .filter(r => r.observation)
      .map(r => r.observation!.elapsed_ms)
      .sort((a, b) => a - b);
    const percentile = (p: number) =>
      times.length ? `${(times[Math.max(0, Math.ceil(times.length * p) - 1)] / 1000).toFixed(1)}s` : "—";
    const errors = rows.filter(r => !r.observation || ["error", "invalid"].includes(r.observation.status)).length;
    lines.push(
      `| ${model.replaceAll("|", "\\|")} | ${ratio(rows)} | ${ratio(rows.filter(r => r.category === "abstention"))} | ${ratio(rows.filter(r => r.category === "activity"))} | ${ratio(rows.filter(r => r.category === "sequence"))} | ${ratio(rows.filter(r => r.category === "injection"))} | ${errors} | ${percentile(0.5)} / ${percentile(0.95)} |`,
    );
  }
  return lines.join("\n");
}

export function validateCases(value: unknown): Scenario[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("cases must be a nonempty array");
  const ids = new Set<string>();
  for (const scenario of value) {
    if (!scenario || typeof scenario.id !== "string" || !/^[\w-]+$/.test(scenario.id) || ids.has(scenario.id))
      throw new Error("invalid/duplicate case ID");
    ids.add(scenario.id);
    if (
      !["abstention", "activity", "sequence", "injection"].includes(scenario.category) ||
      !Array.isArray(scenario.steps) ||
      !scenario.steps.length
    )
      throw new Error(`invalid case ${scenario.id}`);
    for (const step of scenario.steps) {
      if (
        typeof step.evidence !== "string" ||
        !step.evidence.length ||
        Buffer.byteLength(step.evidence) > 2048 ||
        !["abstain", "label"].includes(step.expect) ||
        (step.turn !== undefined && typeof step.turn !== "string") ||
        (step.action !== undefined &&
          (!Array.isArray(step.action) || !step.action.length || !step.action.every((a: any) => actions.includes(a))))
      )
        throw new Error(`invalid step in ${scenario.id}`);
      if (step.expect === "label" && (!Array.isArray(step.all) || !step.all.length))
        throw new Error(`positive case needs a topic assertion: ${scenario.id}`);
      for (const pattern of step.all ?? []) {
        if (typeof pattern !== "string") throw new Error("invalid pattern");
        new RegExp(pattern, "i");
      }
    }
  }
  return value;
}
