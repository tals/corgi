// The conversation index's core: conversations as cached messages, and their
// search. Each provider finds and reads its own conversations (`providers/search.ts`).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import * as grepRegex from "./conversation_grep_regex";
import { Provider, adapter } from "./providers";
import * as providerSearch from "./providers/search";
import type { Context, Found, Message, Normalized, Position, Role, Search } from "./providers/search";
import type { Tool } from "./providers/search_tools";

/** A conversation as the index keeps it. */
type Source = Found & {
  key: string;
  provider: Provider;
  /** The account folder it was found in. */
  account: string;
  title: string;
  /** Its cache file, in the cache directory. */
  file: string;
  messages: number;
  lines: number;
  text_bytes: number;
  indexed_stamp?: string;
  tools_stamp?: string;
  /** The decoding its cache files were written with, as `versions` gives it. */
  indexed_version?: string;
  tools_version?: string;
  /** Where indexing its JSONL transcript stopped, so a grown one is read on
   * from there, and the stamp it stopped at: another that wrote the index without
   * knowing this field changes `indexed_stamp` alone. */
  indexed_end?: Position & { stamp: string };
  /** The bytes just before `indexed_end`, which a transcript that only grew still has. */
  indexed_tail?: string;
};
type Manifest = {
  version: 1;
  as_of: string;
  sources: Source[];
  discovery_ms: number;
  prepare_ms: number;
  warnings: string[];
  malformed: number;
  partial: number;
  refreshed?: number;
  reused?: number;
  ignored?: { source: string; stamp: string; failed?: boolean }[];
};
type Hit = {
  lane?: "text" | "tools";
  /** The message's line in the cache file. */
  line: number;
  /** Position among the lane's lines, to tell adjacent lines from gaps. */
  seq: number;
  text: string;
  context: boolean;
  role: Role;
  timestamp: number | null;
  ref: string;
  message_line: number;
  tool?: Tool;
  submatches: { start: number; end: number }[];
};
type Match = { source: Source; hits: Hit[]; count_limited?: boolean };
type Options = grepRegex.Flags & {
  workspace: string;
  /** Folders besides the workspace's, such as worktrees outside it. */
  folders?: string[];
  age: number;
  patterns: string[];
  limit: number;
  maxCount: number;
  context: number;
  before?: number;
  after?: number;
  tools?: boolean;
  session?: string;
  provider?: Provider;
  asOf: number;
  progress?: (matches: Match[], scanned: number, total: number, limited: boolean) => Promise<void>;
  /** Where the search gets a conversation's messages; null skips it. */
  open?: (source: Source) => Promise<Lanes | null>;
  /** Whether `open` just reads a conversation's saved copy, so it can start
   * early; one it would index waits until the search reaches it. Every one
   * for the default `open`, none for another without this. */
  ready?: (source: Source) => boolean;
  /** Each matching conversation as soon as it's searched; false stops the search. */
  found?: (match: Match) => Promise<boolean>;
};
type Lanes = { text: Iterable<Message>; tools?: Iterable<Message> };
/** An account folder, and the provider whose conversations it holds. */
type Location = { provider: Provider; root: string };
const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);
let loaded: Promise<Map<Provider, Search>> | undefined;
/** Each provider's search, in the order Corgi lists providers. */
function searches(): Promise<Map<Provider, Search>> {
  return (loaded ??= Promise.all(Provider.all.map(async p => [p, await adapter(p).search?.()] as const)).then(
    list => new Map(list.flatMap(([p, search]) => (search ? [[p, search] as const] : []))),
  ));
}
/** Each provider's decoding: what its providers share, then its own. */
async function versions(): Promise<Map<Provider, string>> {
  return new Map([...(await searches())].map(([p, search]) => [p, `${providerSearch.version}.${search.version}`]));
}
/** A cached conversation is JSONL with one message per line, so line N of the
 * file is the message a hit numbered N came from. */
