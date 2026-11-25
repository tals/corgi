import { expect, spyOn, test } from "bun:test";
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

test("an upload after the download it needed times its own rate", () => {
  let now = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  try {
    const shown: (string | undefined)[] = [];
    const progress = new Progress((message, extra) => shown.push(`${message} ${extra?.metrics}`));
    progress.downloaded(0, 1024 * 1024, "box", true);
    now = 60_000;
    progress.downloaded(1024 * 1024, 1024 * 1024, "box", true);
    progress.uploaded(0, 1024 * 1024, "full");
    now = 61_000;
    progress.uploaded(1024 * 1024, 1024 * 1024, "full");
    expect(shown.at(-1)).toBe("Uploading 100% 1.0 MiB/s");
  } finally {
    clock.mockRestore();
  }
});
