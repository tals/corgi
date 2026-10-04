//! Crash reports. sentry-native's in-process handler catches fatal signals,
//! including the abort that ends a Zig panic, and saves a report under the
//! state directory; the next daemon or viewer to start sends it to Sentry
//! with curl. Builds without -Dsentry-dsn do nothing.
const std = @import("std");
const options = @import("corgi_options");
const os = @import("os.zig");
const a = os.allocator;
const sentry = @cImport(@cInclude("sentry.h"));

const log = std.log.scoped(.crash);

pub const Process = enum { daemon, viewer };

const enabled = options.sentry_dsn.len > 0;
const endpoint: Endpoint = if (enabled) .parse(options.sentry_dsn) else .{ .url = "", .proto = "", .auth = "" };

/// Where a project's DSN takes envelopes, and how curl reaches it.
const Endpoint = struct {
    url: []const u8,
    /// curl's --proto, allowing only the DSN's scheme.
    proto: []const u8,
    auth: []const u8,

    /// `SCHEME://KEY@HOST[/PATH]/PROJECT` sends to
    /// `SCHEME://HOST[/PATH]/api/PROJECT/envelope/`.
    fn parse(comptime dsn: []const u8) Endpoint {
        const scheme = std.mem.indexOf(u8, dsn, "://") orelse @compileError("sentry-dsn has no scheme");
        const at = std.mem.indexOfScalarPos(u8, dsn, scheme, '@') orelse @compileError("sentry-dsn has no key");
        const slash = std.mem.lastIndexOfScalar(u8, dsn, '/').?;
        if (slash < at) @compileError("sentry-dsn has no project");
        const credentials = dsn[scheme + 3 .. at];
        const key = credentials[0 .. std.mem.indexOfScalar(u8, credentials, ':') orelse credentials.len];
        return .{
            .url = dsn[0 .. scheme + 3] ++ dsn[at + 1 .. slash] ++ "/api/" ++ dsn[slash + 1 ..] ++ "/envelope/",
            .proto = "=" ++ dsn[0..scheme],
            .auth = "X-Sentry-Auth: Sentry sentry_version=7, sentry_key=" ++ key ++ ", sentry_client=corgi/" ++ options.release_version,
        };
    }
};

/// Where sentry-native keeps each process's run and the reports it has not
/// sent yet. Set once, before Sentry starts.
var database: []const u8 = "";

/// Starts crash reporting in a daemon or viewer. Sentry starts on its own
/// thread because it first sends what earlier processes saved.
pub fn init(process: Process) void {
    if (comptime !enabled) return;
    const thread = std.Thread.spawn(.{}, start, .{process}) catch |err| return log.warn("crash reports are off: {}", .{err});
    thread.detach();
}
fn start(process: Process) void {
    startSentry(process) catch |err| log.warn("crash reports are off: {}", .{err});
}
fn startSentry(process: Process) !void {
    database = if (os.env("XDG_STATE_HOME")) |root|
        try std.fs.path.join(a, &.{ root, "corgi", "crash" })
    else
        try std.fs.path.join(a, &.{ os.env("HOME") orelse return error.NoHome, ".local", "state", "corgi", "crash" });
    const opts = sentry.sentry_options_new() orelse return error.OutOfMemory;
    sentry.sentry_options_set_dsn_n(opts, options.sentry_dsn.ptr, options.sentry_dsn.len);
    sentry.sentry_options_set_database_path_n(opts, database.ptr, database.len);
    const release = "corgi@" ++ options.release_version;
    sentry.sentry_options_set_release_n(opts, release.ptr, release.len);
    sentry.sentry_options_set_auto_session_tracking(opts, 0);
    sentry.sentry_options_set_on_crash(opts, onCrash, null);
    sentry.sentry_options_set_transport(opts, sentry.sentry_transport_new(send));
    if (sentry.sentry_init(opts) != 0) return error.SentryInitFailed;
    const tag = @tagName(process);
    sentry.sentry_set_tag_n("process", "process".len, tag.ptr, tag.len);
}

fn send(envelope: ?*sentry.sentry_envelope_t, _: ?*anyopaque) callconv(.c) void {
    defer sentry.sentry_envelope_free(envelope);
    upload(envelope.?) catch |err| log.warn("crash report not sent: {}", .{err});
}
/// Posts one envelope. Sentry deletes a saved report once it has been
/// handed here, so one that fails to send is lost.
fn upload(envelope: *sentry.sentry_envelope_t) !void {
    var len: usize = 0;
    const bytes = sentry.sentry_envelope_serialize(envelope, &len) orelse return error.OutOfMemory;
    defer sentry.sentry_free(bytes);
    const path = try std.fmt.allocPrint(a, "{s}/upload-{d}.envelope", .{ database, os.c.getpid() });
    defer a.free(path);
    defer std.Io.Dir.cwd().deleteFile(os.io(), path) catch {};
    // Not sentry_envelope_write_to_file_n: in 0.7.8 it reports a report read
    // back from disk as unwritten, and leaks its file.
    try std.Io.Dir.cwd().writeFile(os.io(), .{ .sub_path = path, .data = bytes[0..len] });
    const body = try std.fmt.allocPrint(a, "@{s}", .{path});
    defer a.free(body);
    const result = try std.process.run(a, os.io(), .{ .argv = &.{
        "curl",                                        "--disable",     "--fail",       "--silent",
        "--show-error",                                "--proto",       endpoint.proto, "--max-time",
        "30",                                          "--header",      endpoint.auth,  "--header",
        "Content-Type: application/x-sentry-envelope", "--data-binary", body,           endpoint.url,
    } });
    defer a.free(result.stdout);
    defer a.free(result.stderr);
    if (result.term != .exited or result.term.exited != 0) return error.CurlFailed;
}

