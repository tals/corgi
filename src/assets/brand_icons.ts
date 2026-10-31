//! The marks untitled tabs wear, one SVG file each in assets/brand_icons/,
//! read into paths at build time. Most are Simple Icons' (CC0,
//! simpleicons.org) in their brand colors, but for Bun's, Hack's, Vim's and
//! OMP's and OpenCode's, from their own logos, and Python's, split into its
//! two snakes. Each mark's license is in assets/licenses.txt.
import { svg } from "./svg" with { type: "macro" };
import type { Art } from "./svg";
import type { Brand } from "../process_name";

export const art: Record<Brand, Art> = {
  node: svg("node"),
  bun: svg("bun"),
  python: svg("python"),
  ruby: svg("ruby"),
  php: svg("php"),
  hack: svg("hack"),
  perl: svg("perl"),
  r: svg("r"),
  vim: svg("vim"),
  neovim: svg("neovim"),
  git: svg("git"),
  docker: svg("docker"),
  kubernetes: svg("kubernetes"),
  postgresql: svg("postgresql"),
  redis: svg("redis"),
  rust: svg("rust"),
  go: svg("go"),
  zig: svg("zig"),
  homebrew: svg("homebrew"),
  cmake: svg("cmake"),
  claude: svg("claude"),
  openai: svg("openai"),
  tmux: svg("tmux"),
  omp: svg("omp"),
  opencode: svg("opencode"),
};
