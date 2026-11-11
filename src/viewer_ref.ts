//! Data-only targets within one viewer process. The controller resolves the
//! machine id; only the workspace or pane id crosses its daemon connection.

export interface Workspace {
  machine: number;
  workspace: number;
}
export interface Pane {
  machine: number;
  pane: number;
}
export interface Worktree {
  owner: Workspace;
  path: string;
}
export function sameWorkspace(a: Workspace | null | undefined, b: Workspace | null | undefined): boolean {
  return a?.machine === b?.machine && a?.workspace === b?.workspace;
}
