import type { SessionHistory } from "../adapter";
import type { Entry } from "../../launch/history";
import { API, dataDir, validSession } from "./api";
import { field, str } from "../common";
export function entry(value: unknown): Entry | null {
  const id = str(value, "id"),
    cwd = str(field(value, "location"), "directory");
  if (!validSession(id) || !cwd.startsWith("/") || str(value, "parentID")) return null;
  return {
    provider: "opencode2",
    account: "",
    session: id,
    title: str(value, "title"),
    first: "",
    last: "",
    cwd,
    branch: "",
    updated_at: Math.floor(Number(field(field(value, "time"), "updated") ?? 0) / 1000),
    interrupted: str(value, "outcome") === "interrupted",
  };
}
export async function open(): Promise<SessionHistory> {
  const list = async (stopping: () => boolean, borrow = true) => {
    try {
      const result = await API.peek(
        process.cwd(),
        api => api.sessions("&parentID=null&archived=false", stopping),
        borrow,
      );
      if (!result) return { sessions: [], complete: false };
      return { sessions: result.entries.flatMap(v => entry(v) ?? []), complete: result.complete };
    } catch {
      return { sessions: [], complete: false };
    }
  };
  return {
    roots: () => [dataDir()],
    list,
    // A private server writes in the folder watched here; reading for its
    // changes would start another.
    async changed(_paths, store, stopping) {
      const result = await list(stopping, false);
      store.replace(result.sessions, result.complete ? ["opencode2"] : []);
    },
    close() {},
  };
}
