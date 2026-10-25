import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Accounts, Login } from "../adapter";
import { configDir } from "./integration";

/** Goose has no user account: its identity is its configured provider. */
function provider(directory: string): string {
  let text = "";
  try {
    text = readFileSync(join(directory, "config.yaml"), "utf8");
  } catch {
    return "";
  }
  const match = text.match(/^(?:GOOSE_PROVIDER|provider|default_provider):\s*["']?([^"'\s#]+)/m);
  return match?.[1] ?? "";
}

export const accounts: Accounts = {
  env: "GOOSE_PATH_ROOT",
  home: configDir,
  prefix: ".goose-",
  identity: (directory: string): Login | null => {
    const p = provider(directory);
    return p ? { email: p, id: `goose:${p}` } : null;
  },
  shared: { dirs: [], files: [] },
  signin: null,
};
