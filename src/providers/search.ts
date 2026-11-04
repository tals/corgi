//! What corgi grep reads from a provider: its conversations as user,
//! assistant and tool messages. Provider stores stay read-only.
import * as fs from "node:fs";
import * as path from "node:path";
import { createZstdDecompress } from "node:zlib";
import * as tools from "./search_tools";
import type { Tool, ToolRecord } from "./search_tools";

/** The decoding this file and search_tools.ts share. Bump it when they decode
 * differently, and every provider's conversations are indexed again. */
export const version = 1;

export type Role = "user" | "assistant" | "tool";
export type Message = { role: Role; timestamp: number | null; ref: string; tool?: Tool; text: string };
export type Normalized = {
  messages: Message[];
  malformed: number;
  partial: number;
  title?: string;
  tools?: Message[];
};
/** A conversation as its provider finds it. */
export type Found = {
  session: string;
  cwd: string;
  /** Where it's read from: its transcript, or its store and session. */
  source: string;
  /** Changes whenever its messages may have. */
  stamp: string;
  bytes: number;
  /** Its last message's time, or its source's until that's read. */
  updated_at: number;
  title?: string;
};
/** What discovery shares across providers and with the discovery before it. */
export type Context = {
  /** What the last discovery found at `source`, while its stamp is unchanged. */
  known(source: string, stamp: string): Found | undefined;
  /** Whether `source` was left out at this stamp; it stays out until it changes. */
  skipped(source: string, stamp: string): boolean;
  /** Leaves `source` out until its stamp changes. */
  exclude(source: string, stamp: string): void;
  warn(text: string): void;
  /** False when another folder already gave this file. */
  claim(file: string): boolean;
  /** Adds sources to check. */
  checking(count: number): void;
  /** Counts one source checked. */
  checked(): Promise<void>;
};
/** A provider's past conversations, as corgi grep reads them. */
export interface Search {
  /** Bump it when this provider decodes differently, and its conversations are
   * indexed again as searches reach them. */
  version: number;
  /** Its default folder, as `env` places it. */
  home(env: NodeJS.ProcessEnv): string;
  /** The variable that names an account's folder, in a process the account runs. */
  env?: string;
  /** The top-level conversations under `folder`, not subagents'. */
  discover(folder: string, context: Context): Promise<Found[]>;
  /** A conversation's messages; `tools` adds its tool calls and results. */
  read(found: Found, tools: boolean): Promise<Normalized>;
}

