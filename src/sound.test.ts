import {test,expect} from "bun:test";
import {runPlayer} from "./sound";
test("audio player failures and timeouts are bounded",async()=>{
  expect(await runPlayer(["/bin/sh","-c","exit 0"],1_000_000_000)).toBe(true);
  expect(await runPlayer(["/bin/sh","-c","exit 1"],1_000_000_000)).toBe(false);
  expect(await runPlayer(["/nonexistent-corgi-player"],1_000_000_000)).toBe(false);
  expect(await runPlayer(["/bin/sh","-c","exec sleep 5"],50_000_000)).toBe(false);
});
