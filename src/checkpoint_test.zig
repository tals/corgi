const std = @import("std");
const Terminal = @import("terminal.zig").Terminal;
const cp = @import("checkpoint.zig");
const a = @import("os.zig").allocator;

test "V2 fixture migrates before typed decoding and restores unchanged terminal data" {
    const migrations = @import("state_migrations.zig");
    const decoded = try migrations.decode(cp.State, .checkpoint, std.testing.allocator, @embedFile("fixtures/checkpoint-v2.json"));
    defer decoded.deinit();
    try std.testing.expect(decoded.migrated);
    try std.testing.expectEqual(migrations.checkpoint_version, decoded.parsed.value.version);
    try std.testing.expectEqual(null, decoded.parsed.value.panes[0].agent.provider);
    try std.testing.expectEqual(null, decoded.parsed.value.panes[0].binding.provisional.provider);
    try std.testing.expectEqual(null, decoded.parsed.value.panes[0].resume_hint.provider);
    var fresh: @import("runtime.zig").Runtime = .{};
    defer fresh.deinit();
    try cp.restore(&fresh, decoded.parsed.value, true, "/tmp/unused-v2.sock", "/tmp/corgi");
    const text = try fresh.panes.items[0].terminal.text();
    defer a.free(text);
    try std.testing.expect(std.mem.indexOf(u8, text, "other") != null);
    try std.testing.expectEqualStrings("other", fresh.workspaces.items.items[0].customName());
    // Re-emitting and reading the current schema requires no migration.
    const json = try std.json.Stringify.valueAlloc(std.testing.allocator, decoded.parsed.value, .{});
    defer std.testing.allocator.free(json);
    const current = try migrations.decode(cp.State, .checkpoint, std.testing.allocator, json);
    defer current.deinit();
    try std.testing.expect(!current.migrated);
}

test "V3 fixture migrates before typed decoding and restores unchanged terminal data" {
    // Captured by a V3 build. Kept unchanged now that V4 exists: it is the
    // old-format input for the V3 -> V4 migration.
    const migrations = @import("state_migrations.zig");
    const decoded = try migrations.decode(cp.State, .checkpoint, std.testing.allocator, @embedFile("fixtures/checkpoint-v3.json"));
    defer decoded.deinit();
    try std.testing.expectEqual(@as(u32, 3), decoded.from);
    try std.testing.expect(decoded.migrated);
    try std.testing.expectEqual(migrations.checkpoint_version, decoded.parsed.value.version);
    var fresh: @import("runtime.zig").Runtime = .{};
    defer fresh.deinit();
    try cp.restore(&fresh, decoded.parsed.value, false, "/tmp/unused-v3.sock", "/tmp/corgi");
    try std.testing.expectEqual(@as(usize, 1), fresh.conversations.items.items.len);
    try std.testing.expectEqualStrings("v3-shared", fresh.panes.items[0].agent().sessionId());
    try std.testing.expect(fresh.panes.items[0].agent().observation.unread());
    try std.testing.expect(fresh.panes.items[1].attachment.actor == null);
    const text = try fresh.panes.items[0].terminal.text();
    defer a.free(text);
    try std.testing.expect(std.mem.indexOf(u8, text, "v3 history") != null);
}

test "V4 fixture is current and restores as saved" {
    // Captured from the migrated V3 fixture (see the generator test below).
    // Keep it unchanged once V5 exists: it becomes the old-format input for
    // the V4 -> V5 migration.
    const migrations = @import("state_migrations.zig");
    const decoded = try migrations.decode(cp.State, .checkpoint, std.testing.allocator, @embedFile("fixtures/checkpoint-v4.json"));
    defer decoded.deinit();
    try std.testing.expectEqual(@as(u32, 4), decoded.from);
    try std.testing.expectEqual(migrations.checkpoint_version != 4, decoded.migrated);
    var fresh: @import("runtime.zig").Runtime = .{};
    defer fresh.deinit();
    try cp.restore(&fresh, decoded.parsed.value, false, "/tmp/unused-v4.sock", "/tmp/corgi");
    try std.testing.expectEqual(@as(usize, 1), fresh.conversations.items.items.len);
    try std.testing.expectEqualStrings("v3-shared", fresh.panes.items[0].agent().sessionId());
    try std.testing.expect(fresh.panes.items[0].agent().observation.unread());
    try std.testing.expect(fresh.panes.items[1].attachment.actor == null);
    const text = try fresh.panes.items[0].terminal.text();
    defer a.free(text);
    try std.testing.expect(std.mem.indexOf(u8, text, "v3 history") != null);
}

