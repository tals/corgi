import { Codex } from "./providers/codex";
import { Claude } from "./providers/claude";
export { Codex, Claude };
export * from "./providers/common";
export type Provider = "codex" | "claude";
export const Provider = {
  codex: "codex" as Provider,
  claude: "claude" as Provider,
  all: ["codex", "claude"] as Provider[],
  named(name: string): Provider | null {
    return this.all.find(p => this.info(p).executables.includes(name)) ?? null;
  },
  info(p: Provider) {
    return p === "codex" ? Codex.info : Claude.info;
  },
  backend(p: Provider) {
    return Backend.init(p);
  },
};
export class Backend {
  constructor(public provider: Provider) {}
  static init(provider: Provider) {
    return new Backend(provider);
  }
  get adapter() {
    return this.provider === "codex" ? new Codex() : new Claude();
  }
  hook(v: any) {
    return this.adapter.hook(v);
  }
  nativeEvent(v: any) {
    return this.adapter.nativeEvent(v);
  }
  responseId(v: any) {
    return this.nativeEvent(v).response_id;
  }
  hookEvents() {
    return this.provider === "codex" ? Codex.hook_events : Claude.hook_events;
  }
  titleSession(title: string) {
    return this.provider === "codex" ? Codex.titleSession(title) : Claude.titleSession(title);
  }
}
export class Each<T> {
  values: { codex: T; claude: T };
  constructor(defaultValue: T, named: Partial<Record<Provider, T>> = {}) {
    if (Object.keys(named).some(k => !Provider.all.includes(k as Provider))) throw Error("UnknownField");
    this.values = {
      codex: named.codex ?? structuredClone(defaultValue),
      claude: named.claude ?? structuredClone(defaultValue),
    };
  }
  get(p: Provider) {
    return this.values[p];
  }
  getPtr(p: Provider) {
    return this.values[p];
  }
  getPtrConst(p: Provider) {
    return this.values[p];
  }
  set(p: Provider, value: T) {
    this.values[p] = value;
  }
  toJSON() {
    return this.values;
  }
}
