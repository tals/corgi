import { Pane, type Runtime } from "../runtime";
import { Terminal } from "../pane/terminal";
import type { Workspace } from "../workspace";

/** Opens a 20×4 pane in `w`: in a new tab, or split beside pane `split`. */
export function addPane(r: Runtime, w: Workspace, split: number | null = null): Pane {
  w.model.next_id = r.workspaces.next_pane_id;
  const id = split === null ? w.model.newTab("") : w.model.split(split, "horizontal");
  r.workspaces.next_pane_id = w.model.next_id;
  const p = new Pane(id, Terminal.create(20, 4), "/tmp");
  r.panes.push(p);
  return p;
}
