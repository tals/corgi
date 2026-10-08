//! `corgi-hook hook <provider>`: forwards a provider hook event to the
//! daemon as one HTTP POST over its Unix socket. Claude Code and Codex wait
//! for hooks around every tool call, so this stays a small native program
//! instead of starting the Bun application. It decides what `corgi hook`
//! decides (integration.zig) and always exits 0: a hook must never fail
//! the agent.
const std = @import("std");
const deps = @import("hook_deps");
const os = deps.os;
const detection = deps.detection;
const c = os.c;
const a = os.allocator;

const Provider = enum { claude, codex };

pub fn main(init: std.process.Init) void {
    os.initIo(init.minimal);
    run(init) catch {};
}

fn run(init: std.process.Init) !void {
    const args = try init.minimal.args.toSlice(a);
    if (args.len != 3 or !std.mem.eql(u8, args[1], "hook")) return;
    const provider = std.meta.stringToEnum(Provider, args[2]) orelse return;
    const pane = std.fmt.parseInt(u32, os.env("CORGI_PANE") orelse return, 10) catch return;
    const socket = os.env("CORGI_SOCKET") orelse return;

    var input: std.ArrayList(u8) = .empty;
    var buf: [8192]u8 = undefined;
    while (input.items.len < 1024 * 1024) {
        const n = c.read(0, &buf, buf.len);
        if (n <= 0) break;
        try input.appendSlice(a, buf[0..@intCast(n)]);
    }
    const parsed = std.json.parseFromSlice(std.json.Value, a, input.items, .{}) catch return;
    switch (provider) {
        // Codex tools/subagents inherit the pane environment. Their sessions
        // must not take ownership of the parent terminal's sidebar entry.
        .codex => if (os.env("CODEX_THREAD_ID")) |parent| {
            const session = switch (parsed.value) {
                .object => |o| if (o.get("session_id")) |v| switch (v) {
                    .string => |s| s,
                    else => "",
                } else "",
                else => "",
            };
            if (parent.len > 0 and !std.mem.eql(u8, parent, session)) return;
        },
        .claude => {},
    }
    // Claude's background daemon inherits the environment of whichever pane
    // first spawned it, and so does a `claude -p` an agent runs from a tool.
    const origin: detection.HookOrigin = switch (provider) {
        .claude => detection.hookOrigin(),
        .codex => .{},
    };
    const background = switch (provider) {
        .claude => std.mem.eql(u8, os.env("CLAUDE_CODE_SESSION_KIND") orelse "", "bg") or origin.background,
        .codex => false,
    };
    const body = try std.json.Stringify.valueAlloc(a, .{
        .op = "hook",
        .protocol = 1,
        .provider = @tagName(provider),
        .event = parsed.value,
        .pane = pane,
        .seq = os.microTimestamp(),
        .background = background,
        .pid = origin.pid,
    }, .{});

    const fd = os.connect(socket) catch return;
    defer _ = c.close(fd);
    // The daemon answers after it has applied the event; a slow one must
    // not hold up the agent.
    const timeout: c.struct_timeval = .{ .tv_sec = 2, .tv_usec = 0 };
    _ = c.setsockopt(fd, c.SOL_SOCKET, c.SO_RCVTIMEO, &timeout, @sizeOf(@TypeOf(timeout)));
    const head = try std.fmt.allocPrint(a, "POST /rpc HTTP/1.1\r\nHost: corgi\r\nContent-Type: application/json\r\nContent-Length: {d}\r\nConnection: close\r\n\r\n", .{body.len});
    try writeAll(fd, head);
    try writeAll(fd, body);
    // Wait for the reply, so the daemon has the event before the agent goes on.
    while (c.read(fd, &buf, buf.len) > 0) {}
}

fn writeAll(fd: c_int, bytes: []const u8) !void {
    var rest = bytes;
    while (rest.len > 0) {
        const n = c.write(fd, rest.ptr, rest.len);
        if (n < 0) {
            if (std.posix.errno(n) == .INTR) continue;
            return error.WriteFailed;
        }
        rest = rest[@intCast(n)..];
    }
}