test "generate the V4 fixture from the migrated V3 fixture (CORGI_UPDATE_FIXTURE=1 only)" {
    // Not a real checkpoint.capture from a live daemon: the V3 fixture is
    // migrated and restored, then re-captured, which exercises the same
    // capture path a live build would. Run once with CORGI_UPDATE_FIXTURE=1
    // whenever checkpoint-v4.json needs regenerating, then inspect the diff.
    if (!std.process.hasEnvVarConstant("CORGI_UPDATE_FIXTURE")) return error.SkipZigTest;
    const migrations = @import("state_migrations.zig");
    const decoded = try migrations.decode(cp.State, .checkpoint, std.testing.allocator, @embedFile("fixtures/checkpoint-v3.json"));
    defer decoded.deinit();
    var fresh: @import("runtime.zig").Runtime = .{};
    defer fresh.deinit();
    try cp.restore(&fresh, decoded.parsed.value, false, "/tmp/unused-v3-to-v4.sock", "/tmp/corgi");
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const captured = try cp.capture(arena.allocator(), &fresh, false);
    const json = try std.json.Stringify.valueAlloc(arena.allocator(), captured, .{});
    try std.fs.cwd().writeFile(.{ .sub_path = "src/fixtures/checkpoint-v4.json", .data = json });
}

test "saved checkpoint format matches its version" {
    const migrations = @import("state_migrations.zig");
    const name = std.fmt.comptimePrint("fixtures/checkpoint-v{d}.schema", .{migrations.checkpoint_version});
    try migrations.expectSchema(cp.State, &.{}, "src/" ++ name, @embedFile(name));
}

test "sidebar order survives live and recovery checkpoints and defaults for old state" {
    const Runtime = @import("runtime.zig").Runtime;
    const ordering = @import("agent_order.zig");
    var original: Runtime = .{};
    defer original.deinit();
    const id = try original.workspaces.add("ordered", "/tmp");
    const order = [_]ordering.Target{ .{ .native = @enumFromInt(1) }, .{ .pane = @enumFromInt(2) }, .{ .pane = @enumFromInt(1) } };
    // Closed targets may remain in a saved order until the next reordering.
    original.workspaces.get(id).?.agent_order = try ordering.Order.restore(&order);
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    for ([_]bool{ true, false }) |live| {
        const saved = try cp.capture(arena.allocator(), &original, live);
        const json = try std.json.Stringify.valueAlloc(arena.allocator(), saved, .{});
        const decoded = try std.json.parseFromSlice(cp.State, arena.allocator(), json, .{});
        var fresh: Runtime = .{};
        defer fresh.deinit();
        try cp.restore(&fresh, decoded.value, live, "/tmp/unused-agent-order.sock", "/tmp/corgi");
        try std.testing.expectEqualSlices(ordering.Target, &order, fresh.workspaces.get(id).?.agent_order.slice());
    }
    const legacy_json = try std.json.Stringify.valueAlloc(arena.allocator(), .{ .id = id, .name = "legacy", .cwd = "/tmp", .model = @import("layout.zig").Model{} }, .{});
    const legacy = try std.json.parseFromSlice(cp.Workspace, arena.allocator(), legacy_json, .{});
    try std.testing.expectEqual(@as(usize, 0), legacy.value.agent_order.len);
}

