import { join } from "node:path";
import type { Launcher } from "../adapter";
import { Info, Text } from "../../usage/account";
import { configModel, configProvider, directory } from "./integration";

/** Goose's launcher reads config.yaml: no subprocess, no usage tracking. */
export function open(account = ""): Launcher {
  const dir = directory(account);
  return {
    async account() {
      const info = new Info();
      const provider = configProvider(dir);
      info.signed_in = provider ? true : null;
      info.account = new Text(provider);
      return info;
    },
    async model() {
      return {
        model: configModel(dir, configProvider(dir)),
        source: "Goose config",
      };
    },
    watches() {
      return [join(dir, "config.yaml")];
    },
    close() {},
  };
}
