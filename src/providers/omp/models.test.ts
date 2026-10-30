import { expect, spyOn, test } from "bun:test";
import { read } from "./models";
import { read as piModels } from "../pi/models";
import { Stdio } from "../stdio";
import * as discovery from "../../discovery";
import { Quit } from "../../subprocess";

test.each([read, piModels])("cancelling a model reader closes its child before the next polling turn", async reader => {
  const quit = new Quit(),
    io = new Stdio();
  let resume = () => {};
  const resolve = spyOn(discovery, "resolve").mockResolvedValue("fixture-agent"),
    spawn = spyOn(Stdio, "spawn").mockReturnValue(io),
    wait = spyOn(io, "wait").mockImplementation(
      () =>
        new Promise<void>(done => {
          resume = done;
        }),
    );
  try {
    const pending = reader("/fixture", quit);
    await Bun.sleep(0);
    expect(wait).toHaveBeenCalled();
    quit.signal();
    expect(io.closed).toBe(true);
    resume();
    await expect(pending).rejects.toThrow("ModelsUnavailable");
  } finally {
    quit.signal();
    resume();
    resolve.mockRestore();
    spawn.mockRestore();
    wait.mockRestore();
  }
});
