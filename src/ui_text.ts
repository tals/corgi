//! Cell-width-aware presentation clipping uses the installed TUI boundary.
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
export { visibleWidth as displayWidth };
export function ellipsis(value: string, room: number): string {
  return room > 0 ? truncateToWidth(value, room, "…", false) : "";
}
