/** Shared process primitives for Bun integration tests. All deadlines are bounded. */
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createConnection, type Socket } from "node:net";
import { describe, test } from "bun:test";

export const ROOT = resolve(import.meta.dir, "..");
export const EXE = process.env.CORGI_TEST_BIN || `${ROOT}/dist/corgi-test`;
export const sleep = (seconds: number) => Bun.sleep(seconds * 1000);
export const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export const shellJoin = (argv: string[]) => argv.map(quote).join(" ");
export function tempDir(prefix = "corgi-test-") {
  const name = mkdtempSync(`/tmp/${prefix}`);
  return {
    name,
    cleanup: () => rmSync(name, { recursive: true, force: true }),
  };
}
export function writeExecutable(path: string, source: string) {
  mkdirSync(dirname(path), { recursive: true });
  if (!source.startsWith("#!")) source = `#!${process.execPath}\n${source}`;
  else source = source.replace(/^#!\/usr\/bin\/env bun\b/, `#!${process.execPath}`);
  writeFileSync(path, source, { mode: 0o700 });
  return path;
}
export async function deadline<T>(promise: Promise<T>, milliseconds: number, message = "Timed out"): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
export async function run(
  argv: string[],
  options: {
    env?: Record<string, string | undefined>;
    cwd?: string;
    input?: string | Uint8Array;
    timeout?: number;
    check?: boolean;
  } = {},
) {
  const proc = Bun.spawn(argv, {
    env: options.env,
    cwd: options.cwd,
    stdin:
      options.input === undefined
        ? "ignore"
        : new Blob([typeof options.input === "string" ? options.input : new Uint8Array(options.input)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(proc.stdout).text(),
    stderr = new Response(proc.stderr).text();
  try {
    const [out, err, code] = await deadline(
      Promise.all([stdout, stderr, proc.exited]),
      options.timeout ?? 8000,
      `Command timed out: ${argv[0]}`,
    );
    if (options.check !== false) assert.equal(code, 0, `${shellJoin(argv)}: ${code}\n${err}\n${out}`);
    return { stdout: out, stderr: err, code, returncode: code };
  } catch (error) {
    proc.kill("SIGKILL");
    await proc.exited;
    throw error;
  }
}

/** Queues whole lines without losing coalesced or fragmented stream chunks. */
export class Lines {
  private buffer = "";
  private lines: string[] = [];
  private waiting: {
    resolve: (line: string) => void;
    reject: (error: Error) => void;
  }[] = [];
  private ended: Error | null = null;
  feed(chunk: string) {
    this.buffer += chunk;
    let end: number;
    while ((end = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      const waiter = this.waiting.shift();
      if (waiter) waiter.resolve(line);
      else this.lines.push(line);
    }
  }
  /** Drops complete lines nobody has read; returns whether there were any. */
  discard() {
    return this.lines.splice(0).length > 0;
  }
  end(error = new Error("Stream ended before the next line")) {
    this.ended = error;
    for (const waiter of this.waiting.splice(0)) waiter.reject(error);
  }
  next(timeout = 5000): Promise<string> {
    if (this.lines.length) return Promise.resolve(this.lines.shift()!);
    if (this.ended) return Promise.reject(this.ended);
    let waiter: (typeof this.waiting)[number];
    return deadline(
      new Promise<string>((resolve, reject) => {
        waiter = { resolve, reject };
        this.waiting.push(waiter);
      }),
      timeout,
      "Timed out waiting for a complete line",
    ).finally(() => {
      const index = this.waiting.indexOf(waiter);
      if (index >= 0) this.waiting.splice(index, 1);
    });
  }
}
export class JsonSocket {
  socket!: Socket;
  lines = new Lines();
  closed = false;
  static async connect(path: string) {
    const client = new JsonSocket();
    client.socket = createConnection(path);
    client.socket.setEncoding("utf8");
    client.socket.on("data", chunk => client.lines.feed(String(chunk)));
    client.socket.on("end", () => {
      client.closed = true;
      client.lines.end();
    });
    client.socket.on("error", error => {
      client.closed = true;
      client.lines.end(error);
    });
    try {
      await deadline(
        new Promise<void>((resolve, reject) => {
          client.socket.once("connect", resolve);
          client.socket.once("error", reject);
        }),
        3000,
        `Socket connect timed out: ${path}`,
      );
    } catch (error) {
      client.close();
      throw error;
    }
    return client;
  }
  send(value: unknown) {
    this.socket.write(JSON.stringify(value) + "\n");
  }
  async read(timeout = 3000) {
    return JSON.parse(await this.lines.next(timeout));
  }
  async request(value: unknown) {
    this.send(value);
    return this.read();
  }
  close() {
    this.closed = true;
    this.socket.destroy();
    this.lines.end();
  }
}
export class Pty {
  terminal: Bun.Terminal;
  proc!: ReturnType<typeof Bun.spawn>;
  output = "";
  private decoder = new TextDecoder();
  constructor(cols = 80, rows = 24) {
    this.terminal = new Bun.Terminal({
      cols,
      rows,
      data: (_terminal, data) => {
        this.output += this.decoder.decode(data, { stream: true });
      },
    });
  }
  static async spawn(
    argv: string[],
    options: {
      env?: Record<string, string | undefined>;
      cwd?: string;
      cols?: number;
      rows?: number;
    } = {},
  ) {
    const pty = new Pty(options.cols, options.rows);
    pty.start(argv, options);
    return pty;
  }
  start(argv: string[], options: { env?: Record<string, string | undefined>; cwd?: string } = {}) {
    this.proc = Bun.spawn(argv, { ...options, terminal: this.terminal });
    return this.proc;
  }
  write(data: string | Uint8Array) {
    this.terminal.write(data);
  }
  resize(cols: number, rows: number) {
    this.terminal.resize(cols, rows);
  }
  async waitFor(predicate: string | RegExp | ((output: string) => unknown), timeout = 5000) {
    const until = Date.now() + timeout;
    do {
      const result =
        typeof predicate === "string"
          ? this.output.includes(predicate)
          : predicate instanceof RegExp
            ? predicate.test(this.output)
            : predicate(this.output);
      if (result) return this.output;
      await Bun.sleep(10);
    } while (Date.now() < until);
    throw new Error(`PTY output timed out:\n${this.output}`);
  }
  /** Reuse the slave PTY to inspect all flags, speeds and control characters. */
  async settings() {
    const offset = this.output.length;
    const proc = Bun.spawn(["/bin/stty", "-g"], { terminal: this.terminal });
    assert.equal(await deadline(proc.exited, 3000, "stty timed out"), 0);
    await this.waitFor(output => output.slice(offset).includes("\n"), 3000);
    return this.output.slice(offset).trim();
  }
  async close() {
    if (this.proc && this.proc.exitCode === null) {
      this.proc.kill();
      try {
        await deadline(this.proc.exited, 3000);
      } catch {
        this.proc.kill("SIGKILL");
        await this.proc.exited;
      }
    }
    this.terminal.close();
  }
}

/** Small assertion/lifecycle adapter keeps the original scenario names reviewable. */
export class TestCase {
  [key: string]: any;
  private cleanups: (() => unknown | Promise<unknown>)[] = [];
  async setUp() {}
  async tearDown() {}
  addCleanup(fn: (...args: any[]) => unknown, ...args: any[]) {
    this.cleanups.push(() => fn(...args));
  }
  async doCleanups() {
    for (const fn of this.cleanups.reverse()) await fn();
  }
  fail(message?: unknown): never {
    throw new assert.AssertionError({
      message: typeof message === "string" ? message : JSON.stringify(message),
    });
  }
  assertEqual(actual: unknown, expected: unknown, message?: unknown) {
    assert.deepStrictEqual(actual, expected, message as string);
  }
  assertNotEqual(actual: unknown, expected: unknown, message?: unknown) {
    assert.notDeepStrictEqual(actual, expected, message as string);
  }
  assertTrue(value: unknown, message?: unknown) {
    assert.ok(truthy(value), message as string);
  }
  assertFalse(value: unknown, message?: unknown) {
    assert.ok(!truthy(value), message as string);
  }
  assertIn(item: any, collection: any, message?: unknown) {
    assert.ok(
      contains(collection, item),
      (message as string) ?? `${JSON.stringify(item)} not in ${JSON.stringify(collection)}`,
    );
  }
  assertNotIn(item: any, collection: any, message?: unknown) {
    assert.ok(
      !contains(collection, item),
      (message as string) ?? `${JSON.stringify(item)} unexpectedly in ${JSON.stringify(collection)}`,
    );
  }
  assertIsNone(value: unknown, message?: unknown) {
    assert.ok(value == null, message as string);
  }
  assertIsNotNone(value: unknown, message?: unknown) {
    assert.ok(value != null, message as string);
  }
  assertGreater(a: any, b: any, message?: unknown) {
    assert.ok(a > b, (message as string) ?? `${a} <= ${b}`);
  }
  assertGreaterEqual(a: any, b: any, message?: unknown) {
    assert.ok(a >= b, (message as string) ?? `${a} < ${b}`);
  }
  assertLess(a: any, b: any, message?: unknown) {
    assert.ok(a < b, (message as string) ?? `${a} >= ${b}`);
  }
  assertLessEqual(a: any, b: any, message?: unknown) {
    assert.ok(a <= b, (message as string) ?? `${a} > ${b}`);
  }
  assertAlmostEqual(a: number, b: number, places = 7, message?: unknown) {
    assert.ok(Math.abs(a - b) < 10 ** -places, message as string);
  }
  assertRegex(value: string, expression: string | RegExp, message?: unknown) {
    assert.match(value, typeof expression === "string" ? new RegExp(expression) : expression, message as string);
  }
}
function truthy(value: any): boolean {
  if (value && typeof value.then === "function")
    throw new Error("Assertion received a Promise; await the operation first");
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return (value as any).length !== 0;
  if (value instanceof Map || value instanceof Set) return value.size !== 0;
  if (value && Object.getPrototypeOf(value) === Object.prototype) return Object.keys(value).length !== 0;
  return Boolean(value);
}
function contains(collection: any, item: any) {
  if (typeof collection === "string") return collection.includes(item);
  if (Array.isArray(collection)) return collection.some(value => isDeepStrictEqual(value, item));
  if (collection instanceof Set || collection instanceof Map) return collection.has(item);
  return Object.hasOwn(collection, item);
}
// Each concurrent case runs a whole Corgi, and a bare `bun test` starts 20 at once.
let freeSlots = 2;
const slotWaiters: (() => void)[] = [];
async function inSlot(run: () => Promise<void>) {
  if (freeSlots > 0) freeSlots--;
  else await new Promise<void>(resolve => slotWaiters.push(resolve));
  try {
    await run();
  } finally {
    const next = slotWaiters.shift();
    if (next) next();
    else freeSlots++;
  }
}
export function registerCase(
  name: string,
  Suite: new () => TestCase,
  options: {
    timeout?: number;
    inherited?: boolean;
    skip?: boolean | string;
    skipTests?: Record<string, string>;
    /** Cases share no state beyond their own runtime, so they may overlap. */
    concurrent?: boolean;
  } = {},
) {
  const names = new Set<string>();
  for (
    let proto = Suite.prototype;
    proto && proto !== TestCase.prototype;
    proto = options.inherited === false ? null : Object.getPrototypeOf(proto)
  ) {
    for (const key of Object.getOwnPropertyNames(proto))
      if (key.startsWith("test_") && typeof proto[key] === "function") names.add(key);
  }
  describe(name, () => {
    for (const method of [...names].sort()) {
      const register =
        options.skip || options.skipTests?.[method] ? test.skip : options.concurrent ? test.concurrent : test;
      const run = async () => {
        const instance = new Suite();
        try {
          await instance.setUp();
          await instance[method]();
        } finally {
          try {
            await instance.tearDown();
          } finally {
            await instance.doCleanups();
          }
        }
      };
      register(method, options.concurrent ? () => inSlot(run) : run, options.timeout ?? 120_000);
    }
  });
}
