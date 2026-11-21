import * as formats from "./formats";
import * as state_formats from "./state_formats";

export const protocol = 1;
export type Info = { handoff: number; formats: string[] };
export function info(): Info {
  return { handoff: protocol, formats: formats.supported(state_formats.history) };
}
