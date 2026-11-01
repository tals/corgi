import * as theme from "./palette";
import * as tricks from "./tricks";
import * as process_name from "./process_name";
import { Provider, adapter } from "./providers";
import { art } from "./assets/brand_icons";
import { contrast } from "./terminal_palette";

/** References stay symbolic until each viewer draws them in its own theme. */
export const palette = Object.freeze({
  ...(Object.fromEntries(Object.keys(theme.colors).map(token => [token, token])) as { readonly [K in theme.Token]: K }),
  syntax: Object.freeze(
    Object.fromEntries(Object.keys(theme.syntax).map(syntax => [syntax, Object.freeze({ syntax })])) as {
      readonly [K in theme.Syntax]: { readonly syntax: K };
    },
  ),
  identity: Object.freeze(
    ["string", "keyword", "type", "number", "property"].map(syntax =>
      Object.freeze({ syntax: syntax as theme.Syntax }),
    ),
  ),
  mix(a: tricks.Color, b: tricks.Color, amount = 50): tricks.Color {
    return tricks.color({ mix: [a, b], amount })!;
  },
});
export interface Brand {
  readonly name: string;
  readonly color: tricks.Color;
  readonly icon: string;
}
export const brand = Object.freeze({
  of(name: string): Brand {
    const provider = Provider.parse(name),
      info = provider ? adapter(provider) : null;
    const mark = process_name.brand(name) ?? process_name.brandOf(name);
    const color: tricks.Color = mark ? Object.freeze({ brand: mark }) : "text";
    return Object.freeze({
      name: info?.name ?? mark ?? "Unknown",
      color,
      icon: mark ? `brand:${mark}` : provider ? `provider:${provider}` : "unknown",
    });
  },
});
const resolved = new Map<process_name.Brand, theme.Rgb>();
theme.derived(() => resolved.clear());
export function rgb(color: tricks.Color): theme.Rgb {
  if (typeof color === "string")
    return color.startsWith("#")
      ? ([1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16)) as theme.Rgb)
      : theme.colors[color as theme.Token];
  if ("mix" in color) return theme.mix(rgb(color.mix[0]), rgb(color.mix[1]), color.amount);
  if ("syntax" in color) return theme.syntax[color.syntax];
  const cached = resolved.get(color.brand);
  if (cached) return cached;
  const hex = art[color.brand].layers[0][0];
  const original: theme.Rgb =
    hex === "ink" ? theme.colors.text : ([0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16)) as theme.Rgb);
  let result = original;
  for (
    let amount = 10;
    amount <= 100 &&
    [theme.colors.bg, theme.colors.surface, theme.colors.selected].some(bg => contrast(result, bg) < 4.5);
    amount += 10
  )
    result = theme.mix(original, theme.colors.text, amount);
  resolved.set(color.brand, result);
  return result;
}
