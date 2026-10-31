import { dlopen, ptr, suffix, FFIType } from "bun:ffi";
import { nativeRoot } from "./native_paths";
export { ptr };
const term = dlopen(`${nativeRoot}/lib/libcorgi_term.${suffix}`, {
  terminal_new: { args: [], returns: "ptr" },
  terminal_free: { args: ["ptr"], returns: "void" },
  terminal_resize: { args: ["ptr", "u16", "u16"], returns: "i32" },
  terminal_feed: { args: ["ptr", "ptr", "usize"], returns: "void" },
  terminal_send: { args: ["ptr", "ptr", "usize"], returns: "i32" },
  terminal_pending: { args: ["ptr"], returns: "usize" },
  terminal_flush: { args: ["ptr"], returns: "void" },
  terminal_maintain: { args: ["ptr", "bool"], returns: "u32" },
  terminal_has_copied: { args: ["ptr"], returns: "bool" },
  terminal_surface_identity: { args: ["ptr"], returns: "u64" },
  terminal_surface_revision: { args: ["ptr"], returns: "u64" },
  terminal_title: { args: ["ptr", "ptr"], returns: "ptr" },
  terminal_text: { args: ["ptr", "ptr", "usize"], returns: FFIType.i64_fast },
  terminal_snapshot: { args: ["ptr", "ptr", "usize"], returns: FFIType.i64_fast },
  terminal_recovery_snapshot: { args: ["ptr", "ptr"], returns: "ptr" },
  terminal_live_text: { args: ["ptr", "ptr"], returns: "ptr" },
  terminal_bytes_free: { args: ["ptr", "usize"], returns: "void" },
  native_log_stderr: { args: ["bool"], returns: "void" },
  detection_configure: { args: ["ptr", "usize"], returns: "i32" },
  frame_diff_new: { args: ["u16", "u16"], returns: "ptr" },
  frame_diff_invalidate_images: { args: ["ptr"], returns: "void" },
  frame_diff_invalidate: { args: ["ptr"], returns: "void" },
  frame_diff_free: { args: ["ptr"], returns: "void" },
  frame_diff_diff: { args: ["ptr", "ptr", "usize"], returns: FFIType.i64_fast },
  frame_diff_compose: {
    args: ["ptr", "ptr", "usize", "ptr", "ptr", "usize", "u16", "u16", "bool", "u8"],
    returns: FFIType.i64_fast,
  },
  frame_diff_stats: { args: ["ptr", "ptr"], returns: "void" },
  frame_diff_take: { args: ["ptr", "ptr", "usize"], returns: FFIType.i64_fast },
  unicode_widths: { args: ["ptr", "usize"], returns: "void" },
  viewer_take: { args: ["ptr", "usize"], returns: FFIType.i64_fast },
  viewer_receive_frame: {
    args: ["ptr", "ptr", "usize", "u16", "u16", "u32", "u32", "u32", "u32", "bool", "ptr", "usize"],
    returns: "i32",
  },
  viewer_update_render: { args: ["ptr"], returns: "i32" },
  viewer_rows: { args: ["ptr", "u32", "u16", "u16", "u16", "u16", "bool", "bool", "u64"], returns: FFIType.i64_fast },
  viewer_cursor: { args: ["ptr", "bool"], returns: FFIType.i64_fast },
  viewer_mouse_event: { args: ["ptr"], returns: "i32" },
  viewer_mode: { args: ["ptr", "u32"], returns: "bool" },
  viewer_encode_key: { args: ["ptr", "u32", "u32"], returns: FFIType.i64_fast },
  viewer_encode_mouse: { args: ["ptr", "u16", "f32", "f32", "bool"], returns: FFIType.i64_fast },
  viewer_paste: { args: ["ptr", "usize", "bool", "i32"], returns: FFIType.i64_fast },
  viewer_paste_safe: { args: ["ptr", "usize"], returns: "bool" },
});
const system = dlopen(`${nativeRoot}/lib/libcorgi_system.${suffix}`, {
  probe_macos_process: { args: ["i32", "ptr", "ptr", "ptr", "ptr", "i32"], returns: "i32" },
  probe_process_cwd: { args: ["i32", "ptr", "i32"], returns: "i32" },
  probe_connect: { args: ["cstring"], returns: "i32" },
  probe_group_pids: { args: ["i32", "ptr", "i32"], returns: "i32" },
  probe_process_job: { args: ["i32", "ptr"], returns: "i32" },
  probe_process_args: { args: ["i32", "ptr", "usize"], returns: FFIType.i64_fast },
  probe_getpgrp: { args: [], returns: "i32" },
  probe_getpgid: { args: ["i32"], returns: "i32" },
  probe_dup_above: { args: ["i32", "i32"], returns: "i32" },
  probe_login_shell: { args: ["ptr", "i32"], returns: "i32" },
  probe_winsize: { args: ["i32", "ptr"], returns: "i32" },
  probe_fixture_children: { args: ["ptr"], returns: "i32" },
  probe_fixture_exit: { args: ["i32"], returns: "i32" },
  probe_wait_child: { args: ["i32"], returns: "i32" },
  probe_peek: { args: ["i32", "ptr", "i32"], returns: "i32" },
  probe_isatty: { args: ["i32"], returns: "i32" },
  probe_writable: { args: ["i32", "i32"], returns: "i32" },
  probe_winsize_pixels: { args: ["i32", "ptr"], returns: "i32" },
  probe_listen: { args: ["cstring"], returns: "i32" },
  probe_accept: { args: ["i32"], returns: "i32" },
  probe_pipe: { args: ["ptr"], returns: "i32" },
  probe_pair: { args: ["ptr"], returns: "i32" },
  probe_pty: { args: ["ptr"], returns: "i32" },
  probe_nonblock: { args: ["i32"], returns: "i32" },
  probe_close: { args: ["i32"], returns: "i32" },
  probe_read: { args: ["i32", "ptr", "i32"], returns: "i32" },
  probe_write: { args: ["i32", "ptr", "i32"], returns: "i32" },
  probe_resize: { args: ["i32", "i32", "i32"], returns: "i32" },
  probe_foreground: { args: ["i32"], returns: "i32" },
  probe_send: { args: ["i32", "ptr", "i32"], returns: "i32" },
  probe_recv: { args: ["i32", "ptr", "i32"], returns: "i32" },
});
export const n = { ...term.symbols, ...system.symbols };
export function terminal() {
  const handle = n.terminal_new();
  if (!handle) throw Error("terminal allocation");
  const buffer = Buffer.alloc(4 * 1024 * 1024);
  return {
    handle,
    resize(cols: number, rows: number) {
      if (n.terminal_resize(handle, cols, rows) !== 0) throw Error("terminal resize");
    },
    feed(data: Uint8Array | string) {
      const b = typeof data === "string" ? Buffer.from(data) : data;
      if (b.length) n.terminal_feed(handle, ptr(b), b.length);
    },
    text() {
      const size = Number(n.terminal_text(handle, ptr(buffer), buffer.length));
      if (size < 0) throw Error(`text: ${size}`);
      return buffer.subarray(0, size).toString();
    },
    snapshot() {
      const size = Number(n.terminal_snapshot(handle, ptr(buffer), buffer.length));
      if (size < 0) throw Error(`snapshot: ${size}`);
      return Buffer.from(buffer.subarray(0, size));
    },
    close() {
      n.terminal_free(handle);
    },
  };
}
export function pair(pty = false) {
  const fds = new Int32Array(2);
  if ((pty ? n.probe_pty : n.probe_pair)(ptr(fds)) !== 0) throw Error("pair");
  return [...fds];
}
export function write(fd: number, s: string) {
  const b = Buffer.from(s);
  if (n.probe_write(fd, ptr(b), b.length) !== b.length) throw Error("short write");
}
export async function readUntil(fd: number, needle: string, timeout = 5000) {
  const b = Buffer.alloc(65536);
  let text = "";
  const end = performance.now() + timeout;
  n.probe_nonblock(fd);
  while (performance.now() < end) {
    const size = n.probe_read(fd, ptr(b), b.length);
    if (size > 0) {
      text += b.subarray(0, size).toString();
      if (text.includes(needle)) return text;
    } else if (size === 0) throw Error("EOF before " + needle);
    else if (size !== -11 && size !== -35) throw Error(`read: ${size}`);
    await Bun.sleep(1);
  }
  throw Error(`read timeout: ${needle}: ${text}`);
}
