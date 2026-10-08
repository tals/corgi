import { createHash } from "node:crypto";
import { mkdirSync, chmodSync, readdirSync, lstatSync, unlinkSync, writeFileSync, renameSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { BoundedText } from "./bounded_text";

export type Support = "probing" | "on" | "unsupported" | "denied";
export type Failure =
  | "denied"
  | "host_error"
  | "timed_out"
  | "too_large"
  | "not_image"
  | "save_failed"
  | "busy"
  | "not_pane"
  | "unsupported_image";
export const Failure = {
  message(f: Failure): string {
    return {
      denied: "The terminal refused to send the clipboard",
      host_error: "The terminal couldn't send the clipboard",
      timed_out: "The terminal stopped sending the clipboard",
      too_large: "Images over 32 MB don't paste",
      not_image: "The clipboard image was damaged",
      save_failed: "Couldn't save the pasted image",
      busy: "Still pasting the previous image",
      not_pane: "Images paste into a pane",
      unsupported_image: "Corgi pastes PNG, JPEG, GIF and WebP images",
    }[f];
  },
};
export type Relay = { text: string | null; image: { mime: string; path: string } | null };
export type Result = { text: string } | { path: string } | { relay: Relay } | { failed: Failure };
export type Choice = { read: string } | { refuse: Failure } | "nothing";
const images = [
  { mime: "image/png", extension: "png", magic: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) },
  { mime: "image/jpeg", extension: "jpg", magic: Buffer.from([255, 216, 255]) },
  { mime: "image/gif", extension: "gif", magic: Buffer.from("GIF8") },
  { mime: "image/webp", extension: "webp", magic: Buffer.from("RIFF") },
];
const lists = (listing: string, mime: string) => listing.split(/\s+/).includes(mime);
export function relayTypes(listing: string): string[] {
  const types = lists(listing, "text/plain") ? ["text/plain"] : [];
  const image = images.find(i => lists(listing, i.mime));
  if (image) types.push(image.mime);
  return types;
}
export function choose(listing: string, pane: boolean): Choice {
  if (lists(listing, "text/plain")) return { read: "text/plain" };
  const image = images.find(i => lists(listing, i.mime));
  if (image) return pane ? { read: image.mime } : { refuse: "not_pane" };
  return listing.split(/\s+/).some(m => m.startsWith("image/")) ? { refuse: "unsupported_image" } : "nothing";
}
export type Key = "cmd" | "ctrl_shift" | "ctrl";
export class Notice {
  body = new (BoundedText(96))();
  parts: { kind: "text" | "link" | "key"; text: InstanceType<ReturnType<typeof BoundedText>> }[] = [];
  get count() {
    return this.parts.length;
  }
  fix() {
    return this.parts;
  }
  add(kind: "text" | "link" | "key", text: string) {
    this.parts.push({ kind, text: new (BoundedText(64))(text) });
  }
  enable(lead: string, key: string) {
    this.add("text", `${lead} to enable paste with `);
    this.add("key", key);
    this.add("text", ".");
  }
}
export const nightly_url = "https://github.com/ghostty-org/ghostty/releases/tag/tip";
export const enable = "\x1b[?5522h";
export const disable = "\x1b[?5522l";
const max_bytes = 32 * 1024 * 1024,
  max_relayed_text = 512 * 1024,
  answer_ms = 3000,
  stall_ms = 10_000,
  keep_ms = 86_400_000;
