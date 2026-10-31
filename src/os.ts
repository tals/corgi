import {
  mkdirSync,
  readFileSync,
  readdirSync,
  existsSync,
  readSync,
  readlinkSync,
  openSync,
  closeSync,
  writeSync,
  fsyncSync,
  renameSync,
  statSync,
  lstatSync,
  unlinkSync,
  chmodSync,
  accessSync,
  constants,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { userInfo } from "node:os";
import { randomUUID } from "node:crypto";
import { n, ptr } from "./native_ffi";
export const max_path_bytes = 4096;
export const env = (name: string): string | null => process.env[name] ?? null;
export class Stat {
  constructor(
    public dev: bigint,
    public ino: bigint,
    public mode: number,
    public uid: number,
  ) {}
  isDir() {
    return (this.mode & 0o170000) === 0o040000;
  }
  isFile() {
    return (this.mode & 0o170000) === 0o100000;
  }
}
function asStat(value: { dev: bigint; ino: bigint; mode: bigint; uid: bigint }) {
  let dev = value.dev;
  if (process.platform === "linux") {
    const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n);
    const minor = (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n);
    dev = (major << 32n) | minor;
  }
  return new Stat(dev, value.ino, Number(value.mode), Number(value.uid));
}
export function lstat(path: string): Stat {
  try {
    return asStat(lstatSync(path, { bigint: true }));
  } catch {
    throw Error("FileNotFound");
  }
}
export function readFile(path: string, buffer: Uint8Array): number {
  const fd = openSync(path, "r");
  try {
    let used = 0;
    while (used < buffer.length) {
      const count = readSync(fd, buffer, used, buffer.length - used, null);
      if (count === 0) break;
      used += count;
    }
    return used;
  } finally {
    closeSync(fd);
  }
}
const cwd_buffer = Buffer.alloc(max_path_bytes);
export function processCwd(pid: number): string | null {
  if (process.platform === "linux") {
    try {
      return readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }
  if (process.platform !== "darwin") return null;
  const len = n.probe_process_cwd(pid, ptr(cwd_buffer), cwd_buffer.length);
  return len < 0 ? null : cwd_buffer.toString("utf8", 0, len);
}
/** The account's login shell, or null when the account database has none. */
export function loginShell(): string | null {
  const buffer = Buffer.alloc(max_path_bytes),
    len = n.probe_login_shell(ptr(buffer), buffer.length);
  return len > 0 ? buffer.toString("utf8", 0, len) : null;
}
export function processPath(pid: number, buffer: Uint8Array = Buffer.alloc(max_path_bytes)): string | null {
  if (process.platform === "linux") {
    try {
      const value = readlinkSync(`/proc/${pid}/exe`);
      if (Buffer.byteLength(value) > buffer.length) return null;
      Buffer.from(value).copy(buffer);
      return value;
    } catch {
      return null;
    }
  }
  if (process.platform !== "darwin" || !buffer.length) return null;
  const values = new BigUint64Array(3),
    cwd = Buffer.alloc(buffer.length),
    args = Buffer.alloc(buffer.length),
    exe = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  return n.probe_macos_process(pid, ptr(values), ptr(cwd), ptr(exe), ptr(args), buffer.length) & 8
    ? exe.toString("utf8", 0, exe.indexOf(0))
    : null;
}
export class ProcessArgs {
  argv: string[] = [];
  exe = "";
  env: string[] = [];
  complete = false;
  args() {
    return this.argv;
  }
  environ() {
    return this.env;
  }
  addEnv(entry: string) {
    if (entry && this.env.length < 512) this.env.push(entry);
  }
}
// Process inspection is synchronous; returned strings own their bytes.
const args_buffer = Buffer.allocUnsafe(1024 * 1024);
export function processArgs(
  pid: number,
  buffer: Uint8Array | number = args_buffer,
  want: { env?: boolean } = {},
): ProcessArgs | null {
  const bytes =
      typeof buffer === "number"
        ? Buffer.allocUnsafe(buffer)
        : Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength),
    out = new ProcessArgs();
  if (!bytes.length) return null;
  if (process.platform === "darwin") {
    const read = (n as any).probe_process_args;
    if (!read) return null;
    const len = Number(read(pid, ptr(bytes), bytes.length));
    if (len < 4 || len === bytes.length) return null;
    const argc = bytes.readInt32LE(0);
    if (argc <= 0) return null;
    let at = bytes.indexOf(0, 4);
    if (at < 0 || at >= len) return null;
    if (want.env) out.exe = bytes.toString("utf8", 4, at);
    while (at < len && bytes[at] === 0) at++;
    let seen = 0;
    for (; seen < argc; seen++) {
      const end = bytes.indexOf(0, at);
      if (end < 0 || end >= len) break;
      if (out.argv.length < 256) out.argv.push(bytes.toString("utf8", at, end));
      at = end + 1;
    }
    out.complete = out.argv.length === argc;
    if (want.env && seen === argc)
      while (at < len) {
        const end = bytes.indexOf(0, at);
        if (end < 0 || end >= len || end === at) break;
        out.addEnv(bytes.toString("utf8", at, end));
        at = end + 1;
      }
    return out;
  }
  if (process.platform !== "linux") return null;
  try {
    if (want.env && bytes.length <= max_path_bytes) return null;
    const size = want.env ? Math.floor((bytes.length - max_path_bytes) / 2) : bytes.length,
      area = bytes.subarray(0, size);
    if (want.env) out.exe = processPath(pid, bytes.subarray(bytes.length - max_path_bytes)) ?? "";
    const len = readFile(`/proc/${pid}/cmdline`, area);
    if (!len) return null;
    const whole = len < area.length && area[len - 1] === 0,
      argv = area.toString("utf8", 0, whole ? len - 1 : len).split("\0");
    out.argv = argv.slice(0, 256);
    out.complete = whole && argv.length <= 256;
    if (want.env) {
      const rest = bytes.subarray(size, bytes.length - max_path_bytes),
        used = readFile(`/proc/${pid}/environ`, rest);
      for (const entry of rest.toString("utf8", 0, used).split("\0")) out.addEnv(entry);
    }
    return out;
  } catch {
    return null;
  }
}
// Linux lists a task's children only with CONFIG_PROC_CHILDREN.
let task_children: boolean | null = null;
/** The PIDs in the trees under `roots`, roots included, read from each
 * task's children rather than every process on the host. Null where the
 * kernel can't list children (macOS, or Linux without CONFIG_PROC_CHILDREN). */
