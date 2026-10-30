//! Native reasoning levels and their launch flags.
export const levels = ["none", "off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type Effort = (typeof levels)[number];
export function parse(value: unknown): Effort | null {
  return typeof value === "string" && levels.includes(value as Effort) ? (value as Effort) : null;
}
export function list(value: unknown): Effort[] {
  return Array.isArray(value) ? [...new Set(value.flatMap(v => parse(v) ?? []))] : [];
}
export function label(value: Effort): string {
  return value === "xhigh" ? "XHigh" : value[0].toUpperCase() + value.slice(1);
}
export function suffix(value?: Effort): string {
  return value ? " " + label(value) : "";
}
/** Keep literal prompt arguments after -- untouched. */
export function apply(flag: "--effort" | "--thinking" | null, args: string[], effort?: Effort): string[] {
  if (!effort) return args;
  const out: string[] = [];
  let tail: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    if (word === "--") {
      tail = args.slice(i);
      break;
    }
    if (flag && (word === flag || word.startsWith(flag + "="))) {
      if (word === flag) i++;
      continue;
    }
    if (!flag) {
      if ((word === "-c" || word === "--config") && /^model_reasoning_effort\s*=/.test(args[i + 1] ?? "")) {
        i++;
        continue;
      }
      if (/^(?:-c|--config=)model_reasoning_effort\s*=/.test(word)) continue;
    }
    out.push(word);
  }
  return [...out, ...(flag ? [flag, effort] : ["-c", 'model_reasoning_effort="' + effort + '"']), ...tail];
}