const statuses = new Set(["DATA", "DONE", "EBUSY", "EFBIG", "EINVAL", "EIO", "ENOSYS", "EPERM", "OK"]);
function decode(data: string): Buffer | null {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) return null;
  return Buffer.from(data, "base64");
}
type Packet = { status: string; id: string; mime: string; pw: string; payload: string };
function packet(raw: string): Packet | null {
  const split = raw.indexOf(";"),
    p: Packet = { status: "", id: "", mime: "", pw: "", payload: split < 0 ? "" : raw.slice(split + 1) };
  let read = false;
  for (const field of (split < 0 ? raw : raw.slice(0, split)).split(":")) {
    const eq = field.indexOf("=");
    if (eq < 0) return null;
    const k = field.slice(0, eq),
      v = field.slice(eq + 1);
    if (k === "type") read = v === "read";
    else if (k === "status" || k === "id" || k === "mime" || k === "pw") p[k] = v;
  }
  return read && statuses.has(p.status) ? p : null;
}
type Reading = { mimes: string[]; data: Buffer[][]; size: number; relay: boolean; too_large: boolean };
export class State {
  support: Support = "probing";
  terminal = new (BoundedText(64))();
  os: "unknown" | "macos" | "linux" = "unknown";
  folder = "";
  out = "";
  asking: "none" | "mode" | "list" = "none";
  answer_by = 0;
  event: { phase: "none" | "receiving" | "ready"; pw: string; listing: string } = {
    phase: "none",
    pw: "",
    listing: "",
  };
  reading: Reading | null = null;
  stall_by = 0;
  result: Result | null = null;
  deinit() {
    this.out = "";
    this.reading = null;
    this.result = null;
  }
  takeOutput() {
    const output = this.out;
    this.out = "";
    return output;
  }
  start(now: number) {
    this.support = "probing";
    this.asking = "mode";
    this.answer_by = now + answer_ms;
    this.out += "\x1b[?5522$p\x1b[>0q";
  }
  modeReport(value: number, now: number) {
    if (this.asking !== "mode") return;
    if (value !== 1 && value !== 2) return this.settle("unsupported");
    this.asking = "list";
    this.answer_by = now + answer_ms;
    this.out += "\x1b]5522;type=read:id=corgi-probe;Lg==\x1b\\";
  }
  terminalName(reported: string) {
    this.terminal = BoundedText(64).ascii(reported);
  }
  packet(raw: string, now: number) {
    const p = packet(raw);
    if (!p) return;
    if (p.id === "corgi-probe") return this.probeReply(p);
    if (p.id === "corgi") return this.readReply(p, now);
    if (!p.id && p.pw) this.eventPacket(p);
  }
  takeEvent(): string | null {
    if (this.event.phase !== "ready") return null;
    this.event.phase = "none";
    return this.event.listing;
  }
  request(mime: string, now: number) {
    return this.read([mime], false, now);
  }
  relay(types: string[], now: number) {
    return this.read(types, true, now);
  }
  private read(mimes: string[], relay: boolean, now: number) {
    if (this.reading) return false;
    if (mimes.length < 1 || mimes.length > 2) throw Error("InvalidMimeCount");
    this.out += `\x1b]5522;type=read:id=corgi:pw=${this.event.pw}:name=Q29yZ2k=;${Buffer.from(mimes.join(" ")).toString("base64")}\x1b\\`;
    this.reading = { mimes: [...mimes], data: mimes.map(() => []), size: 0, relay, too_large: false };
    this.stall_by = now + stall_ms;
    return true;
  }
  takeResult(): Result | null {
    const result = this.result;
    this.result = null;
    return result;
  }
  tick(now: number) {
    if (this.asking !== "none" && now >= this.answer_by) this.settle("unsupported");
    if (this.reading && now >= this.stall_by) this.fail("timed_out");
  }
  notice(key: Key, agent: string, host: string): Notice | null {
    if (key === "cmd") this.os = "macos";
    else if (key === "ctrl_shift") this.os = "linux";
    const n = new Notice(),
      linux = this.onLinux(),
      paste = linux ? "Ctrl+Shift+V" : "⌘+V",
      program = this.programName();
    const body = (s: string) => {
      n.body = new (BoundedText(96))(s);
    };
    switch (this.support) {
      case "probing":
        return null;
      case "on":
        if (key !== "ctrl") return null;
        body(`${agent} reads the clipboard on ${host}.`);
        n.add("text", linux ? "Paste images with " : "Paste images from your Mac with ");
        n.add("key", paste);
        n.add("text", ".");
        break;
      case "denied":
        body(
          program === "ghostty"
            ? "Ghostty is set to refuse clipboard reads."
            : `${this.displayName()} refuses clipboard reads.`,
        );
        n.enable(program === "ghostty" ? "Set clipboard-read = ask" : "Allow clipboard reads", paste);
        break;
      case "unsupported":
        if (this.multiplexer()) {
          body(`${program} sits between Corgi and your terminal.`);
          n.enable(`Run Corgi outside ${program}`, paste);
        } else if (linux) {
          body(`${capitalized(program)} on Linux can't send images over SSH yet.`);
          n.add("text", "Only Ghostty Nightly on macOS can, for now.");
        } else {
          body(`${this.displayName()} can't send images over SSH.`);
          n.add("text", "Use ");
          n.add("link", "Ghostty Nightly");
          n.add("text", " to enable paste with ");
          n.add("key", paste);
          n.add("text", ".");
        }
    }
    return n;
  }
  private onLinux() {
    return this.os !== "unknown"
      ? this.os === "linux"
      : this.support === "unsupported" && this.programName() === "ghostty" && this.terminal.text().includes("+");
  }
  private programName() {
    return this.terminal.text().split(" ", 1)[0];
  }
  private displayName() {
    return capitalized(this.terminal.text()) || "This terminal";
  }
  status(): string {
    switch (this.support) {
      case "probing":
        return "checking";
      case "on":
        return "● On";
      case "denied":
        return "○ clipboard-read = deny";
      case "unsupported":
        return this.multiplexer() ? `○ ${this.programName()} in between` : "○ no paste events";
    }
  }
  private multiplexer() {
    return ["tmux", "screen"].includes(this.programName());
  }
  private settle(support: Support) {
    this.support = support;
    this.asking = "none";
  }
  private probeReply(p: Packet) {
    if (this.asking !== "list") return;
    switch (p.status) {
      case "OK":
      case "DATA":
        break;
      case "DONE":
        this.settle("on");
        this.out += enable;
        break;
      case "EPERM":
        this.settle("denied");
        break;
      default:
        this.settle("unsupported");
    }
  }
  private eventPacket(p: Packet) {
    switch (p.status) {
      case "OK":
        if (Buffer.byteLength(p.pw) <= 256) this.event = { phase: "receiving", pw: p.pw, listing: "" };
        break;
      case "DATA":
        if (this.event.phase === "receiving" && decode(p.mime)?.toString() === ".") {
          const data = decode(p.payload);
          if (data && data.length <= 4096) this.event.listing = BoundedText(4096).ascii(data.toString()).text();
        }
        break;
      case "DONE":
        if (this.event.phase === "receiving") this.event.phase = "ready";
        break;
      default:
        this.event = { phase: "none", pw: "", listing: "" };
    }
  }
  private readReply(p: Packet, now: number) {
    const reading = this.reading;
    if (!reading) return;
    this.stall_by = now + stall_ms;
    switch (p.status) {
      case "OK":
        break;
      case "DATA": {
        if (reading.too_large) return;
        const i = reading.mimes.indexOf(decode(p.mime)?.toString() ?? "");
        if (i < 0) return;
        const bytes = decode(p.payload);
        if (!bytes) return this.fail("host_error");
        if (reading.size + bytes.length > max_bytes) {
          reading.too_large = true;
          return;
        }
        reading.data[i].push(bytes);
        reading.size += bytes.length;
        break;
      }
      case "DONE":
        this.finish(now);
        break;
      case "EPERM":
        this.fail("denied");
        break;
      default:
        this.fail("host_error");
    }
  }
  private finish(now: number) {
    const reading = this.reading!;
    this.reading = null;
    if (reading.too_large) {
      this.result = { failed: "too_large" };
      return;
    }
    const data = reading.data.map(chunks => Buffer.concat(chunks));
    if (reading.relay) {
      const relay: Relay = { text: null, image: null };
      reading.mimes.forEach((mime, i) => {
        if (!data[i].length) return;
        if (mime === "text/plain") {
          if (data[i].length <= max_relayed_text) relay.text = data[i].toString();
        } else
          try {
            relay.image = { mime, path: saveImage(this.folder, mime, data[i], now) };
          } catch {}
      });
      this.result = { relay };
      return;
    }
    if (reading.mimes[0] === "text/plain") {
      this.result = { text: data[0].toString() };
      return;
    }
    try {
      this.result = { path: saveImage(this.folder, reading.mimes[0], data[0], now) };
    } catch (error) {
      this.result = { failed: error instanceof Error && error.message === "NotImage" ? "not_image" : "save_failed" };
    }
  }
  private fail(failed: Failure) {
    this.reading = null;
    this.result = { failed };
  }
}
const capitalized = (text: string) => (text ? text[0].toUpperCase() + text.slice(1) : "");
export function saveImage(folder: string, mime: string, data: Uint8Array, now: number): string {
  const image = images.find(i => i.mime === mime),
    bytes = Buffer.from(data);
  if (
    !image ||
    !bytes.subarray(0, image.magic.length).equals(image.magic) ||
    (image.extension === "webp" && bytes.subarray(8, 12).toString() !== "WEBP")
  )
    throw Error("NotImage");
  if (!isAbsolute(folder)) throw Error("RelativeFolder");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const dir = lstatSync(folder);
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid?.()) throw Error("UnsafeDirectory");
  chmodSync(folder, 0o700);
  for (const file of readdirSync(folder, { withFileTypes: true }))
    if (file.isFile())
      try {
        const path = join(folder, file.name);
        if (now - lstatSync(path).mtimeMs > keep_ms) unlinkSync(path);
      } catch {}
  const path = join(folder, createHash("sha256").update(bytes).digest("hex").slice(0, 32) + "." + image.extension),
    tmp = path + "." + crypto.randomUUID() + ".tmp";
  try {
    writeFileSync(tmp, bytes, { flag: "wx", mode: 0o600 });
    renameSync(tmp, path);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
  return path;
}
