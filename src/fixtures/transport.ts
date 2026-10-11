import type { Transport } from "../mirror";
import type { Op, Arguments, Response } from "../protocol";

/** A fake daemon's wire payload crosses the same boundary as decoded JSON. */
export function transport(handler: (op: Op, fields: unknown) => Promise<unknown>): Transport {
  return {
    request<K extends Op>(op: K, ...args: Arguments<K>): Promise<Response<K>> {
      return handler(op, args[0]) as Promise<Response<K>>;
    },
  };
}