test "conversation checkpoint restores shared bindings and detached unread state" {
    const Runtime = @import("runtime.zig").Runtime;
    var original: Runtime = .{};
    defer original.deinit();
    const workspace = try original.workspaces.add("actors", "/tmp");
    const ws = try original.getWorkspace(workspace);
    const shared = try original.conversations.get(.claude, "shared");
    shared.workspace = workspace;
    shared.state.state = .blocked;
    shared.status_inference.remember("prior-turn", "Explaining cursor visibility", @import("activity_summary.zig").Label.parse("Explaining cursor visibility").?);
    shared.state.observation.finish(.completed, .hook);
    const detached = try original.conversations.get(.codex, "detached");
    detached.parent = shared.id;
    detached.state.observation.finish(.interrupted, .protocol);
    for (0..2) |_| {
        const id = try ws.model.newTab("");
        const terminal = try Terminal.create(20, 4);
        terminal.exited = true;
        var binding: @import("conversations.zig").Attachment = .{};
        binding.select(detached);
        binding.select(shared);
        binding.hook_seq = 50;
        try original.panes.append(a, .{ .id = id, .terminal = terminal, .cwd = try a.dupe(u8, "/tmp"), .attachment = binding });
    }
    original.workspaces.next_pane_id = ws.model.next_id;
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const saved = try cp.capture(arena.allocator(), &original, true);
    // Exercise the durable representation, never serialize actor pointers.
    const json = try std.json.Stringify.valueAlloc(arena.allocator(), saved, .{});
    const decoded = try std.json.parseFromSlice(cp.State, arena.allocator(), json, .{});
    var fresh: Runtime = .{};
    defer fresh.deinit();
    try cp.restore(&fresh, decoded.value, true, "/tmp/unused-actor-test.sock", "/tmp/corgi");
    try std.testing.expectEqual(@as(usize, 2), fresh.conversations.items.items.len);
    const actor = fresh.conversations.byId(shared.id).?;
    try std.testing.expectEqualStrings("Explaining cursor visibility", actor.status_inference.previous.text());
    try std.testing.expectEqual(@as(usize, 1), actor.status_inference.len);
    try std.testing.expect(fresh.panes.items[0].attachment.actor == actor);
    try std.testing.expect(fresh.panes.items[1].attachment.actor == actor);
    try std.testing.expect(fresh.panes.items[0].attachment.knows(detached.id));
    try std.testing.expectEqual(@as(i64, 50), fresh.panes.items[0].attachment.hook_seq);
    actor.acknowledge(1, null);
    try std.testing.expect(!fresh.panes.items[1].agent().observation.unread());
    try std.testing.expect(fresh.conversations.byId(detached.id).?.state.observation.unread());
    try std.testing.expectEqual(shared.id, fresh.conversations.byId(detached.id).?.parent.?);
    const next = try fresh.conversations.get(.claude, "next");
    try std.testing.expect(@intFromEnum(next.id) > @intFromEnum(detached.id));

    const cold = try cp.capture(arena.allocator(), &original, false);
    var recovered: Runtime = .{};
    defer recovered.deinit();
    try cp.restore(&recovered, cold, false, "/tmp/unused-cold-test.sock", "/tmp/corgi");
    const historical = recovered.conversations.byId(shared.id).?;
    try std.testing.expectEqual(@import("agents.zig").State.unknown, historical.state.state);
    try std.testing.expectEqual(@as(i64, 0), historical.observed_at);
    try std.testing.expect(historical.state.observation.unread());
}

