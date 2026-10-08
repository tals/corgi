import {test,expect} from "bun:test";
import {Condition,timedWait} from "./compat";
test("a timed wait times out without a signal and returns on one",async()=>{const c=new Condition();await expect(timedWait(c,1e6)).rejects.toThrow("Timeout");const ready=timedWait(c,1e9);queueMicrotask(()=>c.signal());await ready;});
