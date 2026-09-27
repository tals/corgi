//! Ordered JSON migrations at the persistence seam. Runtime code consumes only
//! the current schema; historical representations belong in these steps.
const std = @import("std");
const Allocator = std.mem.Allocator;
const Value = std.json.Value;

/// A migration rewrites one version's JSON tree into the next version's. Steps
/// see only JSON: they must not decode into runtime types, which keep changing
/// after the step is written. Append steps; never edit a released one.
const Step = *const fn (Allocator, *Value) Error!void;
const Error = Allocator.Error || error{InvalidCheckpoint};

/// Index `n` upgrades version `n + 1` to `n + 2`.
const checkpoint_steps = [_]Step{ checkpoint1To2, checkpoint2To3 };
const handoff_steps = [_]Step{handoff1To2};

pub const checkpoint_version: u32 = checkpoint_steps.len + 1;
pub const handoff_version: u32 = handoff_steps.len + 1;
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
        .checkpoint => try migrate(&checkpoint_steps, alloc, &json.value),
        .handoff => handoff: {
            const outer = try migrate(&handoff_steps, alloc, &json.value);
            const runtime = (try object(&json.value)).getPtr("runtime") orelse return error.MissingField;
            break :handoff try migrate(&checkpoint_steps, alloc, runtime) or outer;
        },
    };
    const value = try std.json.parseFromValueLeaky(T, alloc, json.value, .{ .ignore_unknown_fields = true });
    return .{ .parsed = .{ .arena = json.arena, .value = value }, .from = from, .migrated = migrated };
}

fn version(value: *Value, current: u32) !*Value {
    const field = (try object(value)).getPtr("version") orelse return error.MissingStateVersion;
    if (field.* != .integer or field.integer < 1) return error.InvalidStateVersion;
    if (field.integer > current) return error.UnsupportedStateVersion;
    return field;
}

fn migrate(steps: []const Step, alloc: Allocator, value: *Value) !bool {
    const current = steps.len + 1;
    // Steps add fields, so no map-entry pointer is held across them.
    const before: usize = @intCast((try version(value, @intCast(current))).integer);
    for (steps[before - 1 ..], before + 1..) |step, next| {
        try step(alloc, value);
        (try object(value)).getPtr("version").?.* = .{ .integer = @intCast(next) };
    }
    return before != current;
}

fn checkpoint1To2(alloc: Allocator, value: *Value) Error!void {
    // V1 stored identity on panes/native sessions. V2 introduced actor tables;
    // V3 makes bindings mandatory and promotes any remaining inline identities.
    try conversationTable(alloc, value);
}

fn conversationTable(alloc: Allocator, value: *Value) Error!void {
    const fields = try object(value);
    if (!fields.contains("conversations")) try fields.put("conversations", .{ .array = .init(alloc) });
    if (!fields.contains("next_conversation")) try fields.put("next_conversation", .{ .integer = 1 });
}

fn checkpoint2To3(alloc: Allocator, value: *Value) Error!void {
    // Both `other` and null shipped under V2. Only these schema-owned optional
    // provider fields changed; never walk opaque payloads or replace text.
    for (try items(value, "panes")) |*pane| {
        try optionalProvider(pane, "agent");
        try optionalProvider(pane, "resume_hint");
        try bindingProvider(pane);
    }
    for (try items(value, "sessions")) |*session| {
        try optionalProvider(session, "resume_hint");
        try bindingProvider(session);
    }
    for (try items(value, "conversations")) |*conversation| try optionalProvider(conversation, "agent");
    for (try items(value, "agent_commands")) |*command| try optionalProvider(command, "semantics");
    try promoteBindings(alloc, value);
}

/// Gives every pane and native session a binding. An inline identity with a
/// provider and session becomes (or joins) a conversation; anything else stays
/// provisional. Agents are moved as JSON so later steps see one shape.
fn promoteBindings(alloc: Allocator, state: *Value) Error!void {
    try conversationTable(alloc, state);
    inline for (.{ "panes", "sessions" }) |collection| {
        for (try items(state, collection)) |*entry| {
            const fields = try object(entry);
            if (fields.get("binding")) |binding| if (binding != .null) continue;
            var legacy: Value = if (comptime std.mem.eql(u8, collection, "panes"))
                try clone(alloc, fields.get("agent") orelse .{ .object = .init(alloc) })
            else legacy: {
                // Native V1 kept identity in its resume hint and lifecycle on
                // the transport. Reassemble the agent only here.
                var raw: Value = .{ .object = .init(alloc) };
                inline for (.{ "provider", "state", "attention", "observation" }) |key| {
                    if (fields.get(key)) |field| try raw.object.put(key, try clone(alloc, field));
                }
                if (fields.getPtr("resume_hint")) |hint| {
                    const hint_fields = try object(hint);
                    if (hint_fields.get("session")) |field| try raw.object.put("session", try clone(alloc, field));
                    if (hint_fields.get("len")) |field| try raw.object.put("session_len", try clone(alloc, field));
                }
                break :legacy raw;
            };
            if (legacy != .object) return error.InvalidCheckpoint;
            var binding: Value = .{ .object = .init(alloc) };
            if (try identity(alloc, &legacy)) |id| {
                const actor = try conversationFor(alloc, state, id, legacy);
                var known: Value = .{ .array = .init(alloc) };
                try known.array.append(.{ .integer = actor });
                try binding.object.put("actor", .{ .integer = actor });
                // A fresh attachment starts at 1; selecting the actor bumps it.
                try binding.object.put("generation", .{ .integer = 2 });
                try binding.object.put("known", known);
            } else try binding.object.put("provisional", legacy);
            try fields.put("binding", binding);
        }
    }
}

