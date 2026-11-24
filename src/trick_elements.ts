import * as tricks from "./tricks";
import * as markup from "./trick_markup";

export type Press = () => void | Promise<void>;
export type Content = string | Element;
export type Element =
  | { kind: "text"; spans: tricks.Span[] }
  | { kind: "button"; spans: tricks.Span[]; press: Press }
  | { kind: "row"; children: Content[] }
  | { kind: "column"; children: Content[] };

export const ui = Object.freeze({
  text(value: string, color?: tricks.Color): Element {
    return { kind: "text", spans: markup.parse(value).map(span => ({ ...span, color: span.color ?? color })) };
  },
  icon(reference: string): Element {
    const icon = markup.icon(reference);
    if (!icon) throw Error("InvalidIcon");
    return { kind: "text", spans: [icon] };
  },
  row(...children: Content[]): Element {
    return { kind: "row", children };
  },
  column(...children: Content[]): Element {
    return { kind: "column", children };
  },
  button(label: string, press: Press): Element {
    if (typeof press !== "function") throw Error("ExpectedHandler");
    return { kind: "button", spans: markup.parse(label), press };
  },
});

/** Functions stay in the runner; only bounded descriptions cross the pipe. */
export function encode(content: Content, color?: tricks.Color) {
  const callbacks: Press[] = [];
  let count = 0;
  const read = (value: Content, depth: number): tricks.Element => {
    if (++count > tricks.max_nodes || depth >= tricks.max_depth) throw Error("DrawingTooLarge");
    const node = typeof value === "string" ? ui.text(value) : value;
    switch (node.kind) {
      case "text":
        return { ...node, spans: node.spans.map(span => ({ ...span, color: span.color ?? color })) };
      case "button":
        if (typeof node.press !== "function") throw Error("ExpectedHandler");
        callbacks.push(node.press);
        return {
          kind: "button",
          spans: node.spans.map(span => ({ ...span, color: span.color ?? color })),
          action: String(callbacks.length - 1),
        };
      case "row":
      case "column":
        if (!Array.isArray(node.children) || node.children.length > tricks.max_nodes) throw Error("DrawingTooLarge");
        return { kind: node.kind, children: node.children.map(child => read(child, depth + 1)) };
      default:
        throw Error("InvalidElement");
    }
  };
  return { content: tricks.element(read(content, 0)), callbacks };
}
