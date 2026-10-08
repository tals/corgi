export type Rgb = [number, number, number];
export const colors = {
  bg: [24, 27, 32],
  surface: [35, 40, 47],
  selected: [51, 57, 65],
  line: [80, 90, 101],
  faint: [131, 144, 158],
  muted: [165, 174, 184],
  text: [209, 214, 219],
  strong: [238, 241, 244],
  accent: [123, 241, 168],
  warm: [229, 195, 139],
  hot: [237, 163, 152],
} satisfies Record<string, Rgb>;
export type Token = keyof typeof colors;
export function fg(t: Token) {
  return fgRgb(colors[t]);
}
export function bg(t: Token) {
  return bgRgb(colors[t]);
}
export function fgRgb(c: Rgb) {
  return `\x1b[38;2;${c.join(";")}m`;
}
export function bgRgb(c: Rgb) {
  return `\x1b[48;2;${c.join(";")}m`;
}
export function mix(a: Rgb, b: Rgb, percentage: number): Rgb {
  return a.map((v, i) =>
    Math.floor(
      (v * (100 - Math.min(100, percentage)) +
        b[i] * Math.min(100, percentage) +
        50) /
        100,
    ),
  ) as Rgb;
}
export class Style {
  constructor(
    public value: {
      fg?: Token;
      bg?: Token;
      bold?: boolean;
      strike?: boolean;
    } = {},
  ) {}
  sgr() {
    const fields = ["0"];
    if (this.value.bold) fields.push("1");
    if (this.value.strike) fields.push("9");
    if (this.value.fg)
      fields.push("38", "2", ...colors[this.value.fg].map(String));
    if (this.value.bg)
      fields.push("48", "2", ...colors[this.value.bg].map(String));
    return `\x1b[${fields.join(";")}m`;
  }
}
export const keycap = new Style({ fg: "strong", bg: "line", bold: true }).sgr();

export function underline(token: Token) {
  return `\x1b[58:2::${colors[token].join(":")}m`;
}
export function writeFg(writer: { write(value: string): unknown }, rgb: Rgb) {
  writer.write(fgRgb(rgb));
}
export function luminance(rgb: Rgb) {
  return rgb.reduce((sum, channel, index) => {
    const value = channel / 255;
    return (
      sum +
      [0.2126, 0.7152, 0.0722][index] *
        (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    );
  }, 0);
}
export function contrast(first: Token, second: Token) {
  const a = luminance(colors[first]),
    b = luminance(colors[second]);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
export function termhtmlTheme() {
  const hex = (token: Token) =>
    "#" +
    colors[token].map((value) => value.toString(16).padStart(2, "0")).join("");
  return (
    "corgi: { " +
    (Object.keys(colors) as Token[])
      .map((token) => `${token}: "${hex(token)}", `)
      .join("") +
    `fg: "${hex("text")}", danger: "${hex("hot")}" },`
  );
}
