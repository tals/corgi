//! The changed files as a tree: directories first, then files, each
//! alphabetical. A directory with a single child directory joins it into
//! one row (`src/generated/`). Mirrors herdr-reviewr's `file_list.rs`.

/** A directory holding more changed files than this starts folded. */
export const crowded = 12;

export type Row =
  | {
      kind: "dir";
      id: string;
      path: string;
      name: string;
      depth: number;
      open: boolean;
      files: string[];
      crowded: boolean;
    }
  | {
      kind: "file";
      id: string;
      path: string;
      name: string;
      depth: number;
      /** Its directory, on a flat list's row. */
      dir?: string;
    };

interface Node {
  name: string;
  path: string;
  dirs: Map<string, Node>;
  files: string[];
}
function build(paths: string[]): Node {
  const root: Node = { name: "", path: "", dirs: new Map(), files: [] };
  for (const path of paths) {
    const parts = path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let next = node.dirs.get(part);
      if (!next) {
        next = { name: part, path: node.path ? `${node.path}/${part}` : part, dirs: new Map(), files: [] };
        node.dirs.set(part, next);
      }
      node = next;
    }
    node.files.push(path);
  }
  return root;
}
function all(node: Node): string[] {
  return node.files.concat(...[...node.dirs.values()].map(all));
}
const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The rows shown. `toggled` holds directory paths flipped from their
 * resting state; `open_all` opens every directory (the walking order);
 * `descending` lists each level Z to A. */
export function rows(paths: string[], toggled: ReadonlySet<string>, open_all = false, descending = false): Row[] {
  const out: Row[] = [];
  const named = (a: string, b: string) => (descending ? byName(b, a) : byName(a, b));
  const walk = (node: Node, depth: number) => {
    for (const first of [...node.dirs.values()].sort((a, b) => named(a.name, b.name))) {
      let dir = first,
        name = dir.name;
      while (dir.files.length === 0 && dir.dirs.size === 1) {
        dir = [...dir.dirs.values()][0];
        name += "/" + dir.name;
      }
      const files = all(dir),
        busy = files.length > crowded,
        open = open_all || (toggled.has(dir.path) ? busy : !busy);
      out.push({ kind: "dir", id: "d:" + dir.path, path: dir.path, name, depth, open, files, crowded: busy });
      if (open) walk(dir, depth + 1);
    }
    for (const path of node.files.slice().sort(named))
      out.push({ kind: "file", id: "f:" + path, path, name: path.slice(path.lastIndexOf("/") + 1), depth });
  };
  walk(build(paths), 0);
  return out;
}

/** The files as one list in the order given, each named with its directory beside it. */
export function flat(paths: string[]): Row[] {
  return paths.map(path => {
    const cut = path.lastIndexOf("/");
    return { kind: "file", id: "f:" + path, path, name: path.slice(cut + 1), depth: 0, dir: path.slice(0, cut + 1) };
  });
}

/** `paths` newest edit first, or oldest first; those without a time
 * last either way, by name. */
export function byEdited(paths: string[], edited: ReadonlyMap<string, number>, oldest_first = false): string[] {
  return paths.slice().sort((a, b) => {
    const ta = edited.get(a),
      tb = edited.get(b);
    if (ta === undefined || tb === undefined) return ta !== undefined ? -1 : tb !== undefined ? 1 : byName(a, b);
    return (oldest_first ? ta - tb : tb - ta) || byName(a, b);
  });
}

/** Every file in tree order, as `]` and `f` walk them. */
export function order(paths: string[], descending = false): string[] {
  return rows(paths, new Set(), true, descending).flatMap(row => (row.kind === "file" ? [row.path] : []));
}

/** `toggled` with each directory above `path` open. */
export function reveal(paths: string[], toggled: ReadonlySet<string>, path: string): Set<string> {
  const next = new Set(toggled);
  for (const row of rows(paths, new Set(), true))
    if (row.kind === "dir" && path.startsWith(row.path + "/")) {
      if (row.crowded) next.add(row.path);
      else next.delete(row.path);
    }
  return next;
}

/** `toggled` with directory `row` set open or closed. */
export function setOpen(toggled: ReadonlySet<string>, row: Row & { kind: "dir" }, open: boolean): Set<string> {
  const next = new Set(toggled);
  if (open === !row.crowded) next.delete(row.path);
  else next.add(row.path);
  return next;
}