const Identity = struct { provider: []const u8, session: []const u8 };

/// The provider and session an agent object names, or null if it names none.
fn identity(alloc: Allocator, agent: *Value) Error!?Identity {
    const fields = try object(agent);
    const provider = switch (fields.get("provider") orelse .null) {
        .null => return null,
        .string => |name| name,
        else => return error.InvalidCheckpoint,
    };
    const len: usize = switch (fields.get("session_len") orelse Value{ .integer = 0 }) {
        .integer => |n| std.math.cast(usize, n) orelse return error.InvalidCheckpoint,
        else => return error.InvalidCheckpoint,
    };
    if (len == 0) return null;
    // Fixed byte buffers serialize as a string, or as numbers when not UTF-8.
    const bytes: []const u8 = switch (fields.get("session") orelse return error.InvalidCheckpoint) {
        .string => |text| text,
        .array => |list| bytes: {
            const out = try alloc.alloc(u8, list.items.len);
            for (list.items, out) |item, *byte| byte.* = switch (item) {
                .integer => |n| std.math.cast(u8, n) orelse return error.InvalidCheckpoint,
                else => return error.InvalidCheckpoint,
            };
            break :bytes out;
        },
        else => return error.InvalidCheckpoint,
    };
    if (len > bytes.len) return error.InvalidCheckpoint;
    return .{ .provider = provider, .session = bytes[0..len] };
}

/// The conversation id for `id`, appending one that owns `agent` if needed.
fn conversationFor(alloc: Allocator, state: *Value, id: Identity, agent: Value) Error!i64 {
    const actors = (try object(state)).getPtr("conversations").?;
    if (actors.* != .array) return error.InvalidCheckpoint;
    for (actors.array.items) |*actor| {
        const saved = try object(actor);
        const other = try identity(alloc, saved.getPtr("agent") orelse return error.InvalidCheckpoint) orelse continue;
        if (!std.mem.eql(u8, other.provider, id.provider) or !std.mem.eql(u8, other.session, id.session)) continue;
        return switch (saved.get("id") orelse return error.InvalidCheckpoint) {
            .integer => |n| if (n >= 1 and n <= std.math.maxInt(u32)) n else error.InvalidCheckpoint,
            else => error.InvalidCheckpoint,
        };
    }
    const next = (try object(state)).getPtr("next_conversation").?;
    if (next.* != .integer or next.integer < 1 or next.integer >= std.math.maxInt(u32)) return error.InvalidCheckpoint;
    const actor = next.integer;
    next.integer += 1;
    var entry: Value = .{ .object = .init(alloc) };
    try entry.object.put("id", .{ .integer = actor });
    // The binding keeps no copy, so the conversation owns this tree outright.
    try entry.object.put("agent", agent);
    try actors.array.append(entry);
    return actor;
}

/// Deep copy, so no two places in the tree share a map a later step may edit.
fn clone(alloc: Allocator, value: Value) Allocator.Error!Value {
    return switch (value) {
        .object => |map| copy: {
            var out: std.json.ObjectMap = .init(alloc);
            var it = map.iterator();
            while (it.next()) |entry| try out.put(entry.key_ptr.*, try clone(alloc, entry.value_ptr.*));
            break :copy .{ .object = out };
        },
        .array => |list| copy: {
            var out: std.json.Array = try .initCapacity(alloc, list.items.len);
            for (list.items) |item| out.appendAssumeCapacity(try clone(alloc, item));
            break :copy .{ .array = out };
        },
        else => value,
    };
}