test "legacy pane checkpoint migrates identity into an actor" {
    const Runtime = @import("runtime.zig").Runtime;
    var original: Runtime = .{};
    defer original.deinit();
    const workspace = try original.workspaces.add("legacy", "/tmp");
    const ws = try original.getWorkspace(workspace);
    const id = try ws.model.newTab("");
    original.workspaces.next_pane_id = ws.model.next_id;
    const terminal = try Terminal.create(20, 4);
    terminal.exited = true;
    var provisional: @import("agents.zig").Agent = .{ .provider = .claude, .state = .idle };
    provisional.session_len = @import("agents.zig").clean(&provisional.session, "legacy-session");
    provisional.observation.finish(.completed, .hook);
    try original.panes.append(a, .{ .id = id, .terminal = terminal, .cwd = try a.dupe(u8, "/tmp"), .attachment = .{ .provisional = provisional } });
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    var saved = try cp.capture(arena.allocator(), &original, true);
    saved.version = 1;
    const original_json = try std.json.Stringify.valueAlloc(arena.allocator(), saved, .{});
    var tree = try std.json.parseFromSlice(std.json.Value, arena.allocator(), original_json, .{});
    defer tree.deinit();
    tree.value.object.getPtr("panes").?.array.items[0].object.getPtr("binding").?.* = .null;
    const json = try std.json.Stringify.valueAlloc(arena.allocator(), tree.value, .{});
    const decoded = try @import("state_migrations.zig").decode(cp.State, .checkpoint, arena.allocator(), json);
    defer decoded.deinit();
    var fresh: Runtime = .{};
    defer fresh.deinit();
    try cp.restore(&fresh, decoded.parsed.value, true, "/tmp/unused-legacy-test.sock", "/tmp/corgi");
    try std.testing.expectEqual(@as(usize, 1), fresh.conversations.items.items.len);
    try std.testing.expectEqualStrings("legacy-session", fresh.panes.items[0].agent().sessionId());
    try std.testing.expect(fresh.panes.items[0].agent().observation.unread());
}

