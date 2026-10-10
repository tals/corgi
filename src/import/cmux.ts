//! Deterministic cmux snapshots become ordinary Corgi tabs.
import { max_panes, Axis } from "../layout";
import { Node, validate } from "./layout";
import type { Workspace } from "./catalog";
const text = (v: any, k: string): string => (typeof v?.[k] === "string" ? v[k] : "");
const list = (v: any, k: string): any[] => (Array.isArray(v?.[k]) ? v[k] : []);
const first = (v: any, keys: string[]): string => keys.map(k => text(v, k)).find(Boolean) ?? "";
const id = (v: any) => first(v, ["id", "ref", "workspace_id", "pane_id", "surface_id"]);
const title = (v: any) =>
  first(v, ["title", "name", "label", "ref", "id", "workspace_id", "pane_id", "surface_id"]) || "Untitled";
const cwd = (v: any) => first(v, ["cwd", "current_directory", "requested_working_directory", "working_directory"]);
const matches = (v: any, handle: string) => !!handle && (id(v) === handle || text(v, "ref") === handle);
const recognizable = (v: any) =>
  !!v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  (!!id(v) || !!first(v, ["title", "name", "label", "cwd", "url"]));
const recognizableWorkspace = (v: any) =>
  recognizable(v) || list(v, "panes").length > 0 || list(v, "surfaces").length > 0;
type Rect = { x: number; y: number; w: number; h: number };
type SourcePane = {
  value: any;
  surfaces: any[];
  selected: number;
  rect: Rect | null;
};
const number = (v: any): number | null =>
  typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1e9 ? v : null;
