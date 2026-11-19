import type { Revision } from "../formats";
import type { ViewerFiles } from "../revision_values";

export const revision: Revision = {
  id: "7f791e9ff70d",
  parent: "50cd70f93bfd",
  description: "Store the prefix as a key chord",
  up(value) {
    const { config } = value as ViewerFiles;
    if (config?.prefix === "ctrl_a") config.prefix = "ctrl+a";
    if (config?.prefix === "ctrl_b") config.prefix = "ctrl+b";
    return value;
  },
  down(value) {
    const { config } = value as ViewerFiles;
    // Older builds only have these two choices; custom prefixes are lost on downgrade.
    if (config && "prefix" in config) config.prefix = config.prefix === "ctrl+a" ? "ctrl_a" : "ctrl_b";
    return value;
  },
};