test "live compaction restores its clearing source including older checkpoints" {
    const Runtime = @import("runtime.zig").Runtime;
    const Source = @import("agents.zig").observation.Source;
    const Case = struct { saved: ?bool, source: Source, screen_owned: bool, changed_at: i64 = 0 };
    for ([_]Case{
        .{ .saved = true, .source = .protocol, .screen_owned = true },
        .{ .saved = false, .source = .protocol, .screen_owned = false },
        .{ .saved = null, .source = .protocol, .screen_owned = true },
        .{ .saved = null, .source = .hook, .screen_owned = false },
        .{ .saved = null, .source = .protocol, .screen_owned = false, .changed_at = 100 },
    }) |case| {
        var original: Runtime = .{};
        defer original.deinit();
        _ = try original.workspaces.add("compaction", "/tmp");
        const actor = try original.conversations.get(.codex, "compacting");
        actor.state.state = .working;
        actor.state.compacting = true;
        actor.state.observation.source = case.source;
        actor.state.changed_at = case.changed_at;
        actor.state.setActivity("Reading source");
        actor.screen_compacting = case.screen_owned;
        var arena = std.heap.ArenaAllocator.init(a);
        defer arena.deinit();
        var saved = try cp.capture(arena.allocator(), &original, true);
        try std.testing.expectEqual(case.screen_owned, saved.conversations[0].screen_compacting.?);
        const entries = try arena.allocator().dupe(cp.Conversation, saved.conversations);
        entries[0].screen_compacting = case.saved;
        saved.conversations = entries;
        const json = try std.json.Stringify.valueAlloc(arena.allocator(), saved, .{ .emit_null_optional_fields = false });
        const decoded = try std.json.parseFromSlice(cp.State, arena.allocator(), json, .{});
        var fresh: Runtime = .{};
        defer fresh.deinit();
        try cp.restore(&fresh, decoded.value, true, "/tmp/unused-compaction.sock", "/tmp/corgi");
        const restored_actor = fresh.conversations.byId(actor.id).?;
        try std.testing.expectEqual(case.screen_owned, restored_actor.screen_compacting);
        try std.testing.expectEqualStrings("Compacting context", restored_actor.activity_timeline.points[0].label.text());
        restored_actor.observeCompactionScreen(false, std.time.microTimestamp());
        try std.testing.expectEqual(!case.screen_owned, restored_actor.state.compacting);
        const cold = try cp.capture(arena.allocator(), &original, false);
        try std.testing.expect(!cold.conversations[0].agent.compacting);
    }
}
fn restored(old: *Terminal) !*Terminal {
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    return (try cp.Screen.capture(arena.allocator(), old, true)).restore(true);
}
test "compact checkpoint preserves screens input modes cursor and title without replaying replies" {
    const old = try Terminal.create(40, 6);
    defer old.destroy();
    old.feed("primary history\x1b[?1049h\x1b[2Jalternate\x1b[?2004h\x1b[?1003h\x1b[?1006h\x1b[>3u\x1b]2;agent title\x1b\\\x1b[3;5H");
    const fresh = try restored(old);
    defer fresh.destroy();
    try std.testing.expectEqual(old.vt.screens.active_key, fresh.vt.screens.active_key);
    try std.testing.expect(fresh.vt.modes.get(.bracketed_paste));
    try std.testing.expectEqual(old.vt.flags.mouse_event, fresh.vt.flags.mouse_event);
    try std.testing.expectEqual(old.vt.flags.mouse_format, fresh.vt.flags.mouse_format);
    try std.testing.expectEqual(old.vt.screens.active.kitty_keyboard.current(), fresh.vt.screens.active.kitty_keyboard.current());
    try std.testing.expectEqual(old.vt.screens.active.cursor.x, fresh.vt.screens.active.cursor.x);
    try std.testing.expectEqual(old.vt.screens.active.cursor.y, fresh.vt.screens.active.cursor.y);
    try std.testing.expectEqualStrings("agent title", fresh.vt.getTitle().?);
    try std.testing.expectEqual(@as(usize, 0), fresh.pending.items.len);
    const visible = try fresh.text();
    defer a.free(visible);
    try std.testing.expect(std.mem.indexOf(u8, visible, "alternate") != null);
    fresh.feed("\x1b[?1049l");
    const primary = try fresh.text();
    defer a.free(primary);
    try std.testing.expect(std.mem.indexOf(u8, primary, "primary history") != null);
}
test "redraw cycle changes PTY dimensions only after activation and restores them" {
    const os = @import("os.zig");
    const c = os.c;
    var master: c_int = -1;
    var slave: c_int = -1;
    var ws = std.mem.zeroes(c.struct_winsize);
    ws.ws_col = 40;
    ws.ws_row = 6;
    try std.testing.expectEqual(@as(c_int, 0), c.openpty(&master, &slave, null, null, &ws));
    defer _ = c.close(slave);
    const t = try Terminal.create(40, 6);
    defer t.destroy();
    t.fd = master;
    t.redraw_pending = true;
    _ = c.ioctl(slave, c.TIOCGWINSZ, &ws);
    try std.testing.expectEqual(@as(u16, 40), ws.ws_col);
    t.refreshRedraw(1000);
    _ = c.ioctl(slave, c.TIOCGWINSZ, &ws);
    try std.testing.expectEqual(@as(u16, 39), ws.ws_col);
    t.refreshRedraw(1100);
    try std.testing.expect(t.redraw_restore_at != null);
    t.refreshRedraw(1250);
    _ = c.ioctl(slave, c.TIOCGWINSZ, &ws);
    try std.testing.expectEqual(@as(u16, 40), ws.ws_col);
    try std.testing.expect(t.redraw_restore_at == null);
}
test "resume command quotes session text as one shell argument" {
    var hint: cp.Resume = .{ .provider = .codex };
    hint.len = @import("agents.zig").clean(&hint.session, "session'with quote");
    const command = try hint.command(a);
    defer a.free(command);
    try std.testing.expectEqualStrings("codex resume 'session'\\''with quote'", command);
}

