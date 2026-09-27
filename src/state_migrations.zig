//! Ordered JSON migrations at the persistence seam. Runtime code consumes only
//! the current schema; historical representations belong in these steps.
const std = @import("std");
const Allocator = std.mem.Allocator;
const Value = std.json.Value;

pub const checkpoint_version: u32 = 3;
pub const handoff_version: u32 = 2;
pub const Kind = enum { checkpoint, handoff };

pub fn Decoded(comptime T: type) type {
    return struct {
        parsed: std.json.Parsed(T),
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
    const migrated = switch (kind) {
        .checkpoint => try checkpoint(alloc, &json.value),
        .handoff => try handoff(alloc, &json.value),
    };
    const value = try std.json.parseFromValueLeaky(T, alloc, json.value, .{ .ignore_unknown_fields = true });
    return .{ .parsed = .{ .arena = json.arena, .value = value }, .migrated = migrated };
}

fn version(value: *Value, current: u32) !*Value {
    const field = (try object(value)).getPtr("version") orelse return error.MissingStateVersion;
    if (field.* != .integer or field.integer < 1) return error.InvalidStateVersion;
    if (field.integer > current) return error.UnsupportedStateVersion;
    return field;
}

fn checkpoint(alloc: Allocator, value: *Value) !bool {
    // Do not retain a map-entry pointer across migrations that add fields.
    const before = (try version(value, checkpoint_version)).integer;
    var current = before;
    while (current < checkpoint_version) {
        switch (current) {
            1 => try checkpoint1To2(alloc, value),
            2 => try checkpoint2To3(alloc, value),
            else => return error.UnsupportedStateVersion,
        }
        current += 1;
        (try object(value)).getPtr("version").?.* = .{ .integer = current };
    }
    return before != current;
}

fn handoff(alloc: Allocator, value: *Value) !bool {
    const before = (try version(value, handoff_version)).integer;
    var current = before;
    while (current < handoff_version) {
        switch (current) {
            1 => try handoff1To2(alloc, value),
            else => return error.UnsupportedStateVersion,
        }
        current += 1;
        (try object(value)).getPtr("version").?.* = .{ .integer = current };
    }
    const runtime = (try object(value)).getPtr("runtime") orelse return error.MissingField;
    const migrated_runtime = try checkpoint(alloc, runtime);
    return before != current or migrated_runtime;
}

fn checkpoint1To2(alloc: Allocator, value: *Value) !void {
    // V1 stored identity on panes/native sessions. V2 introduced actor tables;
    // V3 makes bindings mandatory and promotes any remaining inline identities.
    const fields = try object(value);
    if (!fields.contains("conversations")) try fields.put("conversations", .{ .array = std.array_list.Managed(Value).init(alloc) });
    if (!fields.contains("next_conversation")) try fields.put("next_conversation", .{ .integer = 1 });
}

fn checkpoint2To3(alloc: Allocator, value: *Value) !void {
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

fn jsonValue(alloc: Allocator, value: anytype) !Value {
    const bytes = try std.json.Stringify.valueAlloc(alloc, value, .{});
    return std.json.parseFromSliceLeaky(Value, alloc, bytes, .{});
}

fn promoteBindings(alloc: Allocator, state: *Value) !void {
    const Agent = @import("agents.zig").Agent;
    try checkpoint1To2(alloc, state);
    const actors = (try object(state)).getPtr("conversations").?;
    if (actors.* != .array) return error.InvalidCheckpoint;
    const next = (try object(state)).getPtr("next_conversation").?;
    if (next.* != .integer or next.integer < 1 or next.integer > std.math.maxInt(u32)) return error.InvalidCheckpoint;
    inline for (.{ "panes", "sessions" }) |collection| {
        for (try items(state, collection)) |*entry| {
            const fields = try object(entry);
            if (fields.get("binding")) |binding| if (binding != .null) continue;
            var legacy: Agent = undefined;
            if (comptime std.mem.eql(u8, collection, "panes")) {
                legacy = try std.json.parseFromValueLeaky(Agent, alloc, fields.get("agent") orelse try jsonValue(alloc, Agent{}), .{ .ignore_unknown_fields = true });
            } else {
                // Native V1 kept identity in its resume hint and lifecycle on
                // the transport. Reassemble it only here, before decoding V3.
                var raw = try jsonValue(alloc, Agent{});
                inline for (.{ "provider", "state", "attention", "observation" }) |key| {
                    if (fields.get(key)) |field| try raw.object.put(key, field);
                }
                if (fields.getPtr("resume_hint")) |hint| {
                    const hint_fields = try object(hint);
                    if (hint_fields.get("session")) |field| try raw.object.put("session", field);
                    if (hint_fields.get("len")) |field| try raw.object.put("session_len", field);
                }
                legacy = try std.json.parseFromValueLeaky(Agent, alloc, raw, .{ .ignore_unknown_fields = true });
            }
            if (legacy.session_len > legacy.session.len) return error.InvalidCheckpoint;
            var id: u32 = 0;
            if (legacy.provider != null and legacy.session_len > 0) {
                for (actors.array.items) |*actor| {
                    const saved = try object(actor);
                    const agent = try std.json.parseFromValueLeaky(Agent, alloc, saved.get("agent") orelse return error.MissingField, .{ .ignore_unknown_fields = true });
                    if (agent.session_len > agent.session.len) return error.InvalidCheckpoint;
                    if (agent.provider == legacy.provider and std.mem.eql(u8, agent.sessionId(), legacy.sessionId())) {
                        id = try std.json.parseFromValueLeaky(u32, alloc, saved.get("id") orelse return error.MissingField, .{});
                        if (id == 0) return error.InvalidCheckpoint;
                        break;
                    }
                }
                if (id == 0) {
                    if (next.integer == std.math.maxInt(u32)) return error.InvalidCheckpoint;
                    id = @intCast(next.integer);
                    next.integer += 1;
                    try actors.array.append(try jsonValue(alloc, .{ .id = id, .agent = legacy }));
                }
            }
            try fields.put("binding", if (id == 0)
                try jsonValue(alloc, .{ .provisional = legacy })
            else
                try jsonValue(alloc, .{ .actor = id, .generation = @as(u64, 2), .known = &[_]u32{id} }));
        }
    }
}

fn handoff1To2(alloc: Allocator, value: *Value) !void {
    const summaries = (try object(value)).getPtr("summaries") orelse return;
    if (summaries.* == .null) return;
    const launches = (try object(summaries)).getPtr("launches") orelse return;
    const fields = try object(launches);
    if (!fields.contains("count")) {
        // The historical inference enum order was codex, claude. Preserve the
        // counters even if the application enum order changes in the future.
        var values = std.array_list.Managed(Value).init(alloc);
        try values.append(fields.get("codex") orelse .{ .integer = 0 });
        try values.append(fields.get("claude") orelse .{ .integer = 0 });
        var count = std.json.ObjectMap.init(alloc);
        try count.put("values", .{ .array = values });
        try fields.put("count", .{ .object = count });
    }
    _ = fields.swapRemove("codex");
    _ = fields.swapRemove("claude");
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
