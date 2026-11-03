import type { Agent } from "./workspace_archive";
import { adapter, type Provider } from "./providers";
import * as processName from "./process_name";

export type Summary = {
  agents: number;
  running: number;
  waiting: number;
  unread: number;
  idle: number;
  unknown: number;
  programs: (processName.Program & { count: number })[];
};

/** States belong to the moment of archiving, before live agents become historical. */
export function capture(agents: Agent[], processes: processName.Program[]): Summary {
  const summary: Summary = {
    agents: agents.length,
    running: 0,
    waiting: 0,
    unread: 0,
    idle: 0,
    unknown: 0,
    programs: [],
  };
  for (const agent of agents) {
    if (agent.attention === "needs_input" || agent.state === "blocked" || agent.paused) summary.waiting++;
    else if (agent.running) summary.running++;
    else if (agent.unread) summary.unread++;
    else if (agent.state === "unknown") summary.unknown++;
    else summary.idle++;
  }
  for (const program of [
    ...agents.map(a => ({ name: adapter(a.provider).name, brand: processName.brandOf(a.provider) })),
    ...processes,
  ]) {
    const previous = summary.programs.find(p => p.name === program.name && p.brand === program.brand);
    if (previous) previous.count++;
    else summary.programs.push({ name: program.name, brand: program.brand, count: 1 });
  }
  summary.programs.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return summary;
}

/** Older archives retain agent identities, but not their former activity. */
export function unrecorded(providers: Provider[]): Summary | null {
  return providers.length
    ? capture(
        providers.map(provider => ({
          provider,
          target: { pane: 0 },
          name: "",
          activity: "",
          running: false,
          state: "unknown",
          attention: "none",
          paused: false,
          unread: false,
        })),
        [],
      )
    : null;
}

/** Saved and wire summaries from before archiving had no inventory. */
export function restore(value: unknown): Summary | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const count = (n: unknown) => (typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : 0);
  return {
    agents: count(v.agents),
    running: count(v.running),
    waiting: count(v.waiting),
    unread: count(v.unread),
    idle: count(v.idle),
    unknown: count(v.unknown),
    programs: Array.isArray(v.programs)
      ? v.programs.flatMap(p =>
          p && typeof p.name === "string" && count(p.count)
            ? [{ name: p.name, brand: processName.brand(p.brand), count: count(p.count) }]
            : [],
        )
      : [],
  };
}
