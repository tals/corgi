import { Rect, type View } from "./layout";
import type { Pane } from "./mirror";
import * as palette from "./palette";
import * as text from "./text";

export class State {
  phase: "preparing" | "uploading" | "attaching" | "done" | "failed" = "preparing";
  received = 0;
  total = 0;
  until = Infinity;
  constructor(readonly pane: number) {}
  update(received: number, total: number): void {
    this.phase = "uploading";
    this.received = received;
    this.total = total;
  }
  finish(ok: boolean, now = Date.now()): void {
    this.phase = ok ? "done" : "failed";
    this.until = now + (ok ? 900 : 3000);
  }
}

/** A single overlay row, clear of the typing row and contained in its pane. */
export function place(pane: Rect, caret: { x: number; y: number }): Rect | null {
  if (pane.w < 14 || pane.h < 2 || !pane.contains(caret.x, caret.y)) return null;
  const w = Math.min(22, pane.w);
  return new Rect(
    Math.min(Math.max(caret.x - 1, pane.x), pane.x + pane.w - w),
    caret.y > pane.y ? caret.y - 1 : caret.y + 1,
    w,
    1,
  );
}

export function locate(view: View, panes: Pane[], area: Rect, state: State): Rect | null {
  if (!view.model.count || view.selection.tabs[view.selection.active].focus !== state.pane) return null;
  const spot = view.placements(area).find(spot => spot.id === state.pane);
  const pane = panes.find(pane => pane.id === state.pane);
  if (!spot || !pane || pane.restoring) return null;
  const caret = pane.terminal.cursor() ?? pane.terminal.caret();
  return caret ? place(spot.rect, { x: spot.rect.x + caret.x, y: spot.rect.y + caret.y }) : null;
}

export function draw(state: State, at: Rect, now = Date.now()): string {
  const base = new palette.Style({ fg: "text", bg: "surface" }).sgr();
  let body: string;
  switch (state.phase) {
    case "preparing":
    case "attaching": {
      const pulse = Math.round(50 + 50 * Math.sin(now / 220));
      body =
        palette.fgRgb(palette.mix(palette.colors.muted, palette.colors.strong, pulse)) +
        (state.phase === "preparing" ? "↑ Preparing…" : "↑ Attaching…");
      break;
    }
    case "uploading": {
      const percent = state.total > 0 ? Math.min(100, Math.floor((state.received * 100) / state.total)) : 0;
      const cells = at.w - 9;
      const filled = Math.floor((cells * percent) / 100);
      body =
        palette.fg("accent") +
        "↑ " +
        "▰".repeat(filled) +
        palette.fg("line") +
        "▱".repeat(cells - filled) +
        palette.fg("text") +
        " " +
        `${percent}%`.padStart(4);
      break;
    }
    case "done":
      body = palette.fg("accent") + "✓ Uploaded";
      break;
    case "failed":
      body = palette.fg("hot") + "! Upload failed";
      break;
  }
  const plain = Bun.stripANSI(body);
  const room = at.w - 2;
  if (text.displayWidth(plain) > room)
    body = palette.fg(state.phase === "failed" ? "hot" : "text") + text.ellipsis(plain, room);
  return `\x1b7\x1b[${at.y + 1};${at.x + 1}H${base} ${body}${" ".repeat(at.w - 1 - text.displayWidth(Bun.stripANSI(body)))}\x1b[0m\x1b8`;
}
