import type { Info } from "../adapter";
export const info: Info = {
  id: "pi",
  label: "Pi",
  name: "Pi",
  glyph: "π",
  command: "pi",
  launcher_key: "p",
  bypass: false,
  programs: {
    names: ["pi"],
    scripts: ["earendil-works", "mariozechner"].flatMap(scope =>
      ["dist/bundle/cli.js", "dist/cli.js"].map(cli => `/@${scope}/pi-coding-agent/${cli}`),
    ),
  },
};
