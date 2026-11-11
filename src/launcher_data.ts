//! Account metadata supplied by the daemon, never read from the viewer's disk.
import { Provider } from "./providers";
import { Row } from "./launch/row";
import * as options from "./agent_options";

export type Account = { row: Row; folder: string; suggest: string; options: options.Options };
export type Removed = { provider: Provider; account: string; name: string };
export type Data = { accounts: Account[]; removed: Removed[] };
export const empty = (): Data => ({ accounts: [], removed: [] });
export function read(value: unknown): Data {
  if (!value || typeof value !== "object") return empty();
  const raw = value as Record<string, unknown>;
  return {
    accounts: (Array.isArray(raw.accounts) ? raw.accounts : []).flatMap((a: Record<string, unknown>) => {
      const row = typeof a?.row === "string" ? Row.parse(a.row) : null,
        settings = options.read(a?.options);
      return row && settings && typeof a.folder === "string" && typeof a.suggest === "string"
        ? [{ row, folder: a.folder, suggest: a.suggest, options: settings }]
        : [];
    }),
    removed: (Array.isArray(raw.removed) ? raw.removed : []).flatMap((a: Record<string, unknown>) => {
      const provider = Provider.parse(a?.provider);
      return provider && typeof a.account === "string" && typeof a.name === "string"
        ? [{ provider, account: a.account, name: a.name }]
        : [];
    }),
  };
}
