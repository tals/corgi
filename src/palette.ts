export type Rgb = [number, number, number];
const corgi = {
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
export type Token = keyof typeof corgi;
/** Corgi fills its panels with `bg`; Animal Style leaves them to the
 * terminal's own background. */
export type Theme = "corgi" | "animal_style";
export const themes: Record<Theme, { label: string; clear: boolean }> = {
  corgi: { label: "Corgi", clear: false },
  animal_style: { label: "Animal Style", clear: true },
};
export const available_themes = Object.keys(themes) as Theme[];
export function parseTheme(name: string): Theme | null {
  return Object.hasOwn(themes, name) ? (name as Theme) : null;
}
/** The colors in use. Under Animal Style, `bg` is the terminal's background
 * as it reported it, for colors mixed from it. `use` repaints it in place, so
 * a held token stays current. */
export const colors: Record<Token, Rgb> = { ...corgi, bg: [...corgi.bg] };
let current: Theme = "corgi";
const refreshers: (() => void)[] = [];
/** Runs `refresh` now and after every theme change, for strings and colors
 * a module computes from tokens once. */
export function derived(refresh: () => void) {
  refresh();
  refreshers.push(refresh);
}
/** `terminal` is the host's background, when it answered. */
export function use(name: Theme, terminal: Rgb | null = null) {
  const background = themes[name].clear && terminal ? terminal : corgi.bg;
  if (name === current && background.every((v, i) => v === colors.bg[i])) return;
  current = name;
  colors.bg.splice(0, 3, ...background);
  for (const refresh of refreshers) refresh();
}
function bgFields(t: Token, theme: Theme): string[] {
  if (t === "bg" && themes[theme].clear) return ["49"];
  return ["48", "2", ...(t === "bg" ? corgi.bg : colors[t]).map(String)];
}
export function fg(t: Token) {
  return fgRgb(colors[t]);
}
/** `theme` lets a preview paint another theme's `bg`. */
export function bg(t: Token, theme: Theme = current) {
  return `\x1b[${bgFields(t, theme).join(";")}m`;
}
export function fgRgb(c: Rgb) {
  return `\x1b[38;2;${c.join(";")}m`;
}
export function bgRgb(c: Rgb) {
  return `\x1b[48;2;${c.join(";")}m`;
}
export function mix(a: Rgb, b: Rgb, percentage: number): Rgb {
  return a.map((v, i) =>
    Math.floor((v * (100 - Math.min(100, percentage)) + b[i] * Math.min(100, percentage) + 50) / 100),
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
    if (this.value.fg) fields.push("38", "2", ...colors[this.value.fg].map(String));
    if (this.value.bg) fields.push(...bgFields(this.value.bg, current));
    return `\x1b[${fields.join(";")}m`;
  }
}
export let keycap: string;
derived(() => {
  keycap = new Style({ fg: "strong", bg: "line", bold: true }).sgr();
});

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
      sum + [0.2126, 0.7152, 0.0722][index] * (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    );
  }, 0);
}
export function contrast(first: Token, second: Token) {
  const a = luminance(corgi[first]),
    b = luminance(corgi[second]);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
export function termhtmlTheme() {
  const hex = (token: Token) => "#" + corgi[token].map(value => value.toString(16).padStart(2, "0")).join("");
  return (
    "corgi: { " +
    (Object.keys(corgi) as Token[]).map(token => `${token}: "${hex(token)}", `).join("") +
    `fg: "${hex("text")}", danger: "${hex("hot")}" },`
  );
}
