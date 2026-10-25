import type { Info } from "../adapter";
export const info: Info = {
  id: "goose",
  label: "Goose",
  name: "Goose",
  glyph: "G",
  command: "goose",
  launcher_key: "g",
  // Goose approves tools through its own UI; corgi never bypasses that.
  bypass: false,
};
