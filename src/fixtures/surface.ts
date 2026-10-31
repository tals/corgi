import type { Surface } from "../pane/surface";

/** Compare opaque OSC 8 IDs bijectively, retaining targets and link grouping. */
export function renamedLinkIds(surface: Surface): Surface {
  const ids = new Map<string, number>();
  return {
    ...surface,
    lines: surface.lines.map(line =>
      line.replace(/\x1b\]8;id=([^;]*);/g, (_, id: string) => {
        if (!ids.has(id)) ids.set(id, ids.size);
        return `\x1b]8;id=${ids.get(id)};`;
      }),
    ),
  };
}