fn handoff1To2(alloc: Allocator, value: *Value) Error!void {
    const summaries = (try object(value)).getPtr("summaries") orelse return;
    if (summaries.* == .null) return;
    const launches = (try object(summaries)).getPtr("launches") orelse return;
    const fields = try object(launches);
    if (!fields.contains("count")) {
        // The historical inference enum order was codex, claude. Preserve the
        // counters even if the application enum order changes in the future.
        var values: std.json.Array = .init(alloc);
        try values.append(fields.get("codex") orelse .{ .integer = 0 });
        try values.append(fields.get("claude") orelse .{ .integer = 0 });
        var count: std.json.ObjectMap = .init(alloc);
        try count.put("values", .{ .array = values });
        try fields.put("count", .{ .object = count });
    }
    _ = fields.swapRemove("codex");
    _ = fields.swapRemove("claude");
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
        .@"enum" => |info| names: {
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
    const actual = schema(T, sealed);
    if (std.process.hasEnvVarConstant("CORGI_UPDATE_SCHEMA")) {
        try std.fs.cwd().writeFile(.{ .sub_path = path, .data = actual });
        return;
    }
    if (std.mem.eql(u8, actual, snapshot)) return;
    std.debug.print(
        \\{s} no longer matches the saved format.
        \\If old files still decode unchanged (a field with a default was added),
        \\refresh it with CORGI_UPDATE_SCHEMA=1. Otherwise bump the version with a
        \\migration and an old-format fixture first; see docs/development-reloads.md.
        \\
    , .{path});
    try std.testing.expectEqualStrings(snapshot, actual);
}

fn object(value: *Value) !*std.json.ObjectMap {
    if (value.* != .object) return error.InvalidCheckpoint;
    return &value.object;
}

fn items(value: *Value, key: []const u8) ![]Value {
    const field = (try object(value)).getPtr(key) orelse return &.{};
    if (field.* != .array) return error.InvalidCheckpoint;
    return field.array.items;
}

fn optionalProvider(value: *Value, key: []const u8) !void {
    const field = (try object(value)).getPtr(key) orelse return;
    const provider = (try object(field)).getPtr("provider") orelse return;
    if (provider.* == .string and std.mem.eql(u8, provider.string, "other")) provider.* = .null;
}

fn bindingProvider(value: *Value) !void {
    const binding = (try object(value)).getPtr("binding") orelse return;
    if (binding.* != .null) try optionalProvider(binding, "provisional");
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
    try std.testing.expectError(error.InvalidEnumTag, decode(T, .checkpoint, std.testing.allocator,
        \\{"version":3,"provider":"other"}
    ));
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
    try std.testing.expect(pane.get("agent").?.object.get("provider").? == .null);
    try std.testing.expect(pane.get("resume_hint").?.object.get("provider").? == .null);
    const session = root.get("sessions").?.array.items[0].object;
    try std.testing.expect(session.get("resume_hint").?.object.get("provider").? == .null);
    try std.testing.expectEqualStrings("claude", session.get("provider").?.string);
    try std.testing.expectEqualStrings("other", session.get("events").?.array.items[0].object.get("provider").?.string);
    try std.testing.expectEqualStrings("other", root.get("payload").?.object.get("provider").?.string);
    try std.testing.expect(root.get("agent_commands").?.array.items[0].object.get("semantics").?.object.get("provider").? == .null);
}

test "handoff and runtime versions migrate independently without losing launch counts" {
    const T = struct {
        version: u32,
        runtime: struct { version: u32 },
        summaries: struct { launches: @import("inference_setup.zig").Launches },
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
    try std.testing.expectEqual(@import("providers.zig").Provider.claude, launches.latest.?);
    const current_runtime = try decode(T, .handoff, std.testing.allocator,
        \\{"version":1,"runtime":{"version":3},"summaries":{"launches":{"count":{"values":[7,4]},"latest":"claude"}}}
    );
    defer current_runtime.deinit();
    try std.testing.expectEqual(@as(u32, 7), current_runtime.parsed.value.summaries.launches.count.get(.codex));
    try std.testing.expectError(error.UnsupportedStateVersion, decode(T, .handoff, std.testing.allocator,
        \\{"version":2,"runtime":{"version":99},"summaries":{}}
    ));
}

test "legacy panes and native sessions share one migrated conversation" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();
    var agent: @import("agents.zig").Agent = .{ .provider = .codex, .state = .blocked };
    @memcpy(agent.session[0..6], "shared");
    agent.session_len = 6;
    const bytes = try std.json.Stringify.valueAlloc(alloc, .{
        .version = 1,
        .panes = .{ .{ .agent = agent }, .{ .agent = agent, .binding = null } },
        .sessions = .{.{ .provider = "codex", .state = "blocked", .resume_hint = .{ .session = agent.session, .len = agent.session_len } }},
    }, .{});
    const decoded = try decode(Value, .checkpoint, std.testing.allocator, bytes);
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
    try std.testing.expect(provisional.get("later").? == .integer);
    panes[2].object.getPtr("agent").?.object.getPtr("later").?.* = .null;
    try std.testing.expectEqual(@as(i64, 2), provisional.get("later").?.integer);
    try std.testing.expectError(error.InvalidCheckpoint, decode(Value, .checkpoint, std.testing.allocator,
        \\{"version":2,"panes":[{"agent":{"provider":"codex","session":"s","session_len":9}}]}
    ));
}
