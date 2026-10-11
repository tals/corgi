import { parse } from "./json";
/** Flat shared layout; mirrors src/layout.zig. */
export const max_workspaces = 32,
  max_panes = 64,
  max_borders = 67,
  max_nodes = 128;
export type PaneId = number;
export const PaneId = { none: 0, first: 1, next: (id: number) => id + 1 };
export type TabId = number;
export const TabId = { none: 0 };
export type Axis = "horizontal" | "vertical";
export type Direction = "left" | "down" | "up" | "right";
export class Rect {
  constructor(
    public x = 0,
    public y = 0,
    public w = 0,
    public h = 0,
  ) {}
  contains(x: number, y: number) {
    return x >= this.x && y >= this.y && x < this.x + this.w && y < this.y + this.h;
  }
}
export type Split = {
  axis: Axis;
  first: number;
  second: number;
  ratio: number;
};
export type Node = { pane: PaneId } | { split: Split };
export function cleanLabel(s: string) {
  return Array.from(Buffer.from(s.replace(/^ +| +$/g, "")))
    .slice(0, 80)
    .map(c => (c >= 32 && c < 127 ? String.fromCharCode(c) : "_"))
    .join("");
}
export class Tab {
  title = "";
  constructor(
    public id: TabId,
    public root: number,
  ) {}
  rename(s: string) {
    this.title = cleanLabel(s);
  }
}
export type Placement = { id: PaneId; rect: Rect };
export class Model {
  nodes: (Node | null)[] = Array(max_nodes).fill(null);
  tabs: Tab[] = [];
  count = 0;
  next_id = 1;
  revision = 0n;
  toJSON() {
    let end = this.nodes.length;
    while (end && this.nodes[end - 1] === null) end--;
    return {
      nodes: this.nodes.slice(0, end),
      tabs: this.tabs.slice(0, this.count),
      revision: this.revision,
    };
  }
  static jsonParse(bytes: string) {
    return Model.jsonParseFromValue(parse(bytes));
  }
  static jsonParseFromValue(value: Parameters<typeof Model.fromData>[0]) {
    return Model.fromData(value);
  }
  static fromData(d: { nodes: (Node | null)[]; tabs: Tab[]; revision: number | bigint }) {
    const bad = () => {
      throw Error("UnexpectedToken");
    };
    if (!d || !Array.isArray(d.nodes) || !Array.isArray(d.tabs) || d.nodes.length > max_nodes) bad();
    const integer = (value: number, max: number) => Number.isInteger(value) && value >= 0 && value <= max;
    for (const node of d.nodes) {
      if (node === null) continue;
      if (typeof node !== "object" || Object.keys(node).length !== 1) bad();
      if ("pane" in node) {
        if (!integer(node.pane, 0xffffffff)) bad();
      } else if ("split" in node) {
        const branch = node.split;
        if (
          !branch ||
          !["horizontal", "vertical"].includes(branch.axis) ||
          !integer(branch.first, 255) ||
          !integer(branch.second, 255) ||
          !integer(branch.ratio, 65535)
        )
          bad();
      } else bad();
    }
    for (const tab of d.tabs)
      if (
        !integer(tab.id, 0xffffffff) ||
        !integer(tab.root, 255) ||
        (tab.title !== undefined && typeof tab.title !== "string") ||
        Buffer.byteLength(tab.title ?? "") > 80
      )
        bad();
    if (typeof d.revision !== "number" && typeof d.revision !== "bigint") bad();
    if (typeof d.revision === "number" && !Number.isSafeInteger(d.revision)) bad();
    if (BigInt(d.revision) < 0n || BigInt(d.revision) > 0xffffffffffffffffn) bad();
    const m = new Model();
    m.nodes.splice(0, d.nodes.length, ...structuredClone(d.nodes));
    m.tabs = d.tabs.map(t => Object.assign(new Tab(t.id, t.root), t, { title: t.title ?? "" }));
    m.count = m.tabs.length;
    m.revision = BigInt(d.revision);
    const seen = new Set<number>(),
      ids = new Set<number>(),
      tabs = new Set<number>();
    const visit = (i: number) => {
      if (i < 0 || i >= max_nodes || seen.has(i) || !m.nodes[i]) bad();
      seen.add(i);
      const n = m.nodes[i]!;
      if ("pane" in n) {
        if (!n.pane || ids.has(n.pane)) bad();
        ids.add(n.pane);
      } else {
        if (n.split.ratio < 100 || n.split.ratio > 900) bad();
        visit(n.split.first);
        visit(n.split.second);
      }
    };
    for (const t of m.tabs) {
      if (!t.id || tabs.has(t.id)) bad();
      tabs.add(t.id);
      visit(t.root);
    }
    m.nodes.forEach((n, i) => {
      if (n && !seen.has(i)) bad();
    });
    return m;
  }
  alloc(n: Node) {
    const i = this.nodes.indexOf(null);
    if (i < 0) throw Error("TooManyPanes");
    this.nodes[i] = n;
    return i;
  }
  newTab(name: string) {
    const id = this.next_id,
      root = this.alloc({ pane: id });
    this.next_id = id + 2;
    const t = new Tab(id + 1, root);
    t.rename(name);
    this.tabs[this.count++] = t;
    return id;
  }
  findNode(id: PaneId) {
    const i = this.nodes.findIndex(n => n !== null && "pane" in n && n.pane === id);
    return i < 0 ? null : i;
  }
  split(target: PaneId, axis: Axis) {
    const old = this.findNode(target);
    if (old === null) throw Error("NoPane");
    const first = this.alloc(this.nodes[old]!);
    let second: number;
    try {
      second = this.alloc({ pane: this.next_id });
    } catch (e) {
      this.nodes[first] = null;
      throw e;
    }
    const id = this.next_id++;
    this.nodes[old] = { split: { axis, first, second, ratio: 500 } };
    return id;
  }
  firstPane(i: number): PaneId {
    const n = this.nodes[i]!;
    return "pane" in n ? n.pane : this.firstPane(n.split.first);
  }
  contains(i: number, id: PaneId): boolean {
    const n = this.nodes[i]!;
    return "pane" in n ? n.pane === id : this.contains(n.split.first, id) || this.contains(n.split.second, id);
  }
  tabForPane(id: PaneId) {
    const i = this.tabs.slice(0, this.count).findIndex(t => this.contains(t.root, id));
    return i < 0 ? null : i;
  }
  tabIndex(id: TabId) {
    const i = this.tabs.slice(0, this.count).findIndex(t => t.id === id);
    return i < 0 ? null : i;
  }
  close(id: PaneId) {
    const i = this.findNode(id);
    if (i === null) throw Error("NoPane");
    const t = this.tabs.findIndex(t => t.root === i);
    if (t >= 0) {
      this.nodes[i] = null;
      this.tabs.splice(t, 1);
      this.count--;
      return;
    }
    for (let p = 0; p < this.nodes.length; p++) {
      const n = this.nodes[p];
      if (!n || !("split" in n)) continue;
      const s = n.split,
        other = s.first === i ? s.second : s.second === i ? s.first : null;
      if (other === null) continue;
      this.nodes[p] = this.nodes[other];
      this.nodes[other] = this.nodes[i] = null;
      return;
    }
    throw Error("NoPane");
  }
  swap(a: PaneId, b: PaneId) {
    const i = this.findNode(a),
      j = this.findNode(b);
    if (i === null || j === null) throw Error("NoPane");
    [this.nodes[i], this.nodes[j]] = [this.nodes[j], this.nodes[i]];
  }
  resize(id: PaneId, d: Direction) {
    const t = this.tabForPane(id);
    if (t === null) return;
    const axis = d === "left" || d === "right" ? "horizontal" : "vertical",
      delta = d === "left" || d === "up" ? -40 : 40;
    const walk = (i: number): boolean => {
      const n = this.nodes[i]!;
      if (!("split" in n)) return false;
      const s = n.split;
      if (walk(this.contains(s.first, id) ? s.first : s.second)) return true;
      if (s.axis !== axis) return false;
      s.ratio = Math.max(100, Math.min(900, s.ratio + delta));
      return true;
    };
    walk(this.tabs[t].root);
  }
  moveTab(id: TabId, insert: number) {
    if (insert > this.count || !this.count) return;
    const from = this.tabIndex(id);
    if (from === null) return;
    const [t] = this.tabs.splice(from, 1);
    this.tabs.splice(insert - Number(insert > from), 0, t);
  }
  copyTree(source: Model, root: number): number {
    const n = source.nodes[root]!;
    return this.alloc(
      "pane" in n
        ? { pane: n.pane }
        : {
            split: {
              ...n.split,
              first: this.copyTree(source, n.split.first),
              second: this.copyTree(source, n.split.second),
            },
          },
    );
  }
  freeTree(root: number) {
    const n = this.nodes[root]!;
    if ("split" in n) {
      this.freeTree(n.split.first);
      this.freeTree(n.split.second);
    }
    this.nodes[root] = null;
  }
  removeTab(i: number) {
    this.freeTree(this.tabs[i].root);
    this.tabs.splice(i, 1);
    this.count--;
  }
  insertTree(root: number, target: PaneId, d: Direction) {
    const i = this.findNode(target);
    if (i === null) throw Error("NoPane");
    const old = this.alloc(this.nodes[i]!),
      before = d === "left" || d === "up";
    this.nodes[i] = {
      split: {
        axis: d === "left" || d === "right" ? "horizontal" : "vertical",
        first: before ? root : old,
        second: before ? old : root,
        ratio: 500,
      },
    };
  }
  setShare(id: PaneId, axis: Axis, ratio: number) {
    const t = this.tabForPane(id);
    if (t === null) throw Error("NoPane");
    const walk = (i: number): boolean => {
      const n = this.nodes[i]!;
      if (!("split" in n)) return false;
      const first = this.contains(n.split.first, id);
      if (walk(first ? n.split.first : n.split.second)) return true;
      if (n.split.axis !== axis) return false;
      n.split.ratio = first ? ratio : 1000 - ratio;
      return true;
    };
    if (!walk(this.tabs[t].root)) throw Error("NoSplit");
  }
}
export type TabState = { id: TabId; focus: PaneId; zoom: boolean };
export class Selection {
  /** The first tab the tab bar shows. */
  offset = 0;
  /** The active index the tab bar last scrolled into view. */
  revealed: number | null = null;
  tabs: TabState[] = [];
  count = 0;
  active = 0;
  reconcile(m: Model) {
    const old = this.tabs.slice(),
      active = this.active;
    let selected = this.count ? old[active].id : 0;
    if (selected && m.tabIndex(selected) === null) {
      selected = 0;
      for (let i = active - 1; i >= 0 && !selected; i--) if (m.tabIndex(old[i].id) !== null) selected = old[i].id;
      for (let i = active + 1; i < this.count && !selected; i++)
        if (m.tabIndex(old[i].id) !== null) selected = old[i].id;
    }
    this.count = m.count;
    this.active = 0;
    this.tabs = m.tabs.slice(0, m.count).map((t, i) => {
      if (t.id === selected) this.active = i;
      const s = old.find(s => s.id === t.id);
      return s && m.contains(t.root, s.focus) ? s : { id: t.id, focus: m.firstPane(t.root), zoom: false };
    });
  }
  focus(m: Model, id: PaneId) {
    const i = m.tabForPane(id);
    if (i === null) throw Error("NoPane");
    this.active = i;
    this.tabs[i].focus = id;
  }
  tab() {
    return this.tabs[this.active];
  }
}
export function splitRects(s: Split, r: Rect): [Rect, Rect, Rect] {
  const total = s.axis === "horizontal" ? r.w : r.h,
    available = Math.max(0, total - 1),
    first = Math.floor((available * s.ratio) / 1000),
    p = [new Rect(r.x, r.y, r.w, r.h), new Rect(r.x, r.y, r.w, r.h), new Rect(r.x, r.y, r.w, r.h)] as [
      Rect,
      Rect,
      Rect,
    ];
  if (s.axis === "horizontal") {
    p[0].w = first;
    p[1].x += first;
    p[1].w = Math.min(total, 1);
    p[2].x += Math.min(total, first + 1);
    p[2].w = available - first;
  } else {
    p[0].h = first;
    p[1].y += first;
    p[1].h = Math.min(total, 1);
    p[2].y += Math.min(total, first + 1);
    p[2].h = available - first;
  }
  return p;
}
export type Divider = { node: number; rect: Rect; axis: Axis };
export type Border = { rect: Rect; axis: Axis; draggable: boolean };
export class View {
  constructor(
    public model: Model,
    public selection: Selection,
  ) {}
  hasFrame(a: Rect) {
    return (
      this.model.count > 0 &&
      !this.selection.tab().zoom &&
      a.w >= 3 &&
      a.h >= 3 &&
      "split" in this.model.nodes[this.model.tabs[this.selection.active].root]!
    );
  }
  contentArea(a: Rect) {
    return this.hasFrame(a) ? new Rect(a.x + 1, a.y + 1, a.w - 2, a.h - 2) : a;
  }
  placements(a: Rect, out: Placement[] = []) {
    out.length = 0;
    if (!this.model.count) return out;
    if (this.selection.tab().zoom) {
      out.push({ id: this.selection.tab().focus, rect: a });
      return out;
    }
    const walk = (i: number, r: Rect) => {
      const n = this.model.nodes[i]!;
      if ("pane" in n) {
        if (out.length < max_panes) out.push({ id: n.pane, rect: r });
      } else {
        const p = splitRects(n.split, r);
        walk(n.split.first, p[0]);
        walk(n.split.second, p[2]);
      }
    };
    walk(this.model.tabs[this.selection.active].root, this.contentArea(a));
    return out;
  }
  neighbor(d: Direction, a: Rect) {
    const s = new Selection();
    s.tabs = this.selection.tabs.map(t => ({ ...t, zoom: false }));
    s.count = this.selection.count;
    s.active = this.selection.active;
    const p = new View(this.model, s).placements(a),
      cur = p.find(p => p.id === this.selection.tab().focus)?.rect ?? new Rect();
    let best: number | null = null,
      score = Infinity;
    for (const q of p) {
      if (q.id === this.selection.tab().focus) continue;
      const dx = q.rect.x * 2 + q.rect.w - (cur.x * 2 + cur.w),
        dy = q.rect.y * 2 + q.rect.h - (cur.y * 2 + cur.h);
      if (!(d === "left" ? dx < 0 : d === "right" ? dx > 0 : d === "up" ? dy < 0 : dy > 0)) continue;
      const horizontal = d === "left" || d === "right",
        v = Math.abs(horizontal ? dx : dy) + Math.abs(horizontal ? dy : dx) * 4;
      if (v < score) {
        best = q.id;
        score = v;
      }
    }
    return best;
  }
  dividerAt(a: Rect, x: number, y: number): Divider | null {
    if (!this.model.count || this.selection.tab().zoom) return null;
    const walk = (i: number, r: Rect): Divider | null => {
      if (!r.contains(x, y)) return null;
      const n = this.model.nodes[i]!;
      if (!("split" in n)) return null;
      const p = splitRects(n.split, r);
      return p[1].contains(x, y)
        ? { node: i, rect: r, axis: n.split.axis }
        : p[0].contains(x, y)
          ? walk(n.split.first, p[0])
          : p[2].contains(x, y)
            ? walk(n.split.second, p[2])
            : null;
    };
    return walk(this.model.tabs[this.selection.active].root, this.contentArea(a));
  }
  borders(a: Rect, out: Border[] = []) {
    out.length = 0;
    if (!this.model.count || this.selection.tab().zoom) return out;
    if (this.hasFrame(a))
      out.push(
        {
          rect: new Rect(a.x, a.y, a.w, 1),
          axis: "vertical",
          draggable: false,
        },
        {
          rect: new Rect(a.x, a.y + a.h - 1, a.w, 1),
          axis: "vertical",
          draggable: false,
        },
        {
          rect: new Rect(a.x, a.y + 1, 1, a.h - 2),
          axis: "horizontal",
          draggable: false,
        },
        {
          rect: new Rect(a.x + a.w - 1, a.y + 1, 1, a.h - 2),
          axis: "horizontal",
          draggable: false,
        },
      );
    const walk = (i: number, r: Rect) => {
      if (!r.w || !r.h) return;
      const n = this.model.nodes[i]!;
      if (!("split" in n)) return;
      const p = splitRects(n.split, r);
      out.push({ rect: p[1], axis: n.split.axis, draggable: true });
      walk(n.split.first, p[0]);
      walk(n.split.second, p[2]);
    };
    walk(this.model.tabs[this.selection.active].root, this.contentArea(a));
    return out;
  }
  static dividerRatio(d: Divider, x: number, y: number) {
    const total = d.axis === "horizontal" ? d.rect.w : d.rect.h,
      pos = Math.max(0, d.axis === "horizontal" ? x - d.rect.x : y - d.rect.y);
    return Math.max(100, Math.min(900, Math.floor((pos * 1000 + Math.max(0, total - 2)) / Math.max(1, total - 1))));
  }
}