test "live checkpoint size depends on retained state not output volume" {
    const old = try Terminal.create(40, 6);
    defer old.destroy();
    old.feed("retained content");
    const first = try cp.Screen.capture(a, old, true);
    defer a.free(first.data);
    const noise = [_]u8{'\r'} ** 4096;
    for (0..256) |_| old.feed(&noise);
    const compact = try cp.Screen.capture(a, old, true);
    defer a.free(compact.data);
    try std.testing.expect(compact.data.len < first.data.len + 128);
    const fresh = try compact.restore(true);
    defer fresh.destroy();
    const text = try fresh.text();
    defer a.free(text);
    try std.testing.expect(std.mem.indexOf(u8, text, "retained content") != null);
}

test "recovery metadata survives observation and clears on session switch" {
    var agent: @import("agents.zig").Agent = .{ .provider = .codex, .updated_at = 1000 };
    agent.session_len = @import("agents.zig").clean(&agent.session, "first");
    agent.setName("A session\nwith controls\x1b");
    var hint: cp.Resume = .{};
    hint.observe(&agent);
    const banner = try hint.banner(a, 1120);
    defer a.free(banner);
    try std.testing.expect(std.mem.indexOf(u8, banner, "# A session with controls ") != null);
    try std.testing.expect(std.mem.indexOf(u8, banner, "# Last active 2 minutes ago") != null);
    agent.session_len = @import("agents.zig").clean(&agent.session, "second");
    agent.name_len = 0;
    agent.updated_at = 0;
    hint.observe(&agent);
    try std.testing.expectEqual(@as(usize, 0), hint.name_len);
    try std.testing.expectEqual(@as(i64, 0), hint.touched_at);
}
test "recovery never prefills selection or control characters" {
    var hint: cp.Resume = .{ .provider = .codex };
    const missing = try hint.command(a);
    defer a.free(missing);
    try std.testing.expectEqualStrings("", missing);
    @memcpy(hint.session[0..4], "a\nbc");
    hint.len = 4;
    const unsafe = try hint.command(a);
    defer a.free(unsafe);
    try std.testing.expectEqualStrings("", unsafe);
}

test "link cache and spent inference attempts survive live checkpoints only" {
    const Runtime = @import("runtime.zig").Runtime;
    const links = @import("link_labels.zig");
    var original: Runtime = .{};
    defer original.deinit();
    _ = try original.workspaces.add("links", "/tmp");
    original.link_labels.generation = 3;
    for (0..3) |i| original.link_labels.entries[i] = .{
        .key = .{ .workspace = @enumFromInt(1), .pane = @enumFromInt(1), .pid = 7, .port = @intCast(3000 + i), .scheme = .http, .address = 9 },
        .generation = i + 1,
        .attempted = true,
        .pending = i == 1,
        .name = if (i == 0) links.Name.parse("Finance").? else .{},
    };
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    for ([_]bool{ true, false }) |live| {
        const saved = try cp.capture(arena.allocator(), &original, live);
        const json = try std.json.Stringify.valueAlloc(arena.allocator(), saved, .{});
        const parsed = try std.json.parseFromSlice(cp.State, arena.allocator(), json, .{});
        var fresh: Runtime = .{};
        defer fresh.deinit();
        try cp.restore(&fresh, parsed.value, live, "/tmp/unused-link-test.sock", "/tmp/corgi");
        if (live) {
            try std.testing.expectEqualStrings("Finance", fresh.link_labels.entries[0].?.name.text());
            try std.testing.expect(fresh.link_labels.entries[1].?.pending);
            try std.testing.expect(fresh.link_labels.entries[2].?.attempted);
            try std.testing.expectEqual(@as(u64, 3), fresh.link_labels.generation);
        } else {
            try std.testing.expect(fresh.link_labels.entries[0] == null);
            try std.testing.expectEqual(@as(u64, 0), fresh.link_labels.generation);
        }
    }
    var invalid = original.link_labels;
    invalid.entries[0].?.name.len = 33;
    try std.testing.expectError(error.InvalidCheckpoint, links.Cache.restore(invalid));
    invalid = original.link_labels;
    invalid.entries[0].?.generation = 4;
    try std.testing.expectError(error.InvalidCheckpoint, links.Cache.restore(invalid));
}