function rect(p: any): Rect | null {
  const f = p?.pixel_frame,
    values = ["x", "y", "width", "height"].map(k => number(f?.[k]));
  if (values.some(v => v === null) || values[2]! <= 0 || values[3]! <= 0) return null;
  return { x: values[0]!, y: values[1]!, w: values[2]!, h: values[3]! };
}
const ratio = (n: number) => Math.max(100, Math.min(900, Math.round(n * 1000)));
const fail = () => {
  throw Error("InvalidImportLayout");
};
function append(nodes: Node[], node: Node): number {
  nodes.push(node);
  return nodes.length - 1;
}
function snapshotTree(nodes: Node[], value: any, panes: SourcePane[], depth: number): void {
  if (depth >= max_panes || nodes.length >= max_panes * 2 - 1) fail();
  if (value?.pane && typeof value.pane === "object" && !Array.isArray(value.pane)) {
    const i = panes.findIndex(p => matches(p.value, id(value.pane)));
    if (i < 0) fail();
    append(nodes, { pane: i });
    return;
  }
  const children = list(value, "children"),
    axis = text(value, "direction"),
    share = number(value?.split);
  if (!["horizontal", "vertical"].includes(axis) || share === null || share <= 0 || share >= 1 || children.length !== 2)
    fail();
  snapshotTree(nodes, children[0], panes, depth + 1);
  const first = nodes.length - 1;
  snapshotTree(nodes, children[1], panes, depth + 1);
  append(nodes, {
    split: {
      axis: axis as Axis,
      ratio: ratio(share!),
      first,
      second: nodes.length - 1,
    },
  });
}
function balanced(nodes: Node[], indices: number[], axis: Axis): number {
  if (indices.length === 1) return append(nodes, { pane: indices[0] });
  const middle = Math.floor(indices.length / 2),
    next = axis === "horizontal" ? "vertical" : "horizontal";
  const first = balanced(nodes, indices.slice(0, middle), next),
    second = balanced(nodes, indices.slice(middle), next);
  return append(nodes, {
    split: { axis, ratio: ratio(middle / indices.length), first, second },
  });
}
function geometry(nodes: Node[], panes: SourcePane[], indices: number[]): void {
  if (indices.some(i => !panes[i].rect)) fail();
  if (indices.length === 1) {
    append(nodes, { pane: indices[0] });
    return;
  }
  for (const axis of ["horizontal", "vertical"] as Axis[]) {
    const start = (r: Rect) => (axis === "horizontal" ? r.x : r.y),
      size = (r: Rect) => (axis === "horizontal" ? r.w : r.h);
    const min = Math.min(...indices.map(i => start(panes[i].rect!))),
      max = Math.max(...indices.map(i => start(panes[i].rect!) + size(panes[i].rect!)));
    for (const candidate of indices) {
      const cut = start(panes[candidate].rect!);
      if (cut <= min || cut >= max) continue;
      const left: number[] = [],
        right: number[] = [];
      let leftEnd = min;
      for (const i of indices) {
        const r = panes[i].rect!,
          a = start(r),
          end = a + size(r);
        if (end <= cut + 0.01) {
          left.push(i);
          leftEnd = Math.max(leftEnd, end);
        } else if (a >= cut - 0.01) right.push(i);
        else break;
      }
      if (!left.length || !right.length || left.length + right.length !== indices.length) continue;
      geometry(nodes, panes, left);
      const first = nodes.length - 1;
      geometry(nodes, panes, right);
      append(nodes, {
        split: {
          axis,
          ratio: ratio(((leftEnd + cut) / 2 - min) / (max - min)),
          first,
          second: nodes.length - 1,
        },
      });
      return;
    }
  }
  fail();
}
function project(out: Node[], source: Node[], index: number, mapping: (number | null)[]): number | null {
  const node = source[index];
  if ("pane" in node) return mapping[node.pane] === null ? null : append(out, { pane: mapping[node.pane]! });
  const left = project(out, source, node.split.first, mapping),
    right = project(out, source, node.split.second, mapping);
  if (left === null) return right;
  if (right === null) return left;
  return append(out, { split: { ...node.split, first: left, second: right } });
}
export function workspaceOnly(ws: any, reason: string): Workspace | null {
  if (!recognizableWorkspace(ws)) return null;
  return {
    id: id(ws) || title(ws),
    name: title(ws),
    cwd: cwd(ws),
    socket: "",
    session: 0,
    activity: 0,
    handoff: false,
    recovery: "workspace",
    recovery_note: reason,
    tabs: [
      {
        id: "workspace-only",
        name: "Terminal",
        panes: [
          {
            id: "new-shell",
            name: "New shell",
            cwd: "",
            pid: null,
            url: "",
            x: 0,
            y: 0,
            w: 80,
            h: 24,
            resume_available: false,
            history: "",
            screen: "",
            restart_command: "",
          },
        ],
        nodes: [{ pane: 0 }],
      },
    ],
  };
}
export function convert(ws: any, details: any = {}): Workspace | null {
  if (!recognizableWorkspace(ws)) return null;
  let source = list(ws, "panes");
  const flat = !source.length && list(ws, "surfaces").length > 0;
  if (flat) source = [ws];
  if (!source.length) return workspaceOnly(ws, "Couldn't read its panes or tabs");
  if (source.length > max_panes) return workspaceOnly(ws, "Too many panes for one import");
  const panes: SourcePane[] = [],
    seen = new Set<string>();
  let total = 0,
    layers = 0,
    partial = flat || !recognizable(ws);
  for (const p of source) {
    const surfaces: any[] = [];
    if (!Array.isArray(p?.surfaces)) partial = true;
    for (const surface of list(p, "surfaces")) {
      if (!recognizable(surface) || (id(surface) && seen.has(id(surface)))) {
        partial = true;
        continue;
      }
      if (id(surface)) seen.add(id(surface));
      surfaces.push(surface);
    }
    total += surfaces.length;
    if (total > max_panes) return workspaceOnly(ws, "Too many surfaces for one import");
    layers = Math.max(layers, surfaces.length);
    let rectangle = rect(p);
    if (!rectangle) {
      const detail = list(details, "panes").find(d => matches(p, id(d)));
      if (detail) rectangle = rect(detail);
    }
    const handle = first(p, ["selected_surface_id", "selected_surface_ref"]);
    let selected = surfaces.findIndex(s => matches(s, handle));
    if (selected < 0) selected = surfaces.findIndex(s => s.selected === true || s.selected_in_pane === true);
    if (selected < 0) selected = 0;
    panes.push({ value: p, surfaces, selected, rect: rectangle });
  }
  if (!total) return workspaceOnly(ws, "Couldn't read its panes or tabs");
  const nodes: Node[] = [];
  let approximate = false;
  try {
    snapshotTree(nodes, ws.layout, panes, 0);
  } catch {
    nodes.length = 0;
  }
  try {
    validate(nodes, source.length);
  } catch {
    approximate = true;
    nodes.length = 0;
    const indices = source.map((_, i) => i);
    try {
      geometry(nodes, panes, indices);
    } catch {
      nodes.length = 0;
      balanced(nodes, indices, "horizontal");
    }
  }
  validate(nodes, source.length);
  const tabs: Workspace["tabs"] = [];
  for (let layer = 0; layer < layers; layer++) {
    const output: Workspace["tabs"][number]["panes"] = [],
      mapping: (number | null)[] = Array(panes.length).fill(null);
    for (const [i, p] of panes.entries()) {
      if (layer >= p.surfaces.length) continue;
      const si = layer === 0 ? p.selected : layer - 1 < p.selected ? layer - 1 : layer,
        surface = p.surfaces[si];
      mapping[i] = output.length;
      output.push({
        id: id(surface) || `surface:${i}:${si}`,
        name: title(surface),
        cwd: cwd(surface) || cwd(p.value),
        url: text(surface, "url"),
        pid: null,
        x: 0,
        y: 0,
        w: 80,
        h: 24,
        resume_available: false,
        history: "",
        screen: "",
        restart_command: "",
      });
    }
    const projected: Node[] = [];
    project(projected, nodes, nodes.length - 1, mapping);
    validate(projected, output.length);
    tabs.push({
      id: `${id(ws)}:${layer}`,
      name: output.length === 1 ? output[0].name : layer === 0 ? title(ws) : `${title(ws)} (${layer + 1})`,
      panes: output,
      nodes: projected,
    });
  }
  return {
    id: id(ws) || title(ws),
    name: title(ws),
    cwd: cwd(ws),
    tabs,
    socket: "",
    session: 0,
    activity: 0,
    handoff: false,
    recovery: partial ? "partial" : approximate && source.length > 1 ? "layout" : "full",
    recovery_note: partial
      ? "Some pane or tab details couldn't be read"
      : approximate && source.length > 1
        ? "Split layout approximated"
        : "",
  };
}
