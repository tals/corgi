//! Ordered JSON migrations at the persistence seam. Runtime code consumes only
//! the current schema; historical representations belong in these steps.
const std = @import("std");
const Allocator = std.mem.Allocator;
const Value = std.json.Value;
const inference_setup = @import("inference_setup.zig");
const providers = @import("providers.zig");
const agents = @import("agents.zig");
const account_preview = @import("account_preview.zig");

/// A migration rewrites one version's JSON tree into the next version's. Steps
/// see only JSON: they must not decode into runtime types, which keep changing
/// after the step is written. Append steps; never edit a released one.
const Step = *const fn (Allocator, *Value) Error!void;
const Error = Allocator.Error || error{InvalidCheckpoint};

/// Index `n` upgrades version `n + 1` to `n + 2`.
const checkpoint_steps = [_]Step{ checkpoint1To2, checkpoint2To3, checkpoint3To4, checkpoint4To5 };
const handoff_steps = [_]Step{ handoff1To2, handoff2To3, handoff3To4 };

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

/// Why a saved state cannot be read; a reload candidate reports these by name.
pub const VersionError = error{ MissingStateVersion, InvalidStateVersion, UnsupportedStateVersion };
fn version(value: *Value, current: u32) (VersionError || error{InvalidCheckpoint})!*Value {
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

fn checkpoint3To4(alloc: Allocator, value: *Value) Error!void {
    // V3 only ever recorded yolo as `semantics.mode` display text. Recover the
    // fact for any command whose text names the yolo mode; otherwise leave
    // `yolo` unset, which decodes to its default of false.
    _ = alloc;
    for (try items(value, "agent_commands")) |*command| {
        const fields = object(command) catch continue;
        const semantics = fields.getPtr("semantics") orelse continue;
        const info = object(semantics) catch continue;
        if (modeIsYolo(info)) try info.put("yolo", .{ .bool = true });
    }
}

/// A missing or malformed `mode` reports false rather than failing the step.
fn modeIsYolo(info: *std.json.ObjectMap) bool {
    const mode = info.getPtr("mode") orelse return false;
    const fields = object(mode) catch return false;
    const wanted = "Skips permission checks";
    const len: usize = switch (fields.get("len") orelse return false) {
        .integer => |n| std.math.cast(usize, n) orelse return false,
        else => return false,
    };
    if (len != wanted.len) return false;
    return switch (fields.get("bytes") orelse return false) {
        // Fixed byte buffers serialize as a string, or as numbers when not UTF-8.
        .string => |text| text.len >= len and std.mem.eql(u8, text[0..len], wanted),
        .array => |list| array: {
            if (list.items.len < len) break :array false;
            for (list.items[0..len], wanted) |item, want| {
                const byte: u8 = switch (item) {
                    .integer => |n| std.math.cast(u8, n) orelse break :array false,
                    else => break :array false,
                };
                if (byte != want) break :array false;
            }
            break :array true;
        },
        else => false,
    };
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

fn handoff2To3(alloc: Allocator, value: *Value) Error!void {
    // V2 kept launcher usage as display text. Only `usage_metered` carries over
    // without reading that text back; windows return with the next preview.
    for (try items(value, "clients")) |*client| {
        const saved = (try object(client)).getPtr("launch_preview") orelse continue;
        if (saved.* == .null) continue;
        const preview = (try object(saved)).getPtr("preview") orelse continue;
        for (try items(preview, "options")) |*option| {
            const fields = try object(option);
            if (fields.get("usage_metered")) |metered| if (metered == .bool and metered.bool) {
                var limits: Value = .{ .object = .init(alloc) };
                try limits.object.put("metered", .{ .object = .init(alloc) });
                try fields.put("limits", limits);
            };
            _ = fields.swapRemove("usage");
            _ = fields.swapRemove("usage_metered");
            _ = fields.swapRemove("resets");
        }
    }
}

fn checkpoint4To5(alloc: Allocator, value: *Value) Error!void {
    // V4 wrote each text as its whole fixed buffer beside a length, and
    // per-provider settings as arrays in enum order. V5 writes the text alone
    // and names each provider.
    for (try items(value, "conversations")) |*conversation| {
        const fields = try object(conversation);
        if (fields.getPtr("agent")) |agent| try agentText(alloc, agent);
        if (fields.getPtr("status_inference")) |status| try recentText(alloc, status);
    }
    inline for (.{ "panes", "sessions" }) |collection| for (try items(value, collection)) |*entry| {
        const fields = try object(entry);
        if (fields.getPtr("binding")) |binding| if (binding.* != .null) {
            if ((try object(binding)).getPtr("provisional")) |agent| try agentText(alloc, agent);
        };
        if (fields.getPtr("resume_hint")) |hint| {
            const saved = try object(hint);
            try pairedText(alloc, saved, "name", "name_len");
            try pairedText(alloc, saved, "session", "len");
        }
    };
    for (try items(value, "panes")) |*pane| {
        const fields = try object(pane);
        // Restore rebuilds a pane's agent from its binding. Only the V1 to V3
        // steps read this copy, and they run first.
        _ = fields.swapRemove("agent");
        try wrappedText(alloc, fields.getPtr("label"));
    }
    for (try items(value, "closed")) |*pane| try wrappedText(alloc, (try object(pane)).getPtr("label"));
    if ((try object(value)).getPtr("link_labels")) |labels| for (try items(labels, "entries")) |*entry| {
        if (entry.* != .null) try wrappedText(alloc, (try object(entry)).getPtr("name"));
    };
    for (try items(value, "agent_commands")) |*command| try commandText(alloc, command);
    try byProvider(alloc, (try object(value)).getPtr("agent_yolo"), .bool);
    try byProvider(alloc, (try object(value)).getPtr("agent_hidden"), .bool);
}

/// An agent as V4 wrote it: each text beside its `_len`.
fn agentText(alloc: Allocator, agent: *Value) Error!void {
    const fields = try object(agent);
    inline for (.{ "name", "transcript", "turn", "last_finished_turn", "recent", "session", "activity", "tool", "cwd" }) |key|
        try pairedText(alloc, fields, key, key ++ "_len");
}

/// A launch command's text also moves from `bytes` to `command`.
fn commandText(alloc: Allocator, command: *Value) Error!void {
    const fields = try object(command);
    try pairedText(alloc, fields, "bytes", "len");
    if (fields.fetchSwapRemove("bytes")) |text| try fields.put("command", text.value);
    try pairedText(alloc, fields, "original", "original_len");
    try wrappedText(alloc, fields.getPtr("name"));
    const semantics = fields.getPtr("semantics") orelse return;
    const info = try object(semantics);
    inline for (.{ "suggested_name", "model", "account", "mode" }) |key| try wrappedText(alloc, info.getPtr(key));
}

/// Recent summaries, as a conversation's `status_inference` and a summary
/// request's `conversation` save them. Their own `len` counts entries.
fn recentText(alloc: Allocator, recent: *Value) Error!void {
    for (try items(recent, "recent")) |*entry| try wrappedText(alloc, entry);
    try wrappedText(alloc, (try object(recent)).getPtr("previous"));
}

fn handoff3To4(alloc: Allocator, value: *Value) Error!void {
    // V3 wrote summary and launcher text as whole fixed buffers beside a
    // length, and per-provider values as arrays in provider enum order. V4
    // writes the text alone and names each provider. `runtime` has its own
    // steps.
    if ((try object(value)).getPtr("summaries")) |summaries| if (summaries.* != .null) {
        if ((try object(summaries)).getPtr("launches")) |launches| if ((try object(launches)).getPtr("count")) |count| {
            // A std.EnumArray: `{"values": [codex, claude]}`.
            count.* = (try object(count)).get("values") orelse return error.InvalidCheckpoint;
            try byProvider(alloc, count, .integer);
        };
        for (try items(summaries, "slots")) |*entry| {
            if ((try object(entry)).getPtr("slot")) |slot| try slotText(alloc, slot);
        }
        for (try items(summaries, "link_results")) |*result| {
            if (result.* != .null) try wrappedText(alloc, (try object(result)).getPtr("name"));
        }
    };
    for (try items(value, "clients")) |*client| {
        const saved = (try object(client)).getPtr("launch_preview") orelse continue;
        if (saved.* == .null) continue;
        const fields = try object(saved);
        try pairedText(alloc, fields, "cwd", "len");
        const preview = fields.getPtr("preview") orelse continue;
        for (try items(preview, "options")) |*option| {
            const texts = try object(option);
            inline for (.{ "model", "source", "account", "plan", "usage_error" }) |key| try wrappedText(alloc, texts.getPtr(key));
        }
        try byProvider(alloc, (try object(preview)).getPtr("options"), .object);
        try byProvider(alloc, (try object(preview)).getPtr("installed"), .bool);
    }
}

/// A summary slot: its request, and the request its result answered.
fn slotText(alloc: Allocator, slot: *Value) Error!void {
    const fields = try object(slot);
    if (fields.getPtr("request")) |request| try requestText(alloc, request);
    try wrappedText(alloc, fields.getPtr("commentary"));
    try wrappedText(alloc, fields.getPtr("tool_evidence"));
    const result = fields.getPtr("result") orelse return;
    if (result.* == .null) return;
    const answered = try object(result);
    if (answered.getPtr("request")) |request| try requestText(alloc, request);
    try wrappedText(alloc, answered.getPtr("label"));
}

fn requestText(alloc: Allocator, request: *Value) Error!void {
    const fields = try object(request);
    inline for (.{ "session", "turn", "name" }) |key| try pairedText(alloc, fields, key, key ++ "_len");
    try wrappedText(alloc, fields.getPtr("evidence"));
    if (fields.getPtr("conversation")) |conversation| try recentText(alloc, conversation);
}

/// V4 and older wrote a fixed text buffer whole: a string padded to its size,
/// or numbers when it was not UTF-8. Only the first `len` bytes are text.
/// Writers leave stale bytes past it ("Idleing tests" with len 4), so cut by
/// length and never trim NULs. A missing buffer or length is empty.
fn fixedText(alloc: Allocator, bytes: ?Value, len: ?Value) Error!Value {
    const n: usize = switch (len orelse Value{ .integer = 0 }) {
        .integer => |i| std.math.cast(usize, i) orelse return error.InvalidCheckpoint,
        else => return error.InvalidCheckpoint,
    };
    const buffer: []const u8 = switch (bytes orelse Value{ .string = "" }) {
        .string => |text| text,
        .array => |list| numbers: {
            const out = try alloc.alloc(u8, list.items.len);
            for (list.items, out) |item, *byte| byte.* = switch (item) {
                .integer => |i| std.math.cast(u8, i) orelse return error.InvalidCheckpoint,
                else => return error.InvalidCheckpoint,
            };
            break :numbers out;
        },
        else => return error.InvalidCheckpoint,
    };
    if (n > buffer.len) return error.InvalidCheckpoint;
    return .{ .string = buffer[0..n] };
}

/// `{"bytes": …, "len": n}` becomes its text in place. Missing or null stays.
fn wrappedText(alloc: Allocator, field: ?*Value) Error!void {
    const text = field orelse return;
    if (text.* == .null) return;
    const saved = try object(text);
    text.* = try fixedText(alloc, saved.get("bytes"), saved.get("len"));
}

/// The buffer at `key` and its length at `len_key` become one string at `key`.
fn pairedText(alloc: Allocator, fields: *std.json.ObjectMap, key: []const u8, len_key: []const u8) Error!void {
    const bytes = fields.getPtr(key) orelse return;
    bytes.* = try fixedText(alloc, bytes.*, fields.get(len_key));
    _ = fields.swapRemove(len_key);
}

/// Per-provider values were arrays in the provider enum's order of the time,
/// codex then claude. Naming them keeps a later provider or order from
/// shifting them.
fn byProvider(alloc: Allocator, field: ?*Value, comptime tag: std.meta.Tag(Value)) Error!void {
    const list = field orelse return;
    const names = [_][]const u8{ "codex", "claude" };
    if (list.* != .array or list.array.items.len > names.len) return error.InvalidCheckpoint;
    var named: std.json.ObjectMap = .init(alloc);
    for (list.array.items, names[0..list.array.items.len]) |item, name| {
        if (item != tag) return error.InvalidCheckpoint;
        try named.put(name, item);
    }
    list.* = .{ .object = named };
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
    try checkpoint2To3(arena.allocator(), &tree);
    const pane = tree.object.get("panes").?.array.items[2].object;
    pane.getPtr("agent").?.object.getPtr("later").?.* = .null;
    try std.testing.expectEqual(@as(i64, 2), pane.get("binding").?.object.get("provisional").?.object.get("later").?.integer);
    try std.testing.expectError(error.InvalidCheckpoint, decode(Value, .checkpoint, std.testing.allocator,
        \\{"version":2,"panes":[{"agent":{"provider":"codex","session":"s","session_len":9}}]}
    ));
}

test "fixed text is cut at its saved length, never at a NUL" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();
    var root = try std.json.parseFromSliceLeaky(Value, alloc,
        \\{"activity":"Idleing tests\u0000\u0000","activity_len":4,"session":[115,49,255,0],"session_len":2,
        \\ "turn":"t1\u0000","label":{"bytes":"a\u0000b\u0000","len":3},"empty":{"len":0},"name":null}
    , .{});
    const fields = try object(&root);
    try pairedText(alloc, fields, "activity", "activity_len");
    try pairedText(alloc, fields, "session", "session_len");
    try pairedText(alloc, fields, "turn", "turn_len");
    try pairedText(alloc, fields, "tool", "tool_len");
    inline for (.{ "label", "empty", "name", "missing" }) |key| try wrappedText(alloc, fields.getPtr(key));
    try expectJson(
        \\{"activity":"Idle","session":"s1","turn":"","label":"a\u0000b","empty":"","name":null}
    , root);
    // A byte-array buffer keeps its bytes, UTF-8 or not.
    const numbers = try std.json.parseFromSliceLeaky(Value, alloc, "[104,105,255,0]", .{});
    try std.testing.expectEqualStrings("hi\xff", (try fixedText(alloc, numbers, .{ .integer = 3 })).string);
    for ([_][]const u8{
        \\{"name":"ab","name_len":3}
        ,
        \\{"name":[97,98],"name_len":3}
        ,
        \\{"name":"ab","name_len":-1}
        ,
        \\{"name":[97,256],"name_len":1}
        ,
        \\{"name":null,"name_len":0}
        ,
        \\{"label":{"bytes":"ab","len":3}}
        ,
        \\{"label":{"len":1}}
        ,
        \\{"label":"ab"}
    }) |json| {
        var bad = try std.json.parseFromSliceLeaky(Value, alloc, json, .{});
        const saved = try object(&bad);
        const result = if (saved.contains("label")) wrappedText(alloc, saved.getPtr("label")) else pairedText(alloc, saved, "name", "name_len");
        try std.testing.expectError(error.InvalidCheckpoint, result);
    }
}

test "checkpoint 4 to 5 writes text alone and names providers" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();
    var root = try std.json.parseFromSliceLeaky(Value, alloc,
        \\{"version":4,
        \\ "conversations":[{"id":1,"agent":{"name":"Fix\u0000","name_len":3,"transcript":"/t.jsonl\u0000","transcript_len":8,
        \\   "turn":"t2\u0000","turn_len":2,"last_finished_turn":"t1\u0000","last_finished_turn_len":2,"recent":"r\u0000","recent_len":1,
        \\   "provider":"claude","session":"s1\u0000","session_len":2,"activity":"Idleing tests","activity_len":4,
        \\   "tool":"Bash\u0000","tool_len":4,"cwd":"/tmp\u0000","cwd_len":4},
        \\  "status_inference":{"recent":[{"bytes":"one\u0000","len":3},{"bytes":"stale","len":0}],"len":1,"previous":{"bytes":"Idle\u0000","len":4}}}],
        \\ "panes":[
        \\  {"id":1,"binding":{"actor":0,"provisional":{"session":[112,49,0],"session_len":2,"cwd":"/p\u0000","cwd_len":2}},
        \\   "label":{"bytes":"api\u0000","len":3},"agent":{"session":"old","session_len":3},
        \\   "resume_hint":{"name":"Fix\u0000","name_len":3,"touched_at":5,"provider":"claude","session":"s1\u0000","len":2}},
        \\  {"id":2,"binding":null,"label":{"bytes":"\u0000","len":0}}],
        \\ "sessions":[
        \\  {"id":1,"resume_hint":{"name":"\u0000","name_len":0,"provider":"codex","session":"n1\u0000","len":2}},
        \\  {"id":2,"binding":{"actor":0,"provisional":{"tool":"Read\u0000","tool_len":4}}}],
        \\ "closed":[{"label":{"bytes":"gone\u0000","len":4},"workspace_id":1}],
        \\ "link_labels":{"entries":[null,{"name":{"bytes":"docs\u0000","len":4},"pending":false}],"generation":0},
        \\ "agent_yolo":[true,false],"agent_hidden":[false,true],
        \\ "agent_commands":[{"bytes":"codex --yolo\u0000","len":12,"original":"cx\u0000","original_len":2,"hidden":true,
        \\  "name":{"bytes":"Fast\u0000","len":4},
        \\  "semantics":{"provider":"codex","suggested_name":{"bytes":"fast\u0000","len":4},"model":{"bytes":"gpt\u0000","len":3},
        \\   "account":{"bytes":"\u0000","len":0},"mode":{"bytes":"Skips permission checks\u0000","len":23},"yolo":true,"default_account":false}}]}
    , .{});
    try checkpoint4To5(alloc, &root);
    try expectJson(
        \\{"version":4,
        \\ "conversations":[{"id":1,"agent":{"name":"Fix","transcript":"/t.jsonl","turn":"t2","last_finished_turn":"t1","recent":"r",
        \\   "provider":"claude","session":"s1","activity":"Idle","tool":"Bash","cwd":"/tmp"},
        \\  "status_inference":{"recent":["one",""],"len":1,"previous":"Idle"}}],
        \\ "panes":[
        \\  {"id":1,"binding":{"actor":0,"provisional":{"session":"p1","cwd":"/p"}},"label":"api",
        \\   "resume_hint":{"name":"Fix","touched_at":5,"provider":"claude","session":"s1"}},
        \\  {"id":2,"binding":null,"label":""}],
        \\ "sessions":[
        \\  {"id":1,"resume_hint":{"name":"","provider":"codex","session":"n1"}},
        \\  {"id":2,"binding":{"actor":0,"provisional":{"tool":"Read"}}}],
        \\ "closed":[{"label":"gone","workspace_id":1}],
        \\ "link_labels":{"entries":[null,{"name":"docs","pending":false}],"generation":0},
        \\ "agent_yolo":{"codex":true,"claude":false},"agent_hidden":{"codex":false,"claude":true},
        \\ "agent_commands":[{"command":"codex --yolo","original":"cx","hidden":true,"name":"Fast",
        \\  "semantics":{"provider":"codex","suggested_name":"fast","model":"gpt","account":"","mode":"Skips permission checks","yolo":true,"default_account":false}}]}
    , root);
}

