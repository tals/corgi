import { max_panes, Model, Axis } from "../layout";
export type Node = { pane: number } | { split: { axis: Axis; ratio: number; first: number; second: number } };
export function validate(nodes: Node[], panes: number): void {
  const fail = () => {
    throw Error("InvalidImportLayout");
  };
  if (!Number.isInteger(panes) || panes <= 0 || panes > max_panes || nodes.length !== panes * 2 - 1) fail();
  const children = new Set<number>(),
    leaves = new Set<number>();
  for (const [i, node] of nodes.entries()) {
    if ("pane" in node) {
      if (!Number.isInteger(node.pane) || node.pane < 0 || node.pane >= panes || leaves.has(node.pane)) fail();
      leaves.add(node.pane);
    } else {
      const s = node.split;
      if (
        !s ||
        !["horizontal", "vertical"].includes(s.axis) ||
        !Number.isInteger(s.ratio) ||
        s.ratio < 100 ||
        s.ratio > 900 ||
        !Number.isInteger(s.first) ||
        !Number.isInteger(s.second) ||
        s.first < 0 ||
        s.second < 0 ||
        s.first >= i ||
        s.second >= i ||
        s.first === s.second ||
        children.has(s.first) ||
        children.has(s.second)
      )
        fail();
      children.add(s.first);
      children.add(s.second);
    }
  }
  if (leaves.size !== panes || children.size !== nodes.length - 1) fail();
}
export function install(model: Model, nodes: Node[], ids: number[]): number {
  validate(nodes, ids.length);
  const mapped: number[] = [];
  for (const node of nodes)
    mapped.push(
      model.alloc(
        "pane" in node
          ? { pane: ids[node.pane] }
          : {
              split: {
                ...node.split,
                first: mapped[node.split.first],
                second: mapped[node.split.second],
              },
            },
      ),
    );
  return mapped[mapped.length - 1];
}
