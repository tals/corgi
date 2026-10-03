//! Ordered JSON migrations at the persistence seam. Runtime code consumes only
//! the current schema; historical representations belong in the steps.
const std = @import("std");
const os = @import("../os.zig");
const Allocator = std.mem.Allocator;
const Value = std.json.Value;
const state_steps = @import("steps.zig");
const inference_setup = @import("../inference.zig").setup;
const providers = @import("../providers.zig");
const agents = @import("../agents.zig");
const account_preview = @import("../usage.zig").account;

pub const checkpoint_version: u32 = state_steps.checkpoint.len + 1;
pub const handoff_version: u32 = state_steps.handoff.len + 1;
pub const Kind = enum { checkpoint, handoff };

pub fn Decoded(comptime T: type) type {
    return struct {
        parsed: std.json.Parsed(T),
        /// The top-level version the bytes were written with.
        from: u32,
        migrated: bool,

        pub fn deinit(self: @This()) void {
            self.parsed.deinit();
        }
    };
}

/// Owns both the JSON tree and decoded data in one arena. Version checks and
/// migrations run before current Zig enums or structs see historical values.
pub fn decode(comptime T: type, kind: Kind, allocator: Allocator, bytes: []const u8) !Decoded(T) {
    var json = try std.json.parseFromSlice(Value, allocator, bytes, .{ .allocate = .alloc_always });
    errdefer json.deinit();
    const alloc = json.arena.allocator();
    const from: u32 = @intCast((try version(&json.value, switch (kind) {
        .checkpoint => checkpoint_version,
        .handoff => handoff_version,
    })).integer);
    const migrated = switch (kind) {
        .checkpoint => try migrate(&state_steps.checkpoint, alloc, &json.value),
        .handoff => handoff: {
            const outer = try migrate(&state_steps.handoff, alloc, &json.value);
            const runtime = (try object(&json.value)).getPtr("runtime") orelse return error.MissingField;
            break :handoff try migrate(&state_steps.checkpoint, alloc, runtime) or outer;
        },
    };
    const value = try std.json.parseFromValueLeaky(T, alloc, json.value, .{ .ignore_unknown_fields = true });
    return .{ .parsed = .{ .arena = json.arena, .value = value }, .from = from, .migrated = migrated };
}

/// Why a saved state cannot be read; a reload candidate reports these by name.
pub const VersionError = error{ MissingStateVersion, InvalidStateVersion, UnsupportedStateVersion };
fn version(value: *Value, current: u32) (VersionError || error{InvalidCheckpoint})!*Value {
    const field = (try object(value)).getPtr("version") orelse return error.MissingStateVersion;
    if (field.* != .integer or field.integer < 1) return error.InvalidStateVersion;
    if (field.integer > current) return error.UnsupportedStateVersion;
    return field;
}

fn migrate(steps: []const state_steps.Step, alloc: Allocator, value: *Value) !bool {
    const current = steps.len + 1;
    // Steps add fields, so no map-entry pointer is held across them.
    const before: usize = @intCast((try version(value, @intCast(current))).integer);
    for (steps[before - 1 ..], before + 1..) |step, next| {
        try step(alloc, value);
        (try object(value)).getPtr("version").?.* = .{ .integer = @intCast(next) };
    }
    return before != current;
}

/// One line per serialized leaf path, as std.json writes `T`. A snapshot of
/// this text catches a saved-format change that forgot its version bump.
/// Types in `sealed` have their own version and appear as a single line.
pub fn schema(comptime T: type, comptime sealed: []const type) []const u8 {
    @setEvalBranchQuota(1_000_000);
    return comptime shape(T, "$", sealed);
}

