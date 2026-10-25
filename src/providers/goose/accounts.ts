import type { Accounts, Login } from "../adapter";
import { configDir, configValueAt } from "./integration";

/** Goose has no user account: its identity is its configured provider. */
export const accounts: Accounts = {
  env: "GOOSE_PATH_ROOT",
  home: configDir,
  prefix: ".goose-",
  identity: (directory: string): Login | null => {
    const p = configValueAt(directory, "GOOSE_PROVIDER", "provider", "default_provider");
    return p ? { email: p, id: `goose:${p}` } : null;
  },
  shared: { dirs: [], files: [] },
  signin: null,
};
