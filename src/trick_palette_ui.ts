import * as palette from "./palette";
import * as style from "./trick_style";
import * as i18n from "./i18n";
import type { Color } from "./tricks";

export function colorName(color: Color): string {
  const hue = typeof color === "object" && "hue" in color ? color.hue : palette.hue(style.rgb(color));
  switch (hue) {
    case "blue":
      return i18n.t`Blue`;
    case "orange":
      return i18n.t`Orange`;
    case "red":
      return i18n.t`Red`;
    case "teal":
      return i18n.t`Teal`;
    case "green":
      return i18n.t`Green`;
    case "yellow":
      return i18n.t`Yellow`;
    case "purple":
      return i18n.t`Purple`;
    case "pink":
      return i18n.t`Pink`;
    case "brown":
      return i18n.t`Brown`;
    case "gray":
      return i18n.t`Gray`;
    case "black":
      return i18n.t`Black`;
    case "white":
      return i18n.t`White`;
  }
}
export function schemeName(colors: readonly Color[] | null): string {
  if (colors === null) return i18n.t`Automatic`;
  const found = Object.entries(palette.schemes).find(([, value]) => JSON.stringify(value) === JSON.stringify(colors));
  switch (found?.[0]) {
    case "terminal":
      return i18n.t`Terminal`;
    case "tableau10":
      return "Tableau 10";
    case "set2":
      return "Set 2";
    case "paired":
      return i18n.t`Paired`;
    default:
      return i18n.t`Custom`;
  }
}
export function choices(colors: readonly Color[]): Color[] {
  return [...new Map(colors.map(c => [style.rgb(c).join(","), c])).values()];
}
