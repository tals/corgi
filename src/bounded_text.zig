//! Text of at most `n` bytes, stored inline, for values that are copied: into
//! worker requests, snapshots and saved state. Bytes past `len` stay zero, so
//! `std.meta.eql` and hashes of a containing struct see only the text. JSON is
//! a plain string.
const std = @import("std");

/// A path in saved or sent state. Fixed, and above every platform's
/// `std.fs.max_path_bytes` (1024 on macOS, 4096 on Linux), so every build
/// accepts the same state and none rejects a path its OS allows.
pub const Path = BoundedText(10 * 1024);

pub fn BoundedText(comptime n: usize) type {
    return struct {
        const Self = @This();
        pub const capacity = n;
        pub const Len = std.math.IntFittingRange(0, n);

        /// Read through `text()`. Build a new value instead of writing here.
        bytes: [n]u8 = @splat(0),
        len: Len = 0,

        /// Exactly `value`. For ids, paths and commands, where a prefix would
        /// name something else.
        pub fn init(value: []const u8) error{TooLong}!Self {
            if (value.len > n) return error.TooLong;
            var t: Self = .{ .len = @intCast(value.len) };
            @memcpy(t.bytes[0..value.len], value);
            return t;
        }

        /// The longest prefix that fits, cut at a UTF-8 boundary.
        pub fn initTruncated(value: []const u8) Self {
            var t: Self = .{};
            t.append(value);
            return t;
        }

        /// Printable ASCII; every other byte becomes a space.
        pub fn ascii(value: []const u8) Self {
            const len = @min(value.len, n);
            var t: Self = .{ .len = @intCast(len) };
            for (value[0..len], t.bytes[0..len]) |ch, *out| out.* = if (ch >= 32 and ch < 127) ch else ' ';
            return t;
        }

        pub fn text(t: *const Self) []const u8 {
            return t.bytes[0..t.len];
        }

        /// Appends what fits, cut at a UTF-8 boundary.
        pub fn append(t: *Self, value: []const u8) void {
            var take: usize = @min(value.len, n - @as(usize, t.len));
            while (take > 0 and !std.unicode.utf8ValidateSlice(value[0..take])) take -= 1;
            @memcpy(t.bytes[t.len..][0..take], value[0..take]);
            t.len += @intCast(take);
        }

        pub fn jsonStringify(t: *const Self, jw: *std.json.Stringify) !void {
            // std.json writes bytes that are not UTF-8 as an array of numbers.
            try jw.write(t.text());
        }

        pub fn jsonParse(alloc: std.mem.Allocator, source: anytype, options: std.json.ParseOptions) !Self {
            const value = try std.json.innerParse([]const u8, alloc, source, options);
            return init(value) catch error.LengthMismatch;
        }

        pub fn jsonParseFromValue(alloc: std.mem.Allocator, source: std.json.Value, options: std.json.ParseOptions) !Self {
            const value = try std.json.innerParseFromValue([]const u8, alloc, source, options);
            return init(value) catch error.LengthMismatch;
        }
    };
}

test "exact, truncated and ascii values" {
    const T = BoundedText(4);
    try std.testing.expectError(error.TooLong, T.init("hello"));
    try std.testing.expectEqualStrings("hell", T.initTruncated("hello").text());
    // "é" is two bytes; a prefix never splits it.
    try std.testing.expectEqualStrings("abc", T.initTruncated("abcé").text());
    try std.testing.expectEqualStrings("a b ", T.ascii("a\tb\x7f").text());
    try std.testing.expectEqual(u3, T.Len);
}

test "equal text compares equal whatever was stored before" {
    var built: BoundedText(8) = .initTruncated("ab");
    built.append("cdefgh");
    var direct: BoundedText(8) = .initTruncated("abcdefgh");
    try std.testing.expect(std.meta.eql(built, direct));
    direct = .initTruncated("ab");
    try std.testing.expect(std.meta.eql(direct, BoundedText(8).initTruncated("ab")));
}

test "JSON is a plain string and a value that does not fit is rejected" {
    const T = struct { name: BoundedText(8) };
    const json = try std.json.Stringify.valueAlloc(std.testing.allocator, T{ .name = .initTruncated("corgi") }, .{});
    defer std.testing.allocator.free(json);
    try std.testing.expectEqualStrings("{\"name\":\"corgi\"}", json);
    const parsed = try std.json.parseFromSlice(T, std.testing.allocator, json, .{});
    defer parsed.deinit();
    try std.testing.expectEqualStrings("corgi", parsed.value.name.text());
    try std.testing.expectError(error.LengthMismatch, std.json.parseFromSlice(T, std.testing.allocator, "{\"name\":\"nine bytes\"}", .{}));
    const tree = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, json, .{});
    defer tree.deinit();
    const from_value = try std.json.parseFromValue(T, std.testing.allocator, tree.value, .{});
    defer from_value.deinit();
    try std.testing.expectEqualStrings("corgi", from_value.value.name.text());
}
