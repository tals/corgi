import type { Accounts, Login } from "../adapter";
import { configDir } from "./integration";

/** Goose keeps one default account: its config dir. Sign-in happens in goose. */
export const accounts: Accounts = {
  env: "GOOSE_PATH_ROOT",
  home: configDir,
  prefix: ".goose-",
  identity: (_directory: string): Login | null => null,
  shared: { dirs: [], files: [] },
  signin: null,
};
