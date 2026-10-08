//! Renames a conversation in its agent's own records, so the agent's title
//! and resume list show the name Corgi shows. A live Claude session renames
//! itself when its messaging socket asks, as Claude's agent view does. Codex
//! renames a thread its shared daemon runs over the daemon socket. A Codex
//! that runs without the daemon only hears `/rename` typed into it, and Corgi
//! types it only into an input box that is visibly empty.
const std = @import("std");
const os = @import("os.zig");
const json = @import("json.zig");
const keys = @import("keys.zig");
const terminal = @import("pane.zig").terminal;
const Terminal = terminal.Terminal;
const Client = @import("codex_socket.zig").Client;
const BoundedText = @import("bounded_text.zig").BoundedText;
const Claude = @import("providers/claude.zig").Claude;
const Codex = @import("providers/codex.zig").Codex;
const a = os.allocator;
const c = os.c;

pub const max_name = 80;
pub const Name = BoundedText(max_name);

/// A name the agents take: one line of printable UTF-8, at most `max_name` bytes.
pub fn validName(name: []const u8) bool {
    if (name.len == 0 or name.len > max_name or !std.unicode.utf8ValidateSlice(name)) return false;
    for (name) |ch| if (ch < 32 or ch == 127) return false;
    return true;
}

/// A live Claude session's messaging socket and the token its peers send.
pub const Peer = struct {
    socket: []u8,
    token: []u8,
    pub fn deinit(p: Peer) void {
        a.free(p.socket);
        a.free(p.token);
    }
};

/// The messaging socket of the live process that runs `session`, from the
/// records Claude keeps in `<config>/sessions`.
pub fn claudePeer(session: []const u8) ?Peer {
    const config = Claude.info.configDir(a) catch return null;
    defer a.free(config);
    const dir = std.fs.path.join(a, &.{ config, "sessions" }) catch return null;
    defer a.free(dir);
    return peerIn(dir, session);
}

fn peerIn(path: []const u8, session: []const u8) ?Peer {
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
        if (!std.ascii.eqlIgnoreCase(record.sessionId, session) or record.peerProtocol != 1 or record.messagingSocketPath.len == 0) continue;
        // A process that exited without removing its record no longer listens.
        if (record.pid <= 1 or c.kill(record.pid, 0) != 0) continue;
        const token = peerToken(dir, record.pid, record.messagingSocketPath) orelse continue;
        const socket = a.dupe(u8, record.messagingSocketPath) catch {
            a.free(token);
            continue;
        };
        return .{ .socket = socket, .token = token };
    }
    return null;
}

/// The token in `<pid>.<sha256 of the socket path>.key`, which only its
/// owner can read.
fn peerToken(dir: std.Io.Dir, pid: c_int, socket: []const u8) ?[]u8 {
    var digest: [std.crypto.hash.sha2.Sha256.digest_length]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(socket, &digest, .{});
    var name: [96]u8 = undefined;
    const hex = std.fmt.bytesToHex(digest, .lower);
    const file = std.fmt.bufPrint(&name, "{d}.{s}.key", .{ pid, &hex }) catch return null;
    const bytes = dir.readFileAlloc(os.io(), file, a, .limited(4096)) catch return null;
    defer a.free(bytes);
    const parsed = std.json.parseFromSlice(struct { peerToken: []const u8 = "" }, a, bytes, .{ .ignore_unknown_fields = true }) catch return null;
    defer parsed.deinit();
    if (parsed.value.peerToken.len == 0) return null;
    return a.dupe(u8, parsed.value.peerToken) catch null;
}

/// Asks the session to rename itself with the message Claude's agent view
/// sends. Nothing comes back; the session's transcript records the name.
pub fn renameClaude(peer: Peer, session: []const u8, name: []const u8) !void {
    const msg_id = os.uuid();
    const from = try std.fmt.allocPrint(a, "uds:{s}", .{peer.socket});
    defer a.free(from);
    const auth = try std.json.Stringify.valueAlloc(a, .{ .type = "auth", .token = peer.token }, .{});
    defer a.free(auth);
    const control = try std.json.Stringify.valueAlloc(a, .{ .type = "control", .action = "rename", .name = name, .session_id = session, .from = from, .msg_id = @as([]const u8, &msg_id) }, .{});
    defer a.free(control);
    const fd = try os.connect(peer.socket);
    defer _ = c.close(fd);
    try os.writeAll(fd, auth);
    try os.writeAll(fd, "\n");
    try os.writeAll(fd, control);
    try os.writeAll(fd, "\n");
}

/// Names thread `id` in Codex's shared daemon, which tells every Codex
/// attached to it.
pub fn renameCodex(id: []const u8, name: []const u8) !void {
    const root = try Codex.info.configDir(a);
    defer a.free(root);
    const path = try std.fs.path.join(a, &.{ root, "app-server-control/app-server-control.sock" });
    defer a.free(path);
    var client = try Client.open(path);
    defer client.close();
    const reply = try client.call("thread/name/set", .{ .threadId = id, .name = name });
    reply.deinit();
}

