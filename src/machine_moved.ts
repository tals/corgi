import { readFileSync, unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import * as os from "./os";

/** Which computer's viewer moved this machine to which build, kept beside its
 * socket so the daemon's hello can tell the viewers that move left behind. */
const file = (socket: string) => join(dirname(socket), "moved-by.json");
/** Records the move, returning what puts back the last one's should it fail. */
export function record(socket: string, by: string, build_id: string): () => void {
  let last: string | null = null;
  try {
    last = readFileSync(file(socket), "utf8");
  } catch {}
  try {
    os.atomicWrite(file(socket), JSON.stringify({ by, build_id }));
  } catch {}
  return () => {
    try {
      if (last === null) unlinkSync(file(socket));
      else os.atomicWrite(file(socket), last);
    } catch {}
  };
}
/** The computer whose viewer moved this machine to `build_id`, or "". */
export function by(socket: string, build_id: string): string {
  try {
    const v: unknown = JSON.parse(readFileSync(file(socket), "utf8"));
    if (
      v &&
      typeof v === "object" &&
      "build_id" in v &&
      "by" in v &&
      v.build_id === build_id &&
      typeof v.by === "string"
    )
      return v.by.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 64);
  } catch {}
  return "";
}
/** This computer, as other viewers name it. */
export function host(): string {
  return hostname().split(".")[0];
}
