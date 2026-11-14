//! Validate cold metadata before starting anything; unusable metadata can fall back to core.
import { Runtime } from "../runtime";
import * as json from "../json";
import * as checkpoint from "./checkpoint";
import * as transfer from "./transfer";

export async function read(bytes: string, socket: string, executable: string) {
  // Pre-baseline files have no independent core to recover from.
  if (json.field(json.parse(bytes), "transfer") === null) return { ...transfer.recover(bytes), discarded: false };
  const validate = async (decoded: ReturnType<typeof transfer.recover>) => {
    using candidate = new Runtime();
    await checkpoint.restore(candidate, decoded.value, false, socket, executable, false);
    return decoded;
  };
  try {
    return { ...(await validate(transfer.recover(bytes))), discarded: false };
  } catch {
    // A fresh runtime cannot retain anything from a partly restored candidate.
    // The core is decoded and validated again; malformed core still fails.
    return { ...(await validate(transfer.recover(bytes, undefined, true))), discarded: true };
  }
}
