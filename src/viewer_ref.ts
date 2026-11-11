//! Qualified identities within one viewer process. UI code carries these
//! unchanged; the controller resolves them before accessing a machine.

export type Workspace = string & { readonly __workspace: unique symbol };
export type Pane = string & { readonly __pane: unique symbol };
export type Headless = string & { readonly __headless: unique symbol };
export type Agent = Pane | Headless;
export type Entity = Workspace | Agent;
export function workspace(machine: number, id: number): Workspace {
  return `${machine}/w${id}` as Workspace;
}
export function pane(machine: number, id: number): Pane {
  return `${machine}/p${id}` as Pane;
}
export function headless(machine: number, id: number): Headless {
  return `${machine}/h${id}` as Headless;
}
export function isPane(ref: unknown): ref is Pane {
  return typeof ref === "string" && ref[ref.indexOf("/") + 1] === "p";
}
export function isHeadless(ref: unknown): ref is Headless {
  return typeof ref === "string" && ref[ref.indexOf("/") + 1] === "h";
}
export function isWorkspace(ref: Entity): ref is Workspace {
  return ref[ref.indexOf("/") + 1] === "w";
}
/** Only constructed identities reach the resolver, never external strings. */
export function parts(ref: Entity): { machine: number; id: number } {
  const slash = ref.indexOf("/");
  return { machine: Number(ref.slice(0, slash)), id: Number(ref.slice(slash + 2)) };
}
export interface Worktree {
  owner: Workspace;
  path: string;
}
