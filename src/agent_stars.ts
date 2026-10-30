import { Provider } from "./providers";

export interface Session {
  provider: Provider;
  session: string;
}
/** Stars follow conversations after their panes close. */
export class Stars {
  items: Session[] = [];
  slice(): Session[] {
    return this.items.map(item => ({ ...item }));
  }
  has(provider: Provider, session: string): boolean {
    return this.items.some(item => item.provider === provider && item.session === session);
  }
  set(provider: Provider, session: string, starred: boolean): boolean {
    if (starred && !valid(session)) return false;
    const index = this.items.findIndex(item => item.provider === provider && item.session === session);
    if (starred === index >= 0) return false;
    if (starred) this.items.push({ provider, session });
    else this.items.splice(index, 1);
    return true;
  }
  static restore(value: unknown): Stars {
    if (!Array.isArray(value)) throw Error("InvalidAgentStars");
    const stars = new Stars();
    for (const item of value) {
      if (!item || typeof item !== "object" || typeof item.provider !== "string" || typeof item.session !== "string")
        throw Error("InvalidAgentStars");
      const provider = Provider.parse(item.provider);
      if (provider) stars.set(provider, item.session, true);
    }
    return stars;
  }
}
function valid(session: string): boolean {
  return session.length > 0 && Buffer.byteLength(session) <= 160 && !/[\x00-\x1f\x7f\ufffd]/.test(session);
}