function serialize(messages: Message[]): string {
  return messages.map(m => JSON.stringify(m) + "\n").join("");
}
function records(file: string): Message[] {
  return Bun.JSONL.parse(file) as Message[];
}
type Line = { text: string; line: number; message_line: number; seq: number; message: Message };
/** Each message's lines; one `skip` passes over is counted, not split. */
function* lines(messages: Iterable<Message>, skip?: (text: string) => boolean): Generator<Line> {
  let line = 0,
    seq = 0;
  for (const message of messages) {
    line++;
    if (skip?.(message.text)) {
      for (let at = message.text.indexOf("\n"); at >= 0; at = message.text.indexOf("\n", at + 1)) seq++;
      seq++;
      continue;
    }
    let message_line = 0;
    for (const text of message.text.split("\n"))
      yield { text, line, message_line: ++message_line, seq: ++seq, message };
  }
}
/** A conversation's messages from its cache files. */
async function cached(cache: string, source: Source, tools = false): Promise<{ text: Message[]; tools?: Message[] }> {
  const text = records(await Bun.file(path.join(cache, source.file)).text());
  if (!tools) return { text };
  return { text, tools: records(await Bun.file(path.join(cache, source.key + ".tools.jsonl")).text()) };
}
/** Records a conversation's extent and last message time on its source. */
function measure(source: Source, messages: Message[]): void {
  let latest: number | null = null;
  source.messages = messages.length;
  source.lines = 0;
  source.text_bytes = 0;
  for (const m of messages) {
    source.lines += m.text.split("\n").length;
    source.text_bytes += Buffer.byteLength(m.text) + 1;
    if (m.timestamp !== null && (latest === null || m.timestamp > latest)) latest = m.timestamp;
  }
  if (latest !== null) source.updated_at = latest;
}
/** Replaced whole, so a search that reads without the index lock never sees half a file. */
function replace(file: string, text: string): void {
  fs.writeFileSync(file + ".new", text, { mode: 0o600 });
  fs.renameSync(file + ".new", file);
}
/** Writes a conversation's cache files and records their extent on its source. */
function store(cache: string, source: Source, normalized: Normalized): void {
  const { messages, tools } = normalized;
  measure(source, messages);
  replace(path.join(cache, source.file), serialize(messages));
  if (tools) replace(path.join(cache, source.key + ".tools.jsonl"), serialize(tools));
}
/** A conversation's messages, read by its provider. */
async function read(source: Source, tools = false): Promise<Normalized> {
  const search = (await searches()).get(source.provider);
  if (!search) throw Error(`${source.provider} conversations can't be searched`);
  return search.read(source, tools);
}
/** The messages `source`'s transcript gained past `from`; null where its provider can't read on. */
async function readOn(source: Source, from: Position): Promise<Normalized | null> {
  const search = (await searches()).get(source.provider);
  return search?.readOn ? search.readOn(source, from) : null;
}
/** The 32 bytes of `file` before `at`, as text to compare. */
function tail(file: string, at: number): string {
  const fd = fs.openSync(file, "r");
  try {
    const bytes = Buffer.alloc(Math.min(32, at));
    fs.readSync(fd, bytes, 0, bytes.length, at - bytes.length);
    return bytes.toString("base64");
  } finally {
    fs.closeSync(fd);
  }
}
/** A settings file's value; missing or malformed settings leave the defaults. */
function json(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
/** Every account's folder: each provider's default, Corgi's other accounts, and
 * the one this process runs under, which an account pane or the prompt sets
 * apart from the default. */
export async function roots(env = process.env, h = os.homedir()): Promise<Location[]> {
  const all = await searches(),
    list: Location[] = [];
  for (const [provider, search] of all)
    list.push({ provider, root: search.home({ ...env, HOME: h, ...(search.env ? { [search.env]: undefined } : {}) }) });
  const accounts = path.join(
    env.CORGI_ENV_BASE || env.XDG_STATE_HOME || path.join(h, ".local/state"),
    "corgi/accounts.json",
  );
  for (const a of json(accounts)?.accounts ?? []) {
    const provider = Provider.parse(a?.provider);
    if (provider && all.has(provider) && typeof a.dir === "string") list.push({ provider, root: a.dir });
  }
  // Pi and omp share PI_CODING_AGENT_DIR, so a folder already listed keeps its provider.
  const extra = [...all].flatMap(([provider, search]) => (search.env ? [{ provider, root: env[search.env] }] : []));
  const seen = new Set<string>(),
    folders = new Set<string>();
  const kept = list.filter(r => {
    if (!fs.existsSync(r.root)) return false;
    r.root = fs.realpathSync(r.root);
    const key = r.provider + ":" + r.root;
    if (seen.has(key)) return false;
    seen.add(key);
    folders.add(r.root);
    return true;
  });
  for (const { provider, root } of extra) {
    if (!root || !fs.existsSync(root)) continue;
    const real = fs.realpathSync(root);
    if (folders.has(real)) continue;
    folders.add(real);
    kept.push({ provider, root: real });
  }
  return kept;
}
/** Every conversation the providers find in `locations`. An entry whose stamp
 * hasn't changed comes from `previous` as it was; a folder its provider fails
 * to read keeps its entries, so their cache files survive. */
async function discover(
  previous: Source[] = [],
  locations?: Location[],
  progress?: (scanned: number, total: number) => Promise<void>,
  ignored: NonNullable<Manifest["ignored"]> = [],
): Promise<{ sources: Source[]; warnings: string[]; ignored: NonNullable<Manifest["ignored"]> }> {
  const all = await searches(),
    found = new Map<string, Source>(),
    prior = new Map(previous.map(s => [s.source, s])),
    byKey = new Map(previous.map(s => [s.key, s])),
    skipped = new Map(ignored.map(s => [s.source, s])),
    excluded: NonNullable<Manifest["ignored"]> = [],
    warnings: string[] = [],
    claimed = new Set<string>();
  let scanned = 0,
    total = 0,
    reported = performance.now();
  for (const { provider, root } of locations ?? (await roots())) {
    const search = all.get(provider);
    if (!search) continue;
    const context: Context = {
      known(source, stamp) {
        const old = prior.get(source);
        return old?.stamp === stamp && old.provider === provider && old.account === root ? old : undefined;
      },
      skipped: (source, stamp) => skipped.get(source)?.stamp === stamp,
      seen(source) {
        const old = prior.get(source);
        if (old && old.provider === provider && old.account === root) return { found: old };
        const left = skipped.get(source);
        return !left || left.failed ? null : { excluded: left.stamp };
      },
      // One still at the stamp it failed at stays failed.
      exclude(source, stamp, failed) {
        const left = skipped.get(source);
        failed ??= left?.stamp === stamp && left.failed;
        excluded.push({ source, stamp, ...(failed ? { failed } : {}) });
      },
      warn: text => void warnings.push(text),
      claim: file => !claimed.has(file) && !!claimed.add(file),
      checking: count => void (total += count),
      checked() {
        scanned++;
        if (!progress || performance.now() - reported < 100) return;
        reported = performance.now();
        return progress(scanned, total).then(() => {
          reported = performance.now();
        });
      },
    };
    let list: Found[];
    try {
      list = await search.discover(root, context);
    } catch (error) {
      warnings.push(`${provider} conversations in ${root} unreadable; kept as last indexed: ${error}`);
      list = previous.filter(s => s.provider === provider && s.account === root);
    }
    for (const f of list) {
      // One the last discovery found here comes back as it was, key and all.
      const old = (f as Partial<Source>).key ? (f as Source) : undefined,
        mine = old?.provider === provider && old.account === root && old.session === f.session;
      const key = mine ? old.key : hash(provider + "\0" + root + "\0" + f.session);
      if (found.has(key)) continue;
      if (mine) {
        found.set(key, old);
        continue;
      }
      const base = { title: "", messages: 0, lines: 0, text_bytes: 0 };
      found.set(key, { ...base, ...byKey.get(key), ...f, key, provider, account: root, file: key + ".jsonl" });
    }
  }
  return { sources: [...found.values()], warnings, ignored: excluded };
}
function selected(manifest: Manifest, options: Options): Source[] {
  const all = options.workspace === "*",
    folders = all ? [] : [options.workspace, ...(options.folders ?? [])].map(f => path.resolve(f));
  const holds = (folder: string, cwd: string) =>
    cwd === folder || cwd.startsWith(folder === path.sep ? folder : folder + path.sep);
  return manifest.sources
    .filter(
      e =>
        (all || folders.some(f => holds(f, e.cwd))) &&
        (!options.age || e.updated_at >= options.asOf - options.age) &&
        (!options.provider || e.provider === options.provider) &&
        (!options.session || `${e.provider}:${e.session}` === options.session || e.session === options.session),
    )
    .sort((a, b) => b.updated_at - a.updated_at || a.key.localeCompare(b.key));
}
function hit(line: Line, submatches: Hit["submatches"], context: boolean): Hit {
  const m = line.message;
  return {
    line: line.line,
    seq: line.seq,
    text: line.text,
    context,
    role: m.role,
    timestamp: m.timestamp,
    ref: m.ref,
    ...(m.tool ? { tool: m.tool } : {}),
    message_line: line.message_line,
    submatches,
  };
}
function query(options: Options): grepRegex.Query {
  return {
    patterns: options.patterns,
    case: options.case,
    fixed: options.fixed,
    word: options.word,
    line: options.line,
    before: options.before ?? options.context,
    after: options.after ?? options.context,
    maxCount: options.maxCount,
  };
}
/** Conversations read ahead of the one being searched. */
const read_ahead = 32;
/** Searches conversations in order, so each one's hits can be shown before
 * the next is searched, while the next ones are already being read. */
async function search(cache: string, sources: Source[], options: Options): Promise<Match[]> {
  const regexQuery = query(options),
    regex = grepRegex.compile(regexQuery),
    // A match in one of a message's lines is a match in its text, ^ and $ at
    // line ends, so without context to show, a message this misses is passed
    // over. A pattern's own negative lookaround, as (?<!.) has, or a
    // backreference to what a lookahead took would see the line breaks a line
    // doesn't, so then every message is read.
    whole = new RegExp(regex.source, regex.flags.replace(/[gy]/g, "") + "m"),
    around = !regexQuery.fixed && regexQuery.patterns.some(p => /\(\?<?!|\\[1-9]|\\k</.test(p)),
    skip = regexQuery.before || regexQuery.after || around ? undefined : (text: string) => !whole.test(text),
    matches: Match[] = [],
    open = options.open ?? (source => cached(cache, source, options.tools)),
    limited = () => !!options.limit && matches.length >= options.limit,
    ready = options.ready ?? (() => !options.open),
    reading = new Map<number, Promise<Lanes | null>>();
  let reported = -Infinity,
    scanned = 0,
    ahead = 0;
  try {
    for (let at = 0; at < sources.length; at++) {
      for (ahead = Math.max(ahead, at + 1); ahead < Math.min(sources.length, at + read_ahead); ahead++)
        if (ready(sources[ahead])) {
          const lanes = open(sources[ahead]);
          // Its failure surfaces when the search reaches it.
          lanes.catch(() => {});
          reading.set(ahead, lanes);
        }
      const lanes = reading.get(at) ?? open(sources[at]);
      reading.delete(at);
      if (!(await searched(sources[at], await lanes))) break;
    }
  } finally {
    // What's still being read ends before the search does.
    await Promise.allSettled(reading.values());
  }
  await options.progress?.(matches, scanned, sources.length, limited());
  return matches;

  /** Searches one conversation's messages; false once the search is done. */
  async function searched(source: Source, lanes: Lanes | null): Promise<boolean> {
    scanned++;
    if (lanes) {
      const match: Match = { source, hits: [] };
      for (const lane of ["text", "tools"] as const) {
        const messages = lanes[lane];
        if (!messages) continue;
        await grepRegex.scan(regexQuery, regex, lines(messages, skip), async row => {
          const h = hit(row.line, row.submatches, row.type === "context");
          h.lane = lane;
          match.hits.push(h);
        });
      }
      if (match.hits.length) {
        match.count_limited = (["text", "tools"] as const).some(
          lane => match.hits.filter(h => !h.context && h.lane === lane).length >= options.maxCount,
        );
        matches.push(match);
        if (options.found && !(await options.found(match))) return false;
      }
    }
    if (limited()) return false;
    if (options.progress && performance.now() - reported >= 80) {
      await options.progress(matches, scanned, sources.length, false);
      reported = performance.now();
    }
    return true;
  }
}

export { measure, store, cached, records, read, readOn, tail, search, selected, discover, versions };
export type { Message, Lanes, Source, Normalized, Manifest, Hit, Match, Options, Location };