/** A label comes from the user's request, never the matching tool output. */
export function title(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/\\[nr]|[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/^\s*#+\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}
/** A user or assistant message; anything else, or no text, is none. */
export function prose(role: unknown, text: string, timestamp: unknown, ref: string): Message[] {
  if ((role !== "user" && role !== "assistant") || !text) return [];
  return [{ role, text, timestamp: tools.timestamp(timestamp), ref }];
}
/** Messages as the index keeps them: lines end in "\n", and none trails. */
export function normalize(messages: Message[], malformed = 0, partial = 0): Normalized {
  const records = messages.map(m => ({
    role: m.role,
    timestamp: m.timestamp,
    ref: m.ref,
    ...(m.tool ? { tool: m.tool } : {}),
    text: m.text.replace(/\r\n/g, "\n").replace(/\n$/, ""),
  }));
  const first = messages.find(m => m.role === "user")?.text ?? "";
  return { messages: records, malformed, partial, title: title(first) };
}

/** How a provider's JSONL transcripts read. */
export type Transcripts = Pick<Search, "version" | "home" | "env"> & {
  /** Folders under an account's folder that hold its transcripts. */
  folders(folder: string): string[];
  /** Its transcripts in one, as a glob. */
  pattern: string;
  /** How deep under the folder a transcript may sit, in path segments. */
  depth?: number;
  /** Who and where, from a transcript's first records: null while they don't
   * say, "excluded" for a conversation search leaves out. */
  identity(records: any[]): { session: string; cwd: string } | "excluded" | null;
  /** A record's user and assistant messages. */
  messages(record: any, ref: string): Message[];
  /** A record's tool calls and results. */
  tools(record: any, ref: string): ToolRecord[];
  /** A name the record gives its conversation. */
  title?(record: any): string;
  /** Tools whose results report their outcome in their text. */
  reportsText?(call: string): boolean;
};
/** Decodes a transcript one JSONL line at a time. */
function decoder(spec: Transcripts, withTools: boolean) {
  const messages: Message[] = [],
    records: ToolRecord[] = [];
  let line = 0,
    malformed = 0,
    named = "";
  return {
    line(text: string): void {
      line++;
      if (!text) return;
      try {
        const value = JSON.parse(text);
        named = (spec.title && title(spec.title(value))) || named;
        messages.push(...spec.messages(value, String(line)));
        if (withTools) records.push(...spec.tools(value, String(line)));
      } catch {
        malformed++;
      }
    },
    /** `partial` when the transcript ends inside a record still being written. */
    done(partial: boolean): Normalized {
      const result = normalize(messages, malformed, Number(partial));
      result.title = named || result.title;
      if (withTools) result.tools = normalize(tools.link(records, spec.reportsText)).messages;
      return result;
    },
  };
}
async function* chunks(file: string): AsyncGenerator<Uint8Array> {
  if (!file.endsWith(".jsonl.zst")) {
    yield* Bun.file(file).stream();
    return;
  }
  const input = fs.createReadStream(file),
    decoded = input.pipe(createZstdDecompress());
  input.on("error", error => decoded.destroy(error));
  try {
    for await (const value of decoded) yield value;
  } finally {
    input.destroy();
    decoded.destroy();
  }
}
/** The records in a transcript's first `bytes`; a compressed one's first record. */
async function header(file: string, bytes: number): Promise<any[]> {
  if (file.endsWith(".jsonl.zst")) {
    const parts: Buffer[] = [];
    for await (const value of chunks(file)) {
      const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength),
        end = chunk.indexOf(10);
      parts.push(end < 0 ? chunk : chunk.subarray(0, end));
      if (end >= 0) return [JSON.parse(Buffer.concat(parts).toString())];
    }
    return [];
  }
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(bytes),
      n = fs.readSync(fd, buffer, 0, bytes, 0);
    return buffer
      .subarray(0, n)
      .toString()
      .split("\n")
      .flatMap(line => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } finally {
    fs.closeSync(fd);
  }
}
/** A provider whose conversations are JSONL transcripts, plain or zstd-compressed. */
export function transcripts(spec: Transcripts): Search & { jsonl(input: string, tools?: boolean): Normalized } {
  /** One transcript's conversation; null when it's left out. `stamped` gets its stamp once known. */
  async function transcript(file: string, context: Context, stamped: (stamp: string) => void): Promise<Found | null> {
    if (file.endsWith(".jsonl.zst") && fs.existsSync(file.slice(0, -4))) return null;
    if (file.includes("/subagents/") || !context.claim(fs.realpathSync(file))) return null;
    const s = fs.statSync(file),
      stamp = `${s.ino}:${s.size}:${s.mtimeMs}`;
    stamped(stamp);
    if (context.skipped(file, stamp)) {
      context.exclude(file, stamp);
      return null;
    }
    const known = context.known(file, stamp);
    if (known) return known;
    let span = Math.min(s.size, 128 * 1024),
      identity: ReturnType<Transcripts["identity"]>;
    for (;;) {
      identity = spec.identity(await header(file, span));
      if (identity || span === s.size || file.endsWith(".jsonl.zst")) break;
      span = Math.min(s.size, span * 2);
    }
    if (!identity) context.warn(`No session identity in transcript: ${file}`);
    if (!identity || identity === "excluded") {
      context.exclude(file, stamp);
      return null;
    }
    return identity.session && identity.cwd
      ? { ...identity, source: file, stamp, bytes: s.size, updated_at: s.mtimeMs }
      : null;
  }
  return {
    version: spec.version,
    home: spec.home,
    env: spec.env,
    async discover(root, context) {
      const files = spec
        .folders(root)
        .flatMap(folder =>
          fs.existsSync(folder)
            ? [...new Bun.Glob(spec.pattern).scanSync({ cwd: folder, absolute: true, onlyFiles: true })].filter(
                file => !spec.depth || path.relative(folder, file).split(path.sep).length <= spec.depth,
              )
            : [],
        );
      files.sort((a, b) => Number(a.endsWith(".zst")) - Number(b.endsWith(".zst")) || a.localeCompare(b));
      context.checking(files.length);
      const found: Found[] = [];
      for (const file of files) {
        await context.checked();
        let stamp = "";
        try {
          const one = await transcript(file, context, (s: string) => (stamp = s));
          if (one) found.push(one);
        } catch (error) {
          // A transcript that vanished, can't be read or doesn't decode is
          // skipped until it changes; the rest of the folder still counts.
          context.warn(`Unreadable transcript skipped: ${file}: ${error}`);
          if (stamp) context.exclude(file, stamp);
        }
      }
      return found;
    },
    /** Streamed: some transcripts run to hundreds of megabytes. */
    async read(found, withTools) {
      const decoded = decoder(spec, withTools);
      let fragments: Buffer[] = [],
        bytes = 0;
      for await (const value of chunks(found.source)) {
        const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        let start = 0;
        while (start < chunk.length) {
          const end = chunk.indexOf(10, start);
          const segment = chunk.subarray(start, end < 0 ? chunk.length : end);
          fragments.push(segment);
          bytes += segment.length;
          if (end < 0) break;
          decoded.line((fragments.length === 1 ? segment : Buffer.concat(fragments, bytes)).toString());
          fragments = [];
          bytes = 0;
          start = end + 1;
        }
      }
      return decoded.done(bytes > 0);
    },
    jsonl(input, withTools = false) {
      const decoded = decoder(spec, withTools);
      let start = 0;
      for (let end; (end = input.indexOf("\n", start)) >= 0; start = end + 1) decoded.line(input.slice(start, end));
      return decoded.done(start < input.length);
    },
  };
}