test "provider arrays hold at most one bool per historical provider" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();
    var short = try std.json.parseFromSliceLeaky(Value, alloc,
        \\{"version":4,"agent_yolo":[true],"agent_hidden":[]}
    , .{});
    try checkpoint4To5(alloc, &short);
    try expectJson(
        \\{"version":4,"agent_yolo":{"codex":true},"agent_hidden":{}}
    , short);
    for ([_][]const u8{
        \\{"agent_yolo":[true,false,true]}
        ,
        \\{"agent_yolo":[1,0]}
        ,
        \\{"agent_yolo":null}
        ,
        \\{"agent_hidden":{"codex":true}}
    }) |json| {
        var bad = try std.json.parseFromSliceLeaky(Value, alloc, json, .{});
        try std.testing.expectError(error.InvalidCheckpoint, checkpoint4To5(alloc, &bad));
    }
}

test "handoff 3 to 4 writes summary and launcher text alone and names providers" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();
    var root = try std.json.parseFromSliceLeaky(Value, alloc,
        \\{"version":3,"runtime":{"version":4,"panes":[{"label":{"bytes":"keep\u0000","len":4}}]},
        \\ "summaries":{"next_request":3,"launches":{"count":{"values":[7,4]},"latest":"claude"},"slots":[
        \\  {"index":0,"slot":{
        \\   "request":{"actor":1,"provider":"codex","session":"s1\u0000","session_len":2,"turn":"t1\u0000","turn_len":2,
        \\    "evidence":{"bytes":"ran tests\u0000","len":9},"panes":[4,0],"panes_len":1,"name":"Fix\u0000","name_len":3,
        \\    "conversation":{"recent":[{"bytes":"one\u0000","len":3},{"bytes":"\u0000","len":0}],"len":1,"previous":{"bytes":"Idle\u0000","len":4}}},
        \\   "commentary":{"bytes":"Looking\u0000","len":7},"tool_evidence":{"bytes":[98,97,115,104,0],"len":4},"retry":false,
        \\   "result":{"request":{"session":"s0\u0000","session_len":2,"turn":"t0\u0000","turn_len":2,"evidence":{"bytes":"\u0000","len":0},
        \\     "name":"\u0000","name_len":0,"conversation":{"recent":[],"len":0,"previous":{"bytes":"x","len":0}}},
        \\    "label":{"bytes":"Testing\u0000","len":7},"number":3}}},
        \\  {"index":1,"slot":{"request":{"session":"s2","session_len":2},"commentary":{"bytes":"","len":0},
        \\   "tool_evidence":{"bytes":"","len":0},"result":{"label":null,"number":0}}},
        \\  {"index":2,"slot":{"commentary":{"bytes":"a","len":1},"result":null}}],
        \\  "link_results":[null,{"slot":0,"name":{"bytes":"docs\u0000","len":4}},{"slot":1,"name":null}]},
        \\ "clients":[
        \\  {"fd":3,"launch_preview":{"cwd":"/tmp\u0000","len":4,"checked":5,"preview":{"pending":false,
        \\   "options":[
        \\    {"signed_in":true,"model":{"bytes":"gpt\u0000","len":3},"source":{"bytes":"config\u0000","len":6},
        \\     "account":{"bytes":"a@b\u0000","len":3},"plan":{"bytes":"pro\u0000","len":3},"limits":{"metered":{}},
        \\     "usage_fetched_at":9,"usage_error":{"bytes":"\u0000","len":0},"usage_needs_consent":false},
        \\    {"signed_in":null,"model":{"bytes":"opus\u0000","len":4},"source":{"bytes":"","len":0},"account":{"bytes":"","len":0},
        \\     "plan":{"bytes":"max\u0000","len":3},"usage_error":{"bytes":"timed out\u0000","len":9}}],
        \\   "installed":[true,false]}}},
        \\  {"fd":4,"launch_preview":null},
        \\  {"fd":5}]}
    , .{});
    try handoff3To4(alloc, &root);
    try expectJson(
        \\{"version":3,"runtime":{"version":4,"panes":[{"label":{"bytes":"keep\u0000","len":4}}]},
        \\ "summaries":{"next_request":3,"launches":{"count":{"codex":7,"claude":4},"latest":"claude"},"slots":[
        \\  {"index":0,"slot":{
        \\   "request":{"actor":1,"provider":"codex","session":"s1","turn":"t1","evidence":"ran tests","panes":[4,0],"panes_len":1,"name":"Fix",
        \\    "conversation":{"recent":["one",""],"len":1,"previous":"Idle"}},
        \\   "commentary":"Looking","tool_evidence":"bash","retry":false,
        \\   "result":{"request":{"session":"s0","turn":"t0","evidence":"","name":"","conversation":{"recent":[],"len":0,"previous":""}},
        \\    "label":"Testing","number":3}}},
        \\  {"index":1,"slot":{"request":{"session":"s2"},"commentary":"","tool_evidence":"","result":{"label":null,"number":0}}},
        \\  {"index":2,"slot":{"commentary":"a","result":null}}],
        \\  "link_results":[null,{"slot":0,"name":"docs"},{"slot":1,"name":null}]},
        \\ "clients":[
        \\  {"fd":3,"launch_preview":{"cwd":"/tmp","checked":5,"preview":{"pending":false,
        \\   "options":{
        \\    "codex":{"signed_in":true,"model":"gpt","source":"config","account":"a@b","plan":"pro","limits":{"metered":{}},
        \\     "usage_fetched_at":9,"usage_error":"","usage_needs_consent":false},
        \\    "claude":{"signed_in":null,"model":"opus","source":"","account":"","plan":"max","usage_error":"timed out"}},
        \\   "installed":{"codex":true,"claude":false}}}},
        \\  {"fd":4,"launch_preview":null},
        \\  {"fd":5}]}
    , root);
    for ([_][]const u8{
        \\{"version":3}
        ,
        \\{"version":3,"summaries":null,"clients":[]}
    }) |json| {
        var empty = try std.json.parseFromSliceLeaky(Value, alloc, json, .{});
        try handoff3To4(alloc, &empty);
        try expectJson(json, empty);
    }
    var three = try std.json.parseFromSliceLeaky(Value, alloc,
        \\{"clients":[{"launch_preview":{"preview":{"options":[{},{},{}]}}}]}
    , .{});
    try std.testing.expectError(error.InvalidCheckpoint, handoff3To4(alloc, &three));
}

