import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, watch, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import * as palette from "./trick_palette";
import * as style from "./trick_style";
import * as tricks from "./tricks";
import * as os from "./os";
import * as settings from "./settings";
import { flock } from "./native_bridge";

export function globalDirectory() {
  const e = process.env;
  return join(e.CORGI_ENV_BASE ?? e.XDG_STATE_HOME ?? join(e.HOME ?? "/", ".local/state"), "corgi/palettes");
}
export class Store {
  private watched: FSWatcher | null = null;
  private pending: ReturnType<typeof setTimeout> | null = null;
  private known = new Map<string, string>();
  constructor(
    readonly local: string,
    readonly global: string,
    private changed: (ref: string, state: palette.State) => void = () => {},
  ) {}
  private path(ref: string) {
    const p = palette.ref(ref);
    return p.owner === null ? join(this.global, p.name + ".json") : join(this.local, p.owner, p.name + ".json");
  }
  private load(ref: string): palette.State | null {
    try {
      const bytes = readFileSync(this.path(ref));
      if (bytes.length > tricks.max_bytes) throw Error("PaletteTooLarge");
      return palette.read(JSON.parse(bytes.toString()));
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return null;
      throw error;
    }
  }
  private publish(ref: string, state: palette.State) {
    const signature = JSON.stringify(state);
    const previous = this.known.get(ref);
    if (previous === signature) return;
    this.known.set(ref, signature);
    if (previous) {
      const before = palette.read(JSON.parse(previous));
      if (
        before.keys.some((key, i) => {
          const index = state.keys.indexOf(key);
          return index < 0 || JSON.stringify(palette.color(before, i)) !== JSON.stringify(palette.color(state, index));
        })
      )
        this.changed(ref, state);
    }
  }
  private watching() {
    if (this.watched) return;
    mkdirSync(this.global, { recursive: true, mode: 0o700 });
    this.watched = watch(this.global, { persistent: false }, (_, file) => {
      if (file && !String(file).endsWith(".json")) return;
      if (this.pending) return;
      this.pending = setTimeout(() => {
        this.pending = null;
        for (const ref of this.known.keys()) {
          if (!ref.startsWith("globals.")) continue;
          try {
            const state = this.load(ref);
            if (state) this.publish(ref, state);
          } catch {
            // A malformed external edit leaves the last valid drawings in place.
          }
        }
      }, 40).unref();
    });
    this.watched.on("error", () => this.close());
  }
  get(ref: string): palette.State {
    const state = this.load(ref);
    if (!state) throw Error("NoPalette");
    if (ref.startsWith("globals.")) this.watching();
    this.publish(ref, state);
    return state;
  }
  list(): palette.Summary[] {
    const scan = (directory: string): string[] => {
      try {
        return readdirSync(directory).slice(0, 256);
      } catch (e) {
        if ((e as { code?: string }).code === "ENOENT") return [];
        throw e;
      }
    };
    const refs = scan(this.global)
      .filter(n => n.startsWith("globals.") && n.endsWith(".json"))
      .map(n => n.slice(0, -5));
    for (const owner of scan(this.local)) {
      try {
        tricks.key(owner);
      } catch {
        continue;
      }
      for (const file of scan(join(this.local, owner)))
        if (file.endsWith(".json")) refs.push(owner + "/" + file.slice(0, -5));
    }
    return refs
      .slice(0, 256)
      .sort()
      .map(ref => palette.summary(ref, this.get(ref)));
  }
  private async change(ref: string, edit: (state: palette.State | null) => palette.State): Promise<palette.State> {
    const file = this.path(ref);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const fd = openSync(file + ".lock", "a", 0o600);
    try {
      let acquired = false;
      for (let attempt = 0; attempt < 50 && !(acquired = flock(fd)); attempt++) await Bun.sleep(10);
      if (!acquired) throw Error("PaletteBusy");
      const before = this.load(ref),
        state = edit(before ? structuredClone(before) : null);
      if (JSON.stringify(before) !== JSON.stringify(state)) {
        state.revision = (before?.revision ?? 0) + 1;
        const bytes = JSON.stringify(state);
        if (Buffer.byteLength(bytes) > tricks.max_bytes) throw Error("PaletteTooLarge");
        os.atomicWrite(file, bytes, 0o600, false);
      }
      if (ref.startsWith("globals.")) this.watching();
      this.publish(ref, state);
      return state;
    } finally {
      closeSync(fd);
    }
  }
  define(owner: string, name: string, colors?: tricks.Color[], legacy?: unknown) {
    const ref = palette.reference(owner, name),
      supplied = colors === undefined ? [...style.palette.identity] : palette.colors(colors);
    return this.change(ref, state => {
      if (state) {
        if (
          ref.startsWith("globals.") &&
          colors !== undefined &&
          JSON.stringify(state.colors) !== JSON.stringify(supplied)
        )
          throw Error("SharedPaletteConflict");
        if (!ref.startsWith("globals.")) state.colors = supplied;
        if (!state.owners.includes(owner)) {
          if (state.owners.length >= 256) throw Error("TooManyPaletteOwners");
          state.owners.push(owner);
        }
        return state;
      }
      let keys: string[] = [];
      if (legacy !== undefined && legacy !== null) {
        const old = tricks.object(legacy);
        if (old.version !== 1) throw Error("InvalidPaletteStore");
        keys = palette.keys(old.keys);
      }
      return {
        version: 1,
        revision: 0,
        colors: supplied,
        scheme: null,
        owners: [owner],
        keys,
        overrides: keys.map(() => null),
      };
    });
  }
  assign(ref: string, encoded: string) {
    palette.keys([encoded]);
    return this.change(ref, state => {
      if (!state) throw Error("NoPalette");
      if (!state.keys.includes(encoded)) {
        if (state.keys.length >= palette.max_entries) throw Error("PaletteFull");
        state.keys.push(encoded);
        state.overrides.push(null);
      }
      return state;
    });
  }
  set(ref: string, key: unknown, color: unknown, all = false) {
    const encoded = all ? null : palette.encode(key),
      override = color === null ? null : tricks.color(color);
    if (override === undefined || (all && override !== null)) throw Error("InvalidPaletteColor");
    return this.change(ref, state => {
      state ??= this.empty();
      if (all) state.overrides.fill(null);
      else {
        let index = state.keys.indexOf(encoded!);
        if (index < 0) {
          if (override === null) return state;
          if (state.keys.length >= palette.max_entries) throw Error("PaletteFull");
          index = state.keys.length;
          state.keys.push(encoded!);
          state.overrides.push(null);
        }
        state.overrides[index] = override;
      }
      return state;
    });
  }
  close() {
    this.watched?.close();
    this.watched = null;
    if (this.pending) clearTimeout(this.pending);
    this.pending = null;
  }
  private empty(): palette.State {
    return {
      version: 1,
      revision: 0,
      colors: [...style.palette.identity],
      scheme: null,
      owners: [],
      keys: [],
      overrides: [],
    };
  }
  scheme(ref: string, value: unknown) {
    const colors = value === null ? null : palette.colors(value);
    return this.change(ref, state => ({ ...(state ?? this.empty()), scheme: colors }));
  }
}
export function open(socket: string, changed: (ref: string, state: palette.State) => void) {
  return new Store(settings.path(socket) + ".palettes", globalDirectory(), changed);
}
