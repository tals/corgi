import type { Revision } from "../formats";
import type { ViewerFiles } from "../revision_values";

export const revision: Revision = {
  id: "d495e64414cb",
  parent: "67a3f5d4cd43",
  description: "Turn the sleeping-corgi switch into corgi brightness",
  up(value) {
    const { viewer } = value as ViewerFiles,
      intensity = viewer.corgi_intensity;
    // A brightness saved since wins over the old switch, when it's one the builds before read.
    const saved = Number.isInteger(intensity) && (intensity as number) >= 0 && (intensity as number) <= 100;
    if (viewer.sleeping_corgis === false && !saved) viewer.corgi_intensity = 0;
    delete viewer.sleeping_corgis;
    return value;
  },
  // Builds before this revision read the brightness too.
  down: value => value,
};
