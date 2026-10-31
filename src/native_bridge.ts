import * as telemetry from "./telemetry";
import { dlopen, ptr, suffix, FFIType, type Pointer } from "bun:ffi";
import { processArgs as readProcessArgs, processCwd } from "./os";
import { n } from "./native_ffi";
import * as json from "./json";
export { n, ptr } from "./native_ffi";
export { ReadyLoop, READ, WRITE, AsyncFD } from "./fd_loop";
import { nativeRoot } from "./native_paths";
export { nativeRoot };
const lib = dlopen(`${nativeRoot}/lib/libcorgi_term.${suffix}`, {
  app_terminal_fd: { args: ["ptr", "i32", "i32"], returns: "void" },
  app_terminal_json: { args: ["ptr", "ptr", "usize", "ptr", "usize"], returns: FFIType.i64_fast },
});
export const symbols = lib.symbols;
const system = dlopen(`${nativeRoot}/lib/libcorgi_system.${suffix}`, {
  app_system_json: { args: ["u32", "i32", "ptr", "usize"], returns: FFIType.i64_fast },
  app_sysconf: { args: ["bool"], returns: FFIType.i64_fast },
  app_waitpid: { args: ["i32"], returns: "i32" },
  app_flock: { args: ["i32", "bool"], returns: "i32" },
});
export function sysconf(pages: boolean): number {
  return Number(system.symbols.app_sysconf(pages));
}
export function waitpid(pid: number): number {
  return system.symbols.app_waitpid(pid);
}
export function flock(fd: number, lock = true): boolean {
  return system.symbols.app_flock(fd, lock) === 0;
}
export function systemCall(request: { op: string; pid?: number }): any {
  if (request.op === "process.cwd") return processCwd(request.pid ?? 0);
  const op = ["resource.inventory", "resource.counters", "resource.host"].indexOf(request.op);
  if (op < 0) throw Error("UnknownSystemOperation");
  let buffer = Buffer.alloc(4 * 1024 * 1024);
  let size = Number(system.symbols.app_system_json(op, request.pid ?? 0, ptr(buffer), buffer.length));
  if (size < -1 && -size <= 16 * 1024 * 1024) {
    buffer = Buffer.alloc(-size);
    size = Number(system.symbols.app_system_json(op, request.pid ?? 0, ptr(buffer), buffer.length));
  }
  if (size < 0) throw Error("SystemReadFailed");
  return json.parse(buffer.toString("utf8", 0, size));
}
export const tcgetpgrp = (fd: number): number => n.probe_foreground(fd);
/** Compatibility for argv-only callers; process inspection policy lives in os. */
export function processArgs(pid: number): { argv: string[]; complete: boolean } {
  return readProcessArgs(pid) ?? { argv: [], complete: false };
}
// Replies land here; a larger one gets a buffer of its own.
const reply = Buffer.allocUnsafe(65536);
export function call(handle: Pointer | bigint, request: object): any {
  const encode_started = telemetry.begin();
  const input = Buffer.from(json.stringify(request));
  telemetry.end("native.encode", encode_started, input.length);
  const execute_started = telemetry.begin();
  let output = reply;
  let size = Number(symbols.app_terminal_json(handle, ptr(input), input.length, ptr(output), output.length));
  if (size < -1) {
    if (-size > 64 * 1024 * 1024) throw Error("NativeMessageTooLarge");
    output = Buffer.allocUnsafe(-size);
    size = Number(symbols.app_terminal_json(handle, ptr(input), input.length, ptr(output), output.length));
  }
  if (size < 0) throw Error("NativeOperationFailed");
  telemetry.end("native.execute", execute_started, size);
  const decode_started = telemetry.begin();
  const bytes = output.toString("utf8", 0, size);
  const result = "op" in request && request.op === "surface" ? JSON.parse(bytes) : json.parse(bytes);
  telemetry.end("native.decode", decode_started, size);
  telemetry.native(request, encode_started, size);
  if (result.err) throw Error(result.err);
  return result.value;
}