/// The `/rename` command for `name`, as typed into Codex.
pub fn command(buf: []u8, name: []const u8) ![]const u8 {
    return std.fmt.bufPrint(buf, "/rename {s}", .{name});
}
/// Whether Codex's screen shows its input box empty and nothing over it.
/// Codex marks its live input row with a bold `›` and fills an empty one
/// with a dim placeholder; its footer then reads "? for shortcuts". A draft,
/// a menu, a search, an approval or a screen this doesn't recognize all read
/// as not empty.
pub fn codexEmpty(t: *Terminal) bool {
    const input = codexInput(t) orelse return false;
    if (input.cursor != 2 or !input.placeholder) return false;
    for (input.below) |row| if (std.mem.indexOf(u8, row.text(), "? for shortcuts") != null) return true;
    return false;
}
/// Whether Codex's input row holds exactly `text`, with the cursor after it.
pub fn codexHolds(t: *Terminal, text: []const u8) bool {
    const input = codexInput(t) orelse return false;
    return !input.placeholder and input.cursor == input.text_end and std.mem.eql(u8, input.text.text(), text);
}

const Row = BoundedText(512);
const Input = struct {
    /// The row after the `› ` marker, without trailing blanks, and where it ends.
    text: Row = .{},
    text_end: usize = 2,
    /// Whether every visible character after the marker is dim.
    placeholder: bool = false,
    cursor: usize,
    /// The rows under it, where the footer sits.
    below: [3]Row = @splat(.{}),
};
/// The row the cursor sits on, when it is Codex's live input row and no
/// approval is pending.
fn codexInput(t: *Terminal) ?Input {
    if (std.mem.indexOf(u8, t.vt.getTitle() orelse "", Codex.info.screen.blocked_title.?) != null) return null;
    t.updateRender() catch return null;
    const cursor = t.render.cursor;
    const at = cursor.viewport orelse return null;
    if (!cursor.visible) return null;
    const rows = t.render.row_data.items(.cells);
    if (at.y >= rows.len) return null;
    const cells = rows[at.y];
    const raw = cells.items(.raw);
    const styles = cells.items(.style);
    if (raw.len < 3 or raw[0].codepoint() != 0x203a or raw[1].codepoint() != ' ') return null;
    // Past user messages carry a dim `›`, and menu highlights an inverse one.
    const marker = if (raw[0].style_id != 0) styles[0] else return null;
    if (!marker.flags.bold or marker.flags.faint or marker.flags.inverse) return null;
    var input: Input = .{ .cursor = at.x };
    var dim = false;
    var plain = false;
    for (raw[2..], 2..) |cell, x| {
        const cp = cell.codepoint();
        if (cp == 0 or cp == ' ') continue;
        if (cell.style_id != 0 and styles[x].flags.faint) dim = true else plain = true;
        input.text_end = x + 1;
    }
    input.placeholder = dim and !plain;
    rowText(&input.text, raw[2..input.text_end]);
    for (&input.below, 1..) |*row, offset| {
        if (at.y + offset >= rows.len) break;
        rowText(row, rows[at.y + offset].items(.raw));
    }
    return input;
}
fn rowText(out: *Row, cells: []const terminal.vt.Cell) void {
    var buf: [Row.capacity]u8 = undefined;
    var len: usize = 0;
    for (cells) |cell| {
        if (cell.wide == .spacer_tail or cell.wide == .spacer_head) continue;
        const cp = cell.codepoint();
        var encoded: [4]u8 = undefined;
        const n = std.unicode.utf8Encode(if (cp == 0) ' ' else cp, &encoded) catch continue;
        if (len + n > buf.len) break;
        @memcpy(buf[len..][0..n], encoded[0..n]);
        len += n;
    }
    out.* = .initTruncated(buf[0..len]);
}

/// Types `text` into an agent the way a paste arrives.
pub fn paste(t: *Terminal, text: []const u8) !void {
    var output: std.Io.Writer.Allocating = .init(a);
    defer output.deinit();
    const bracketed = t.vt.modes.get(.bracketed_paste);
    if (bracketed) try output.writer.writeAll("\x1b[200~");
    try output.writer.writeAll(text);
    if (bracketed) try output.writer.writeAll("\x1b[201~");
    try t.send(output.written());
}
/// Presses Enter in the encoding the agent asked for.
pub fn submit(t: *Terminal) !void {
    var output: std.Io.Writer.Allocating = .init(a);
    defer output.deinit();
    try (try keys.logicalKey("enter")).encode(&output.writer, terminal.vt.input.KeyEncodeOptions.fromTerminal(&t.vt));
    try t.send(output.written());
}

test "names are one printable line" {
    try std.testing.expect(validName("refactor ⑂"));
    try std.testing.expect(!validName(""));
    try std.testing.expect(!validName("two\nlines"));
    try std.testing.expect(!validName("bell\x07"));
    try std.testing.expect(!validName("\xff"));
    try std.testing.expect(!validName("x" ** (max_name + 1)));
}