fn shape(comptime T: type, comptime path: []const u8, comptime sealed: []const type) []const u8 {
    inline for (sealed) |S| if (T == S) return path ++ ": versioned " ++ @typeName(T) ++ "\n";
    // Payloads a provider or a command defines (hook events, native messages).
    if (T == std.json.Value) return path ++ ": any\n";
    // A type that names the shape its own JSON writes shows that shape.
    if (@typeInfo(T) == .@"struct" and @hasDecl(T, "Json")) return shape(T.Json, path, sealed);
    const custom = switch (@typeInfo(T)) {
        .@"struct", .@"enum", .@"union" => std.meta.hasFn(T, "jsonStringify") or std.meta.hasFn(T, "jsonParse"),
        else => false,
    };
    if (custom) return path ++ ": custom " ++ @typeName(T) ++ "\n";
    return switch (@typeInfo(T)) {
        .bool, .int, .float => path ++ ": " ++ @typeName(T) ++ "\n",
        .void => path ++ ": {}\n",
        .optional => |info| path ++ ": optional\n" ++ shape(info.child, path ++ "?", sealed),
        .array => |info| if (info.child == u8)
            path ++ std.fmt.comptimePrint(": bytes[{d}]\n", .{info.len})
        else
            shape(info.child, path ++ std.fmt.comptimePrint("[{d}]", .{info.len}), sealed),
        .pointer => |info| if (info.size == .one)
            shape(info.child, path, sealed)
        else if (info.child == u8)
            path ++ ": string\n"
        else
            shape(info.child, path ++ "[]", sealed),
        // std.json writes an unnamed value of a non-exhaustive enum as its
        // integer, so an enum with no named values is just that integer.
        .@"enum" => |info| if (!info.is_exhaustive and info.fields.len == 0)
            path ++ ": " ++ @typeName(info.tag_type) ++ "\n"
        else names: {
            var out: []const u8 = path ++ (if (info.is_exhaustive) ": enum" else ": enum(" ++ @typeName(info.tag_type) ++ ")");
            for (info.fields) |field| out = out ++ " " ++ field.name;
            break :names out ++ "\n";
        },
        .@"struct" => |info| fields: {
            var out: []const u8 = if (info.fields.len == 0) path ++ ": {}\n" else "";
            for (info.fields) |field| out = out ++ shape(field.type, path ++ "." ++ field.name, sealed);
            break :fields out;
        },
        .@"union" => |info| fields: {
            var out: []const u8 = path ++ ": one of\n";
            for (info.fields) |field| out = out ++ shape(field.type, path ++ "|" ++ field.name, sealed);
            break :fields out;
        },
        else => @compileError("no saved-schema shape for " ++ @typeName(T)),
    };
}

/// Fails when `T` no longer matches `path`'s snapshot. With
/// CORGI_UPDATE_SCHEMA=1 it rewrites the snapshot instead.
pub fn expectSchema(comptime T: type, comptime sealed: []const type, comptime path: []const u8, snapshot: []const u8) !void {
    return expectShape(schema(T, sealed), path, snapshot, "saved",
        \\If old files still decode unchanged (a field with a default was added),
        \\refresh it with CORGI_UPDATE_SCHEMA=1. Otherwise bump the version with a
        \\migration and an old-format fixture first; see docs/development-reloads.md.
    );
}

/// `expectSchema` for what crosses the socket, which the version named by
/// `guard` covers: a daemon and its clients may be different builds.
pub fn expectWireSchema(comptime T: type, comptime sealed: []const type, comptime path: []const u8, snapshot: []const u8, comptime guard: []const u8) !void {
    return expectShape(schema(T, sealed), path, snapshot, "wire",
        \\If older peers still decode it (a field with a default was added or
        \\removed outside a session.command command, which rejects unknown fields),
        \\refresh it with CORGI_UPDATE_SCHEMA=1 and say so in the commit.
        \\Otherwise bump
    ++ " `" ++ guard ++ "`.\n" ++
        \\Requests that protocol.check leaves at .none carry no version, so a bump
        \\doesn't turn older senders away: change those only compatibly.
    );
}

fn expectShape(actual: []const u8, comptime path: []const u8, snapshot: []const u8, comptime format: []const u8, comptime advice: []const u8) !void {
    if ((os.env("CORGI_UPDATE_SCHEMA") != null)) {
        try std.Io.Dir.cwd().writeFile(os.io(), .{ .sub_path = path, .data = actual });
        return;
    }
    if (std.mem.eql(u8, actual, snapshot)) return;
    std.debug.print("{s} no longer matches the " ++ format ++ " format.\n" ++ advice ++ "\n", .{path});
    try std.testing.expectEqualStrings(snapshot, actual);
}

fn object(value: *Value) !*std.json.ObjectMap {
    if (value.* != .object) return error.InvalidCheckpoint;
    return &value.object;
}

