//! Tolerant reads of vendor JSON: provider transcripts, hooks, app-server
//! messages and importer snapshots. A missing key, or a value of another
//! JSON type, reads as the default; one odd field never drops a record.
//! Corgi's own formats use strict std.json parsing instead.
const std = @import("std");
const Value = std.json.Value;

pub fn field(v: Value, key: []const u8) Value {
    return if (v == .object) v.object.get(key) orelse .null else .null;
}
pub fn str(v: Value, key: []const u8) []const u8 {
    const x = field(v, key);
    return if (x == .string) x.string else "";
}
/// Token counts, sizes and offsets are never negative.
pub fn uint(v: Value, key: []const u8) ?u64 {
    const x = field(v, key);
    return if (x == .integer and x.integer >= 0) @intCast(x.integer) else null;
}
pub fn int(v: Value, key: []const u8) ?i64 {
    const x = field(v, key);
    return if (x == .integer) x.integer else null;
}
pub fn float(v: Value, key: []const u8) ?f64 {
    return switch (field(v, key)) {
        .integer => |n| @floatFromInt(n),
        .float => |n| n,
        else => null,
    };
}
pub fn boolean(v: Value, key: []const u8) bool {
    const x = field(v, key);
    return x == .bool and x.bool;
}
pub fn list(v: Value, key: []const u8) []const Value {
    const x = field(v, key);
    return if (x == .array) x.array.items else &.{};
}
/// The first non-empty string among `keys`, for formats that renamed a key.
pub fn firstStr(v: Value, keys: []const []const u8) []const u8 {
    for (keys) |key| {
        const s = str(v, key);
        if (s.len > 0) return s;
    }
    return "";
}

/// Fills a `T` from an object by field name; field names spell the wire
/// keys. A missing key, or a value of another type, keeps the default.
/// Strings borrow from `v`.
pub fn decode(comptime T: type, v: Value) T {
    var out: T = .{};
    if (v != .object) return out;
    inline for (@typeInfo(T).@"struct".fields) |f| {
        if (v.object.get(f.name)) |item| {
            if (as(f.type, item)) |value| @field(out, f.name) = value;
        }
    }
    return out;
}
fn as(comptime F: type, v: Value) ?F {
    if (F == Value) return v;
    if (F == []const u8) return if (v == .string) v.string else null;
    return switch (@typeInfo(F)) {
        .bool => if (v == .bool) v.bool else null,
        .int => if (v == .integer) std.math.cast(F, v.integer) else null,
        .float => switch (v) {
            .integer => |n| @floatFromInt(n),
            .float => |n| @floatCast(n),
            else => null,
        },
        .@"enum" => if (v == .string) std.meta.stringToEnum(F, v.string) else null,
        .optional => |o| if (as(o.child, v)) |x| x else null,
        .@"struct" => if (v == .object) decode(F, v) else null,
        else => @compileError("json.decode: unsupported field " ++ @typeName(F)),
    };
}

test "json accessors read a missing or mistyped key as the default" {
    const alloc = std.testing.allocator;
    const parsed = try std.json.parseFromSlice(Value, alloc,
        \\{"s":"x","n":-3,"u":7,"f":1.5,"b":true,"a":[1,2],"o":{"s":"y"},"e":"","t":"z"}
    , .{});
    defer parsed.deinit();
    const v = parsed.value;
    try std.testing.expectEqualStrings("x", str(v, "s"));
    try std.testing.expectEqualStrings("", str(v, "missing"));
    try std.testing.expectEqualStrings("", str(v, "n"));
    try std.testing.expectEqualStrings("", str(.null, "s"));
    try std.testing.expectEqualStrings("y", str(field(v, "o"), "s"));
    try std.testing.expect(field(v, "missing") == .null);
    try std.testing.expectEqual(@as(?u64, 7), uint(v, "u"));
    try std.testing.expectEqual(@as(?u64, null), uint(v, "n"));
    try std.testing.expectEqual(@as(?u64, null), uint(v, "s"));
    try std.testing.expectEqual(@as(?u64, null), uint(v, "missing"));
    try std.testing.expectEqual(@as(?i64, -3), int(v, "n"));
    try std.testing.expectEqual(@as(?i64, null), int(v, "f"));
    try std.testing.expectEqual(@as(?i64, null), int(v, "missing"));
    try std.testing.expectEqual(@as(?f64, 1.5), float(v, "f"));
    try std.testing.expectEqual(@as(?f64, 7), float(v, "u"));
    try std.testing.expectEqual(@as(?f64, null), float(v, "s"));
    try std.testing.expect(boolean(v, "b"));
    try std.testing.expect(!boolean(v, "s"));
    try std.testing.expect(!boolean(v, "missing"));
    try std.testing.expectEqual(@as(usize, 2), list(v, "a").len);
    try std.testing.expectEqual(@as(usize, 0), list(v, "o").len);
    try std.testing.expectEqualStrings("z", firstStr(v, &.{ "missing", "e", "t", "s" }));
    try std.testing.expectEqualStrings("", firstStr(v, &.{ "missing", "e" }));
}

test "json decode keeps defaults for missing and mistyped fields" {
    const Kind = enum { user, assistant };
    const Usage = struct { input: u64 = 0, output: u64 = 0 };
    const Record = struct {
        type: ?Kind = null,
        id: []const u8 = "",
        count: u32 = 9,
        ratio: f64 = 0,
        live: bool = false,
        usage: Usage = .{},
        raw: Value = .null,
    };
    const alloc = std.testing.allocator;
    const parsed = try std.json.parseFromSlice(Value, alloc,
        \\{"type":"system","id":5,"count":-1,"ratio":2,"live":true,
        \\ "usage":{"input":3,"output":"x"},"raw":[1],"extra":1}
    , .{});
    defer parsed.deinit();
    const r = decode(Record, parsed.value);
    try std.testing.expectEqual(@as(?Kind, null), r.type);
    try std.testing.expectEqualStrings("", r.id);
    try std.testing.expectEqual(@as(u32, 9), r.count);
    try std.testing.expectEqual(@as(f64, 2), r.ratio);
    try std.testing.expect(r.live);
    try std.testing.expectEqual(@as(u64, 3), r.usage.input);
    try std.testing.expectEqual(@as(u64, 0), r.usage.output);
    try std.testing.expect(r.raw == .array);

    const known = try std.json.parseFromSlice(Value, alloc,
        \\{"type":"user","id":"a"}
    , .{});
    defer known.deinit();
    const k = decode(Record, known.value);
    try std.testing.expectEqual(@as(?Kind, .user), k.type);
    try std.testing.expectEqualStrings("a", k.id);
    try std.testing.expectEqual(@as(u32, 9), k.count);
    try std.testing.expectEqual(@as(u32, 9), decode(Record, .null).count);
}