test "a session's peer is its live record's socket and key" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const self = c.getpid();
    var buf: [512]u8 = undefined;
    const socket = "/tmp/cc-socks/1.sock";
    try tmp.dir.writeFile(os.io(), .{ .sub_path = "1.json", .data = try std.fmt.bufPrint(&buf, "{{\"pid\":{d},\"sessionId\":\"live\",\"peerProtocol\":1,\"messagingSocketPath\":\"{s}\"}}", .{ self, socket }) });
    try tmp.dir.writeFile(os.io(), .{ .sub_path = "2.json", .data = try std.fmt.bufPrint(&buf, "{{\"pid\":{d},\"sessionId\":\"future\",\"peerProtocol\":2,\"messagingSocketPath\":\"{s}\"}}", .{ self, socket }) });
    try tmp.dir.writeFile(os.io(), .{ .sub_path = "3.json", .data = try std.fmt.bufPrint(&buf, "{{\"pid\":{d},\"sessionId\":\"gone\",\"peerProtocol\":1,\"messagingSocketPath\":\"{s}\"}}", .{ std.math.maxInt(c_int), socket }) });
    try tmp.dir.writeFile(os.io(), .{ .sub_path = "4.json", .data = try std.fmt.bufPrint(&buf, "{{\"pid\":{d},\"sessionId\":\"keyless\",\"peerProtocol\":1,\"messagingSocketPath\":\"/tmp/cc-socks/4.sock\"}}", .{self}) });
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(socket, &digest, .{});
    const hex = std.fmt.bytesToHex(digest, .lower);
    const key = try std.fmt.bufPrint(&buf, "{d}.{s}.key", .{ self, &hex });
    try tmp.dir.writeFile(os.io(), .{ .sub_path = key, .data = "{\"peerToken\":\"secret\"}" });
    const root = try os.realpathAlloc(std.testing.allocator, tmp.dir, ".");
    defer std.testing.allocator.free(root);

    const peer = peerIn(root, "LIVE").?;
    defer peer.deinit();
    try std.testing.expectEqualStrings(socket, peer.socket);
    try std.testing.expectEqualStrings("secret", peer.token);
    for ([_][]const u8{ "future", "gone", "keyless", "missing" }) |session| try std.testing.expectEqual(null, peerIn(root, session));
}

/// A Codex screen: history, the input row, a status line and a footer.
fn codexScreen(t: *Terminal, input: []const u8, footer: []const u8) void {
    t.feed("\x1b[2J\x1b[H\x1b[1;2m› \x1b[0mearlier prompt\r\n\r\n");
    t.feed(input);
    t.feed("\r\n  gpt · /tmp\r\n  ");
    t.feed(footer);
    t.feed("\x1b[3;3H");
}

test "only Codex's empty input box reads as empty" {
    const t = try Terminal.create(60, 8);
    defer t.destroy();
    codexScreen(t, "\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m", "\x1b[1m?\x1b[0m for shortcuts");
    try std.testing.expect(codexEmpty(t));
    try std.testing.expect(!codexHolds(t, "Ask Codex to do anything"));

    // A draft, even one that reads like the placeholder.
    codexScreen(t, "\x1b[1m›\x1b[0m Ask Codex to do anything", "");
    try std.testing.expect(!codexEmpty(t));
    // The shortcuts overlay keeps the empty row but changes the footer.
    codexScreen(t, "\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m", "\x1b[1m?\x1b[0m / \x1b[1mesc\x1b[0m close");
    try std.testing.expect(!codexEmpty(t));
    // A menu row's inverse marker, and a past prompt's dim one.
    codexScreen(t, "\x1b[1;7m› 1. Yes, proceed (y)\x1b[0m", "\x1b[1m?\x1b[0m for shortcuts");
    try std.testing.expect(!codexEmpty(t));
    codexScreen(t, "\x1b[1;2m› \x1b[0m\x1b[2mAsk Codex to do anything\x1b[0m", "\x1b[1m?\x1b[0m for shortcuts");
    try std.testing.expect(!codexEmpty(t));
    // Reverse search keeps the cursor on its own row.
    codexScreen(t, "\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m", "\x1b[2mreverse-i-search: \x1b[0m");
    t.feed("\x1b[5;21H");
    try std.testing.expect(!codexEmpty(t));
    // An approval names itself in the title.
    codexScreen(t, "\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m", "\x1b[1m?\x1b[0m for shortcuts");
    t.feed("\x1b]0;[ ! ] Action Required | codex\x07");
    try std.testing.expect(!codexEmpty(t));
}

test "Codex's input row holds the typed command, cursor after it" {
    const t = try Terminal.create(60, 8);
    defer t.destroy();
    var buf: [128]u8 = undefined;
    const typed = try command(&buf, "corgi ⑂");
    codexScreen(t, "\x1b[1m›\x1b[0m \x1b[36m/rename\x1b[0m corgi ⑂", "");
    t.feed("\x1b[3;18H");
    try std.testing.expect(codexHolds(t, typed));
    try std.testing.expect(!codexHolds(t, "/rename corgi"));
    t.feed("\x1b[3;5H");
    try std.testing.expect(!codexHolds(t, typed));
}