test "a schema shows a JSON value a provider or command defines as any" {
    try std.testing.expectEqualStrings("$.event: any\n$.seq: optional\n$.seq?: i64\n", schema(struct { event: Value, seq: ?i64 }, &.{}));
}

test "migration steps import only std" {
    // A new import would compile, so this keeps runtime types out of the steps.
    var lines = std.mem.splitScalar(u8, @embedFile("steps.zig"), '\n');
    while (lines.next()) |line| if (std.mem.indexOf(u8, line, "@import(")) |at| {
        try std.testing.expect(std.mem.startsWith(u8, line[at..], "@import(\"std\")"));
    };
}

test "each released step still produces its golden output" {
    inline for (.{ .{ "checkpoint", &state_steps.checkpoint }, .{ "handoff", &state_steps.handoff } }) |kind| {
        inline for (kind[1], 1..) |step, n| {
            const name = std.fmt.comptimePrint("fixtures/steps/{s}-{d}", .{ kind[0], n });
            try expectStep(step, "src/" ++ name ++ ".out.json", @embedFile("../" ++ name ++ ".in.json"), @embedFile("../" ++ name ++ ".out.json"));
        }
    }
}

/// Fails when `step` no longer turns `in` into `out`. With
/// CORGI_UPDATE_SCHEMA=1 it rewrites `out_path` instead.
fn expectStep(step: state_steps.Step, comptime out_path: []const u8, in: []const u8, out: []const u8) !void {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();
    var value = try std.json.parseFromSliceLeaky(Value, alloc, in, .{});
    try step(alloc, &value);
    const actual = try std.fmt.allocPrint(alloc, "{f}\n", .{std.json.fmt(value, .{ .whitespace = .indent_2 })});
    if ((os.env("CORGI_UPDATE_SCHEMA") != null)) {
        try std.Io.Dir.cwd().writeFile(os.io(), .{ .sub_path = out_path, .data = actual });
        return;
    }
    if (std.mem.eql(u8, actual, out)) return;
    std.debug.print(
        \\{s} no longer matches what its step writes.
        \\A released step never changes; undo the edit to it. Only a step that has
        \\not shipped yet may refresh its output with CORGI_UPDATE_SCHEMA=1.
        \\
    , .{out_path});
    try std.testing.expectEqualStrings(out, actual);
}

test "versions are checked before current enum decoding" {
    const T = struct { version: u32, provider: enum { codex, claude } };
    try std.testing.expectError(error.UnsupportedStateVersion, decode(T, .checkpoint, std.testing.allocator,
        \\{"version":99,"provider":"other"}
    ));
    try std.testing.expectError(error.UnsupportedStateVersion, decode(T, .handoff, std.testing.allocator,
        \\{"version":99,"runtime":{"version":3},"provider":"other"}
    ));
    for ([_][]const u8{ "0", "-1", "null", "\"2\"", "2.5" }) |v| {
        const json = try std.fmt.allocPrint(std.testing.allocator, "{{\"version\":{s}}}", .{v});
        defer std.testing.allocator.free(json);
        try std.testing.expectError(error.InvalidStateVersion, decode(Value, .checkpoint, std.testing.allocator, json));
    }
    try std.testing.expectError(error.MissingStateVersion, decode(Value, .checkpoint, std.testing.allocator, "{}"));
    // A current schema carrying obsolete values is corrupt, not another upgrade.
    const current_json = try std.fmt.allocPrint(std.testing.allocator, "{{\"version\":{d},\"provider\":\"other\"}}", .{checkpoint_version});
    defer std.testing.allocator.free(current_json);
    try std.testing.expectError(error.InvalidEnumTag, decode(T, .checkpoint, std.testing.allocator, current_json));
}

