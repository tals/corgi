//! Viewer targets retain their owner independently of keyboard focus.
//! Only the numeric id crosses that machine's daemon connection.
import type { Machine } from "./machine";

export interface Workspace {
  machine: Machine;
  workspace: number;
}
export interface Pane {
  machine: Machine;
  pane: number;
}
export interface Worktree {
  owner: Workspace;
  path: string;
}
export function workspace(ref: Workspace | null) {
  return ref?.machine.runtime.workspaces.items.find(ws => ws.id === ref.workspace) ?? null;
}
export function pane(ref: Pane) {
  return ref.machine.runtime.pane(ref.pane);
}
export function sameWorkspace(a: Workspace | null | undefined, b: Workspace | null | undefined): boolean {
  return a?.machine === b?.machine && a?.workspace === b?.workspace;
}
