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
/** Corgi's own colors and dark themes after Herdr's, lifted where the
 * contrast rules ask for it. */
export type Theme = "corgi" | "tokyo_night" | "catppuccin" | "rose_pine" | "kanagawa" | "gruvbox";
export const themes: Record<Theme, { label: string; colors: Record<Token, Rgb> }> = {
  corgi: { label: "Corgi", colors: corgi },
  tokyo_night: {
    label: "Tokyo Night",
    colors: {
      bg: [26, 27, 38],
      surface: [36, 40, 59],
      selected: [47, 54, 82],
      line: [74, 81, 114],
      faint: [134, 142, 183],
      muted: [169, 177, 214],
      text: [192, 202, 245],
      strong: [224, 229, 250],
      accent: [122, 162, 247],
      warm: [224, 175, 104],
      hot: [247, 119, 143],
    },
  },
  catppuccin: {
    label: "Catppuccin",
    colors: {
      bg: [24, 24, 37],
      surface: [30, 30, 46],
      selected: [49, 50, 68],
      line: [77, 80, 99],
      faint: [129, 134, 158],
      muted: [166, 173, 200],
      text: [205, 214, 244],
      strong: [230, 235, 250],
      accent: [137, 180, 250],
      warm: [249, 226, 175],
      hot: [243, 139, 168],
    },
  },
  rose_pine: {
    label: "Rosé Pine",
    colors: {
      bg: [25, 23, 36],
      surface: [31, 29, 46],
      selected: [42, 39, 56],
      line: [82, 79, 100],
      faint: [144, 140, 170],
      muted: [168, 165, 196],
      text: [224, 222, 244],
      strong: [240, 239, 250],
      accent: [196, 167, 231],
      warm: [246, 193, 119],
      hot: [235, 111, 146],
    },
  },
  kanagawa: {
    label: "Kanagawa",
    colors: {
      bg: [31, 31, 40],
      surface: [42, 42, 55],
      selected: [54, 54, 70],
      line: [84, 84, 109],
      faint: [148, 146, 131],
      muted: [166, 166, 156],
      text: [220, 215, 186],
      strong: [238, 235, 221],
      accent: [131, 160, 218],
      warm: [230, 195, 132],
      hot: [233, 130, 141],
    },
  },
  gruvbox: {
    label: "Gruvbox",
    colors: {
      bg: [40, 40, 40],
      surface: [50, 48, 47],
      selected: [60, 56, 54],
      line: [99, 91, 82],
      faint: [165, 149, 129],
      muted: [189, 174, 147],
      text: [235, 219, 178],
      strong: [245, 237, 217],
      accent: [142, 192, 124],
      warm: [250, 189, 47],
      hot: [252, 124, 109],
    },
  },
};
export const available_themes = Object.keys(themes) as Theme[];
export function parseTheme(name: string): Theme | null {
  return Object.hasOwn(themes, name) ? (name as Theme) : null;
}
/** The theme in use. `use` repaints these arrays in place, so a held token stays current. */
export const colors = Object.fromEntries(
  Object.entries(corgi).map(([token, rgb]) => [token, [...rgb] as Rgb]),
) as Record<Token, Rgb>;
let current: Theme = "corgi";
const refreshers: (() => void)[] = [];
/** Runs `refresh` now and after every theme change, for strings and colors
 * a module computes from tokens once. */
export function derived(refresh: () => void) {
  refresh();
  refreshers.push(refresh);
}
export function use(name: Theme) {
  if (name === current) return;
  current = name;
  for (const token of Object.keys(colors) as Token[]) colors[token].splice(0, 3, ...themes[name].colors[token]);
  for (const refresh of refreshers) refresh();
}
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
    if (this.value.bg) fields.push("48", "2", ...colors[this.value.bg].map(String));
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
export function contrast(first: Token, second: Token, name: Theme = "corgi") {
  const a = luminance(themes[name].colors[first]),
    b = luminance(themes[name].colors[second]);
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