test "provider migrations are scoped and accept both V2 representations" {
    const json =
        \\{"version":2,"panes":[{"agent":{"provider":"other"},"resume_hint":{"provider":null},"binding":{"provisional":{"provider":"codex"}}}],
        \\ "sessions":[{"provider":"claude","binding":{"provisional":{"provider":"other"}},"resume_hint":{"provider":"other"},"events":[{"provider":"other"}]}],
        \\ "conversations":[{"agent":{"provider":"claude"}}],
        \\ "agent_commands":[{"semantics":{"provider":"other"}}],"payload":{"provider":"other"}}
    ;
    const decoded = try decode(Value, .checkpoint, std.testing.allocator, json);
    defer decoded.deinit();
    const root = decoded.parsed.value.object;
    const pane = root.get("panes").?.array.items[0].object;
    try std.testing.expect(pane.get("binding").?.object.get("provisional").?.object.get("provider").? != .null);
    try std.testing.expect(pane.get("resume_hint").?.object.get("provider").? == .null);
    const session = root.get("sessions").?.array.items[0].object;
    try std.testing.expect(session.get("resume_hint").?.object.get("provider").? == .null);
    try std.testing.expectEqualStrings("claude", session.get("provider").?.string);
    try std.testing.expectEqualStrings("other", session.get("events").?.array.items[0].object.get("provider").?.string);
    try std.testing.expectEqualStrings("other", root.get("payload").?.object.get("provider").?.string);
    try std.testing.expect(root.get("agent_commands").?.array.items[0].object.get("semantics").?.object.get("provider").? == .null);
}

test "yolo is recovered from the saved mode text and left alone otherwise" {
    const json =
        \\{"version":3,"agent_commands":[
        \\ {"semantics":{"mode":{"bytes":"Skips permission checks","len":23}}},
        \\ {"semantics":{"mode":{"bytes":"Provider permission settings","len":28}}},
        \\ {"semantics":{"mode":{"bytes":[83,107,105,112,115],"len":5}}},
        \\ {"semantics":{}},
        \\ {}]}
    ;
    const decoded = try decode(Value, .checkpoint, std.testing.allocator, json);
    defer decoded.deinit();
    const commands = decoded.parsed.value.object.get("agent_commands").?.array.items;
    try std.testing.expect(commands[0].object.get("semantics").?.object.get("yolo").?.bool);
    try std.testing.expect(commands[1].object.get("semantics").?.object.get("yolo") == null);
    // A byte-array `mode` holding other text is not yolo.
    try std.testing.expect(commands[2].object.get("semantics").?.object.get("yolo") == null);
    try std.testing.expect(commands[3].object.get("semantics").?.object.get("yolo") == null);
    try std.testing.expectEqual(@as(usize, 0), commands[4].object.count());
}

test "handoff and runtime versions migrate independently without losing launch counts" {
    const T = struct {
        version: u32,
        runtime: struct { version: u32 },
        summaries: struct { launches: inference_setup.Launches },
    };
    const decoded = try decode(T, .handoff, std.testing.allocator,
        \\{"version":1,"runtime":{"version":1},"summaries":{"launches":{"codex":7,"claude":4,"latest":"claude"}}}
    );
    defer decoded.deinit();
    try std.testing.expectEqual(handoff_version, decoded.parsed.value.version);
    try std.testing.expectEqual(checkpoint_version, decoded.parsed.value.runtime.version);
    const launches = decoded.parsed.value.summaries.launches;
    try std.testing.expectEqual(@as(u32, 7), launches.count.get(.codex));
    try std.testing.expectEqual(@as(u32, 4), launches.count.get(.claude));
    try std.testing.expectEqual(providers.Provider.claude, launches.latest.?);
    const current_runtime = try decode(T, .handoff, std.testing.allocator,
        \\{"version":1,"runtime":{"version":3},"summaries":{"launches":{"count":{"values":[7,4]},"latest":"claude"}}}
    );
    defer current_runtime.deinit();
    try std.testing.expectEqual(@as(u32, 7), current_runtime.parsed.value.summaries.launches.count.get(.codex));
    try std.testing.expectError(error.UnsupportedStateVersion, decode(T, .handoff, std.testing.allocator,
        \\{"version":2,"runtime":{"version":99},"summaries":{}}
    ));
}

test "handoff keeps only the metered fact from launcher usage text" {
    const decoded = try decode(Value, .handoff, std.testing.allocator,
        \\{"version":2,"runtime":{"version":4},"clients":[
        \\ {"launch_preview":{"preview":{"options":[
        \\  {"usage":{"bytes":"Metered","len":7},"usage_metered":true,"resets":{}},
        \\  {"usage":{"bytes":"5h 12%","len":6},"usage_metered":false,"resets":{"at":[100,null]},"usage_fetched_at":9}]}}},
        \\ {"launch_preview":null}]}
    );
    defer decoded.deinit();
    const client = decoded.parsed.value.object.get("clients").?.array.items[0];
    const options = client.object.get("launch_preview").?.object.get("preview").?.object.get("options").?.object;
    const metered = try std.json.parseFromValue(account_preview.Limits, std.testing.allocator, options.get("codex").?.object.get("limits").?, .{});
    defer metered.deinit();
    try std.testing.expect(metered.value == .metered);
    try std.testing.expect(options.get("claude").?.object.get("limits") == null);
    try std.testing.expectEqual(@as(i64, 9), options.get("claude").?.object.get("usage_fetched_at").?.integer);
    for (options.values()) |option| for ([_][]const u8{ "usage", "usage_metered", "resets" }) |key|
        try std.testing.expect(!option.object.contains(key));
}

