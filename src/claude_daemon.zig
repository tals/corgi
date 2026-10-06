//! Claude sessions that its background daemon runs. Each live Claude process
//! records its session in `<config>/sessions/<pid>.json`, and `claude
//! --resume` refuses a session that a live background process holds.
const std = @import("std");
const os = @import("os.zig");
const json = @import("json.zig");
const BoundedText = @import("bounded_text.zig").BoundedText;
const Claude = @import("providers/claude.zig").Claude;
const a = os.allocator;

/// A background job's short id, which `claude attach` takes.
pub const JobId = BoundedText(32);

/// The job whose live background process holds `session`, or null when none
/// does: a session no process runs, or a terminal runs, resumes as usual.
pub fn job(session: []const u8) ?JobId {
    const config = Claude.info.configDir(a) catch return null;
    defer a.free(config);
    const dir = std.fs.path.join(a, &.{ config, "sessions" }) catch return null;
    defer a.free(dir);
    return jobIn(dir, session);
}

/// `claude attach` for `id`. It takes no launch flags: the job keeps the
/// ones it started with.
pub fn attachCommand(alloc: std.mem.Allocator, id: JobId) ![]u8 {
    return std.fmt.allocPrint(alloc, "{s} attach {s}", .{ Claude.info.executables[0], id.text() });
}

fn jobIn(path: []const u8, session: []const u8) ?JobId {
    var dir = std.Io.Dir.openDirAbsolute(os.io(), path, .{ .iterate = true }) catch return null;
    defer dir.close(os.io());
    var files = dir.iterate();
    while (files.next(os.io()) catch null) |file| {
        if (file.kind != .file or !std.mem.endsWith(u8, file.name, ".json")) continue;
        const bytes = dir.readFileAlloc(os.io(), file.name, a, .limited(64 * 1024)) catch continue;
        defer a.free(bytes);
        const parsed = std.json.parseFromSlice(std.json.Value, a, bytes, .{}) catch continue;
        defer parsed.deinit();
        const record = json.decode(Claude.SessionRecord, parsed.value);
        if (record.kind != .bg or !std.ascii.eqlIgnoreCase(record.sessionId, session)) continue;
        // A process that exited without removing its record no longer holds it.
        if (record.pid <= 1 or os.c.kill(record.pid, 0) != 0) continue;
        if (!jobName(record.jobId)) continue;
        return JobId.ascii(record.jobId);
    }
    return null;
}

/// Job ids are short lowercase names, safe to pass through a shell.
fn jobName(id: []const u8) bool {
    if (id.len == 0 or id.len > JobId.capacity) return false;
    for (id) |ch| if (!std.ascii.isLower(ch) and !std.ascii.isDigit(ch) and ch != '_') return false;
    return true;
}

test "a session attaches only to the live background job that holds it" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const self = os.c.getpid();
    const gone = std.math.maxInt(c_int);
    var buf: [256]u8 = undefined;
    const records = [_]struct { []const u8, c_int, []const u8 }{
        .{ "bg", self, "\"kind\":\"bg\",\"jobId\":\"19e909c5\"" },
        .{ "terminal", self, "\"kind\":\"interactive\"" },
        .{ "exited", gone, "\"kind\":\"bg\",\"jobId\":\"5c926aa7\"" },
        .{ "no-job", self, "\"kind\":\"bg\"" },
        .{ "unsafe", self, "\"kind\":\"bg\",\"jobId\":\"a;rm\"" },
        .{ "future", self, "\"kind\":\"remote\",\"jobId\":\"0a1b2c3d\"" },
    };
    for (records, 0..) |r, i| {
        const name = try std.fmt.bufPrint(&buf, "{d}.json", .{i + 100});
        var data: [256]u8 = undefined;
        try tmp.dir.writeFile(os.io(), .{ .sub_path = name, .data = try std.fmt.bufPrint(&data, "{{\"pid\":{d},\"sessionId\":\"{s}\",{s}}}", .{ r[1], r[0], r[2] }) });
    }
    try tmp.dir.writeFile(os.io(), .{ .sub_path = "7.json", .data = "{\"pid\":" });
    const root = try os.realpathAlloc(std.testing.allocator, tmp.dir, ".");
    defer std.testing.allocator.free(root);

    try std.testing.expectEqualStrings("19e909c5", jobIn(root, "BG").?.text());
    for ([_][]const u8{ "terminal", "exited", "no-job", "unsafe", "future", "missing" }) |session| {
        try std.testing.expectEqual(null, jobIn(root, session));
    }
    try std.testing.expectEqual(null, jobIn("/nonexistent/sessions", "bg"));
    const command = try attachCommand(std.testing.allocator, .ascii("19e909c5"));
    defer std.testing.allocator.free(command);
    try std.testing.expectEqualStrings("claude attach 19e909c5", command);
}
