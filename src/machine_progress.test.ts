import { expect, test } from "bun:test";
import { Progress } from "./machine_progress";

test("a release this computer downloads for a machine keeps saying so as it goes", () => {
  const stages = (here: boolean) => {
    const shown: string[] = [];
    const progress = new Progress(message => shown.push(message));
    progress.downloaded(512, 1024, "box", here);
    progress.downloaded(1024, 1024, "box", here);
    return shown;
  };
  expect(stages(false)).toEqual(["Downloading", "Downloading"]);
  expect(stages(true)).toEqual(["Downloading here", "Downloading here"]);
});
