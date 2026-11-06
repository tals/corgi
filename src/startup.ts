import * as i18n from "./i18n";
import { Provider, adapter } from "./providers";
import type { Quit } from "./subprocess";

export const phases = ["discovering", "service", "session", "installing", "agent"] as const;
export type Phase = (typeof phases)[number];
export type Wait = {
  id: string;
  pane: number;
  provider: Provider;
  phase: Phase;
  detail: string;
  started_at: number;
  cancelled: boolean;
};
export interface Progress {
  quit: Quit;
  update(phase: Phase, detail?: string): void;
  output(bytes: Buffer, stream: "stdout" | "stderr"): void;
}
export function clean(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .trim()
    .slice(-240);
}
/** Only explicit mise activity establishes installation, not a missing binary. */
export function installing(line: string): boolean {
  return (
    /^mise\s/i.test(clean(line)) &&
    /\b(installing|downloading|extracting|building|compiling|download|extract)\b/i.test(line)
  );
}
export function label(wait: Wait): string {
  const name = adapter(wait.provider).label;
  if (wait.cancelled) return i18n.t`Stopping ${name}…`;
  switch (wait.phase) {
    case "agent":
      return i18n.t`Waiting for ${name}…`;
    case "discovering":
      return i18n.t`Finding ${name}…`;
    case "service":
      return i18n.t`Waiting for ${name} service…`;
    case "session":
      return i18n.t`Waiting for ${name} session…`;
    case "installing":
      return i18n.t`Installing ${name}…`;
  }
}
export function decode(value: unknown): Wait[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    if (typeof item !== "object" || item === null) return [];
    const v = item as Record<string, unknown>,
      provider = Provider.parse(v.provider);
    const phase = phases.find(p => p === v.phase);
    if (
      !provider ||
      !phase ||
      typeof v.id !== "string" ||
      typeof v.pane !== "number" ||
      !Number.isInteger(v.pane) ||
      typeof v.started_at !== "number" ||
      !Number.isFinite(v.started_at)
    )
      return [];
    return [
      {
        id: v.id,
        pane: v.pane,
        provider,
        phase,
        started_at: v.started_at,
        detail: typeof v.detail === "string" ? clean(v.detail) : "",
        cancelled: v.cancelled === true,
      },
    ];
  });
}