const max_frames = 128;
/// A panic's message and stack, kept for the abort that follows it.
var panic_text: [512]u8 = undefined;
var panic_message: ?[]const u8 = null;
var panic_frames: [max_frames]usize = undefined;
var panic_trace: []const usize = &.{};

/// The panic handler calls this before aborting, so the report names the
/// panic and shows where it happened rather than where abort was called.
pub fn notePanic(msg: []const u8, first_trace_addr: usize) void {
    if (panic_message != null) return;
    const len = @min(msg.len, panic_text.len);
    @memcpy(panic_text[0..len], msg[0..len]);
    panic_trace = std.debug.captureCurrentStackTrace(.{ .first_address = first_trace_addr, .allow_unsafe_unwind = true }, &panic_frames).return_addresses;
    if (panic_trace.len == 0) panic_trace = std.debug.captureCurrentStackTrace(.{ .allow_unsafe_unwind = true }, &panic_frames).return_addresses;
    panic_message = panic_text[0..len];
}

/// Runs in the signal handler. sentry-native's unwinder finds no frames on
/// static musl, and elsewhere starts inside the handler, so Zig's unwinder
/// replaces its stack trace.
fn onCrash(uctx: [*c]const sentry.sentry_ucontext_t, event: sentry.sentry_value_t, _: ?*anyopaque) callconv(.c) sentry.sentry_value_t {
    const values = sentry.sentry_value_get_by_key(sentry.sentry_value_get_by_key(event, "exception"), "values");
    const exception = sentry.sentry_value_get_by_index(values, 0);
    if (panic_message) |message| {
        _ = sentry.sentry_value_set_by_key(exception, "type", sentry.sentry_value_new_string("panic"));
        _ = sentry.sentry_value_set_by_key(exception, "value", sentry.sentry_value_new_string_n(message.ptr, message.len));
        // Every frame is a return address, and abort's registers don't apply.
        _ = sentry.sentry_value_set_by_key(exception, "stacktrace", stacktrace(panic_trace, "all"));
        return event;
    }
    const context = std.debug.cpu_context.fromPosixSignalContext(@ptrCast(uctx.*.user_context)) orelse return event;
    var frames: [max_frames]usize = undefined;
    const trace = std.debug.captureCurrentStackTrace(.{ .context = &context, .allow_unsafe_unwind = true }, &frames).return_addresses;
    if (trace.len == 0) return event;
    // Zig reports the faulting instruction's address plus one, as if it were
    // a return address like the rest.
    frames[0] -= 1;
    const replacement = stacktrace(trace, "all_but_first");
    const registers = sentry.sentry_value_get_by_key(sentry.sentry_value_get_by_key(exception, "stacktrace"), "registers");
    sentry.sentry_value_incref(registers);
    _ = sentry.sentry_value_set_by_key(replacement, "registers", registers);
    _ = sentry.sentry_value_set_by_key(exception, "stacktrace", replacement);
    return event;
}
fn stacktrace(trace: []const usize, adjustment: [:0]const u8) sentry.sentry_value_t {
    const value = sentry.sentry_value_new_stacktrace(@ptrCast(@constCast(trace.ptr)), trace.len);
    _ = sentry.sentry_value_set_by_key(value, "instruction_addr_adjustment", sentry.sentry_value_new_string(adjustment));
    return value;
}

test "a DSN names its project's envelope endpoint and key" {
    const us = comptime Endpoint.parse("https://17878b2c@o451.ingest.us.sentry.io/4512");
    try std.testing.expectEqualStrings("https://o451.ingest.us.sentry.io/api/4512/envelope/", us.url);
    try std.testing.expectEqualStrings("=https", us.proto);
    try std.testing.expect(std.mem.indexOf(u8, us.auth, "sentry_key=17878b2c,") != null);
    const hosted = comptime Endpoint.parse("http://public:secret@127.0.0.1:9000/prefix/7");
    try std.testing.expectEqualStrings("http://127.0.0.1:9000/prefix/api/7/envelope/", hosted.url);
    try std.testing.expectEqualStrings("=http", hosted.proto);
    try std.testing.expect(std.mem.indexOf(u8, hosted.auth, "sentry_key=public,") != null);
}

test {
    // Builds without a DSN skip all of this; compile it anyway.
    _ = &start;
}