export function processTree(roots: number[], limit = 16384): number[] | null {
  if (process.platform !== "linux") return null;
  task_children ??= existsSync(`/proc/self/task/${process.pid}/children`);
  if (!task_children) return null;
  const seen = new Set<number>(),
    pending = roots.filter(pid => pid > 0);
  while (pending.length && seen.size < limit) {
    const pid = pending.pop()!;
    if (seen.has(pid)) continue;
    let tasks: string[];
    try {
      tasks = readdirSync(`/proc/${pid}/task`);
    } catch {
      continue;
    }
    seen.add(pid);
    for (const task of tasks)
      try {
        for (const child of readFileSync(`/proc/${pid}/task/${task}/children`, "latin1").split(" "))
          if (child) pending.push(Number(child));
      } catch {}
  }
  return [...seen];
}
export type ProcessJob = { ppid: number; pgid: number; tpgid: number };
export function processGroup(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 2147483647) return null;
  if (process.platform !== "linux") return processJob(pid)?.pgid ?? null;
  const group = n.probe_getpgid(pid);
  return group > 0 ? group : null;
}
export function processJob(pid: number): ProcessJob | null {
  if (process.platform === "darwin") {
    const fields = new Int32Array(3);
    if (n.probe_process_job(pid, ptr(fields)) !== 0) return null;
    return { ppid: fields[0], pgid: fields[1], tpgid: fields[2] };
  }
  if (process.platform !== "linux") return null;
  try {
    const bytes = Buffer.alloc(1024),
      len = readFile(`/proc/${pid}/stat`, bytes),
      text = bytes.toString("utf8", 0, len),
      close = text.lastIndexOf(")");
    if (close < 0) return null;
    const fields = text
        .slice(close + 1)
        .trim()
        .split(/ +/),
      numbers = fields.slice(1, 6).map(Number);
    if (numbers.length !== 5 || numbers.some(v => !Number.isInteger(v) || v < -2147483648 || v > 2147483647))
      return null;
    return { ppid: numbers[0], pgid: numbers[1], tpgid: numbers[4] };
  } catch {
    return null;
  }
}
export class PathSearch {
  private dirs: string[];
  private index = 0;
  constructor(
    path_list: string,
    public name: string,
  ) {
    this.dirs = path_list.split(":");
  }
  static init(path_list: string, name: string) {
    return new PathSearch(path_list, name);
  }
  next(buffer: Uint8Array | number = max_path_bytes): string | null {
    const cap = typeof buffer === "number" ? buffer : buffer.length;
    while (this.index < this.dirs.length) {
      const dir = this.dirs[this.index++];
      if (!isAbsolute(dir)) continue;
      const path = `${dir}/${this.name}`;
      if (Buffer.byteLength(path) + 1 > cap) continue;
      try {
        if (!statSync(path).isFile()) continue;
        accessSync(path, constants.X_OK);
        if (typeof buffer !== "number") {
          buffer.fill(0);
          Buffer.from(path).copy(buffer);
        }
        return path;
      } catch {}
    }
    return null;
  }
}
export function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
export function findExecutable(name: string, buffer: Uint8Array | number = max_path_bytes) {
  return PathSearch.init(env("PATH") ?? "", name).next(buffer);
}
export function shellQuote(text: string): string {
  return "'" + text.replaceAll("'", "'\\''") + "'";
}
export const quote = shellQuote;
/** `args` as a shell reads them, quoting only the words that need it. */
export function shellWords(args: string[]): string {
  return args.map(arg => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : shellQuote(arg))).join(" ");
}
export function shellEscape(args: Array<string | Uint8Array>): string | null {
  const decoder = new TextDecoder("utf-8", { fatal: true }),
    out: string[] = [];
  for (const arg of args) {
    let text: string;
    try {
      text = typeof arg === "string" ? arg : decoder.decode(arg);
    } catch {
      return null;
    }
    if (
      /[\x00-\x1f\x7f]/.test(text) ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)
    )
      return null;
    out.push(text ? text.replace(/[^a-zA-Z0-9_@%+:,.\/-]/g, ch => (ch.codePointAt(0)! < 128 ? "\\" + ch : ch)) : "''");
  }
  return out.join(" ");
}
export function socketPath(): string {
  return env("CORGI_SOCKET") ?? `/tmp/corgi-${process.getuid?.() ?? userInfo().uid}/control.sock`;
}
export function atomicWrite(path: string, data: string | Uint8Array, mode = 0o600, private_parent = true): void {
  if (private_parent) privateDirectory(dirname(path));
  else mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd = -1;
  try {
    fd = openSync(temp, "wx", mode);
    const bytes = Buffer.from(data);
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
    fsyncSync(fd);
    closeSync(fd);
    fd = -1;
    renameSync(temp, path);
    const parent = openSync(dirname(path), "r");
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
  } finally {
    if (fd >= 0) closeSync(fd);
    try {
      unlinkSync(temp);
    } catch {}
  }
}
export function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
export class SocketPath {
  constructor(
    public path: string,
    public inode: bigint | null,
  ) {}
  static claim(path: string) {
    let inode: bigint | null = null;
    try {
      inode = lstatSync(path, { bigint: true }).ino;
    } catch {}
    return new SocketPath(path, inode);
  }
  release() {
    if (this.inode === null) return;
    try {
      if (lstatSync(this.path, { bigint: true }).ino === this.inode) unlinkSync(this.path);
    } catch {}
  }
}
export function privateDirectory(parent: string) {
  let stat: Stat;
  try {
    stat = lstat(parent);
  } catch {
    mkdirSync(parent, { recursive: true });
    chmodSync(parent, 0o700);
    try {
      stat = lstat(parent);
    } catch {
      throw Error("UnsafeSocketDirectory");
    }
  }
  if (stat.uid !== (process.getuid?.() ?? userInfo().uid) || !stat.isDir() || (stat.mode & 0o077) !== 0)
    throw Error("UnsafeSocketDirectory");
}
export function unixAddress(path: string) {
  if (Buffer.byteLength(path) >= (process.platform === "darwin" ? 104 : 108) || path.includes("\0"))
    throw Error("NameTooLong");
  return path;
}
export function listen(path: string): number {
  if (!path.includes("/")) throw Error("BadSocketPath");
  privateDirectory(dirname(path));
  unixAddress(path);
  const fd = n.probe_listen(Buffer.from(path + "\0"));
  if (fd < 0) throw Error(fd === -98 || fd === -48 ? "AddressInUse" : fd === -13 ? "AccessDenied" : "BindFailed");
  return fd;
}