test "the V4 fixture migrates to text without padding" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();
    var root = try std.json.parseFromSliceLeaky(Value, alloc, @embedFile("fixtures/checkpoint-v4.json"), .{});
    try checkpoint4To5(alloc, &root);
    const after = try std.json.Stringify.valueAlloc(alloc, root, .{});
    try std.testing.expect(std.mem.indexOf(u8, after, "\\u0000") == null);
    try std.testing.expect(!hasLengthKey(root));
    const state = root.object;
    try std.testing.expectEqualStrings("v3-shared", state.get("conversations").?.array.items[0].object.get("agent").?.object.get("session").?.string);
    for (state.get("panes").?.array.items) |pane| try std.testing.expect(!pane.object.contains("agent"));
    try std.testing.expectEqualStrings("v3-shared", state.get("panes").?.array.items[0].object.get("resume_hint").?.object.get("session").?.string);
}

/// Compares JSON trees, ignoring key order.
fn expectJson(expected: []const u8, actual: Value) !void {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const want = try std.json.parseFromSliceLeaky(Value, arena.allocator(), expected, .{});
    if (sameJson(want, actual)) return;
    std.debug.print("expected {s}\nfound    {s}\n", .{
        try std.json.Stringify.valueAlloc(arena.allocator(), want, .{}),
        try std.json.Stringify.valueAlloc(arena.allocator(), actual, .{}),
    });
    return error.TestExpectedEqual;
}

fn sameJson(a: Value, b: Value) bool {
    if (std.meta.activeTag(a) != std.meta.activeTag(b)) return false;
    return switch (a) {
        .null => true,
        .bool => |x| x == b.bool,
        .integer => |x| x == b.integer,
        .float => |x| x == b.float,
        .number_string => |x| std.mem.eql(u8, x, b.number_string),
        .string => |x| std.mem.eql(u8, x, b.string),
        .array => |x| x.items.len == b.array.items.len and for (x.items, b.array.items) |i, j| {
            if (!sameJson(i, j)) break false;
        } else true,
        .object => |x| x.count() == b.object.count() and for (x.keys(), x.values()) |key, item| {
            if (!sameJson(item, b.object.get(key) orelse break false)) break false;
        } else true,
    };
}

fn hasLengthKey(value: Value) bool {
    return switch (value) {
        .array => |list| for (list.items) |item| {
            if (hasLengthKey(item)) break true;
        } else false,
        .object => |map| for (map.keys(), map.values()) |key, item| {
            if (std.mem.endsWith(u8, key, "_len") or hasLengthKey(item)) break true;
        } else false,
        else => false,
    };
}