test "legacy panes and native sessions share one migrated conversation" {
    const decoded = try decode(Value, .checkpoint, std.testing.allocator,
        \\{"version":1,
        \\ "panes":[{"agent":{"provider":"codex","state":"blocked","session":"shared\u0000","session_len":6}},
        \\  {"agent":{"provider":"codex","state":"blocked","session":"shared\u0000","session_len":6},"binding":null}],
        \\ "sessions":[{"provider":"codex","state":"blocked","resume_hint":{"session":"shared\u0000","len":6}}]}
    );
    defer decoded.deinit();
    const state = decoded.parsed.value.object;
    try std.testing.expectEqual(@as(usize, 1), state.get("conversations").?.array.items.len);
    try std.testing.expectEqual(@as(i64, 2), state.get("next_conversation").?.integer);
    for (state.get("panes").?.array.items) |pane| {
        const binding = pane.object.get("binding").?.object;
        try std.testing.expectEqual(@as(i64, 1), binding.get("actor").?.integer);
        try std.testing.expectEqual(@as(i64, 1), binding.get("known").?.array.items[0].integer);
    }
    try std.testing.expectEqual(@as(i64, 1), state.get("sessions").?.array.items[0].object.get("binding").?.object.get("actor").?.integer);
}

test "promotion moves agents as JSON and never shares them" {
    // Unknown fields survive and byte-array sessions are read without decoding
    // into the current Agent type, which later versions are free to change.
    const json =
        \\{"version":2,"next_conversation":4,"conversations":[],"panes":[
        \\ {"agent":{"provider":"codex","session":[115,49,0],"session_len":2,"later":1}},
        \\ {"agent":{"provider":"codex","session":"s1\u0000","session_len":2}},
        \\ {"agent":{"provider":"claude","session":"","session_len":0,"later":2}}]}
    ;
    const decoded = try decode(Value, .checkpoint, std.testing.allocator, json);
    defer decoded.deinit();
    const root = decoded.parsed.value.object;
    try std.testing.expectEqual(@as(u32, 2), decoded.from);
    const actors = root.get("conversations").?.array.items;
    try std.testing.expectEqual(@as(usize, 1), actors.len);
    try std.testing.expectEqual(@as(i64, 4), actors[0].object.get("id").?.integer);
    try std.testing.expectEqual(@as(i64, 1), actors[0].object.get("agent").?.object.get("later").?.integer);
    try std.testing.expectEqual(@as(i64, 5), root.get("next_conversation").?.integer);
    const panes = root.get("panes").?.array.items;
    for (panes[0..2]) |pane| try std.testing.expectEqual(@as(i64, 4), pane.object.get("binding").?.object.get("actor").?.integer);
    const provisional = panes[2].object.get("binding").?.object.get("provisional").?.object;
    try std.testing.expectEqual(@as(i64, 2), provisional.get("later").?.integer);
    // A later step editing pane agents must not also edit their bindings.
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var tree = try std.json.parseFromSliceLeaky(Value, arena.allocator(), json, .{});
    try state_steps.checkpoint[1](arena.allocator(), &tree); // 2 -> 3
    const pane = tree.object.get("panes").?.array.items[2].object;
    pane.getPtr("agent").?.object.getPtr("later").?.* = .null;
    try std.testing.expectEqual(@as(i64, 2), pane.get("binding").?.object.get("provisional").?.object.get("later").?.integer);
    try std.testing.expectError(error.InvalidCheckpoint, decode(Value, .checkpoint, std.testing.allocator,
        \\{"version":2,"panes":[{"agent":{"provider":"codex","session":"s","session_len":9}}]}
    ));
}
