//! The viewer's side of the host terminal's clipboard protocol (Kitty's
//! OSC 5522). Over SSH the clipboard is on another machine, where a program
//! in a pane can't read a copied image. With paste events (mode 5522) on, a
//! paste arrives as the clipboard's types and a one-time password. The viewer
//! reads text and pastes it as before, or reads an image, saves it beside the
//! daemon's socket and pastes the copy's path, which Claude Code and Codex
//! attach.
const std = @import("std");
const os = @import("os.zig");
const a = os.allocator;
const BoundedText = @import("bounded_text.zig").BoundedText;

const base64 = std.base64.standard;

/// Whether a paste can bring an image from the host's clipboard.
pub const Support = enum {
    /// A local viewer: programs in panes read the clipboard themselves.
    local,
    /// The host terminal hasn't answered yet.
    probing,
    on,
    /// The host can't send paste events.
    unsupported,
    /// The host refuses clipboard reads (`clipboard-read = deny`).
    denied,
};

/// Why a paste brought nothing.
pub const Failure = enum {
    denied,
    host_error,
    timed_out,
    too_large,
    not_image,
    save_failed,
    busy,
    not_pane,
    unsupported_image,

    pub fn message(f: Failure) []const u8 {
        return switch (f) {
            .denied => "The terminal refused to send the clipboard",
            .host_error => "The terminal couldn't send the clipboard",
            .timed_out => "The terminal stopped sending the clipboard",
            .too_large => "Images over 32 MB don't paste",
            .not_image => "The clipboard image was damaged",
            .save_failed => "Couldn't save the pasted image",
            .busy => "Still pasting the previous image",
            .not_pane => "Images paste into a pane",
            .unsupported_image => "Corgi pastes PNG, JPEG, GIF and WebP images",
        };
    }
};

/// What a paste brought, owned by the caller.
pub const Result = union(enum) {
    text: []u8,
    /// An image saved on this machine: paste its path.
    path: []u8,
    /// What a program that takes paste events is offered.
    relay: Relay,
    failed: Failure,

    pub fn deinit(r: Result) void {
        switch (r) {
            .text, .path => |bytes| a.free(bytes),
            .relay => |relay| {
                if (relay.text) |bytes| a.free(bytes);
                if (relay.image) |image| a.free(image.path);
            },
            .failed => {},
        }
    }
};

/// The clipboard's text, unless it is too long to send the daemon in one
/// request, and its image, saved on this machine.
pub const Relay = struct {
    text: ?[]u8 = null,
    image: ?struct { mime: []const u8, path: []u8 } = null,
};

/// The types a program that takes paste events is offered: the text and the
/// preferred image, read together with the paste's password.
pub fn relayTypes(listing: []const u8, buf: *[2][]const u8) []const []const u8 {
    var n: usize = 0;
    if (lists(listing, "text/plain")) {
        buf[n] = "text/plain";
        n += 1;
    }
    for (images) |image| if (lists(listing, image.mime)) {
        buf[n] = image.mime;
        n += 1;
        break;
    };
    return buf[0..n];
}

/// What to read for a paste that lists `listing`.
pub const Choice = union(enum) {
    read: []const u8,
    refuse: Failure,
    nothing,
};

/// Text wins, as it does for a plain paste; an image goes only into a pane.
pub fn choose(listing: []const u8, pane: bool) Choice {
    if (lists(listing, "text/plain")) return .{ .read = "text/plain" };
    for (images) |image| if (lists(listing, image.mime)) {
        return if (pane) .{ .read = image.mime } else .{ .refuse = .not_pane };
    };
    var types = std.mem.tokenizeAny(u8, listing, &std.ascii.whitespace);
    while (types.next()) |mime| if (std.mem.startsWith(u8, mime, "image/")) return .{ .refuse = .unsupported_image };
    return .nothing;
}

fn lists(listing: []const u8, mime: []const u8) bool {
    var types = std.mem.tokenizeAny(u8, listing, &std.ascii.whitespace);
    while (types.next()) |listed| if (std.mem.eql(u8, listed, mime)) return true;
    return false;
}

const Image = struct {
    mime: []const u8,
    extension: []const u8,
    magic: []const u8,

    fn matches(image: Image, data: []const u8) bool {
        if (!std.mem.startsWith(u8, data, image.magic)) return false;
        // WebP is a RIFF container; its kind follows the length.
        return !std.mem.eql(u8, image.extension, "webp") or (data.len >= 12 and std.mem.eql(u8, data[8..12], "WEBP"));
    }
};

/// The image types Claude Code and Codex attach, in order of preference.
const images = [_]Image{
    .{ .mime = "image/png", .extension = "png", .magic = "\x89PNG\r\n\x1a\n" },
    .{ .mime = "image/jpeg", .extension = "jpg", .magic = "\xff\xd8\xff" },
    .{ .mime = "image/gif", .extension = "gif", .magic = "GIF8" },
    .{ .mime = "image/webp", .extension = "webp", .magic = "RIFF" },
};

/// A key that may mean the user tried to paste an image.
pub const Key = enum {
    /// Cmd+V reached the viewer as a key: Ghostty on macOS had no text to paste.
    cmd,
    /// Ctrl+Shift+V reached the viewer as a key: Ghostty on Linux had none.
    ctrl_shift,
    /// Ctrl+V went to an agent, which reads its own machine's clipboard.
    ctrl,
};

/// The card that says why a paste brought no image and what fixes it.
pub const Notice = struct {
    body: BoundedText(96) = .{},
    /// The fix: text, a link to Ghostty's nightly builds, and a key.
    parts: [5]Part = undefined,
    count: usize = 0,

    pub const Part = struct { kind: Kind, text: BoundedText(64) };
    pub const Kind = enum { text, link, key };

    pub fn fix(n: *const Notice) []const Part {
        return n.parts[0..n.count];
    }
    fn add(n: *Notice, kind: Kind, text: []const u8) void {
        n.parts[n.count] = .{ .kind = kind, .text = .initTruncated(text) };
        n.count += 1;
    }
    /// "<lead> to enable paste with <key>."
    fn enable(n: *Notice, lead: []const u8, paste_key: []const u8) void {
        var buf: [64]u8 = undefined;
        n.add(.text, std.fmt.bufPrint(&buf, "{s} to enable paste with ", .{lead}) catch lead);
        n.add(.key, paste_key);
        n.add(.text, ".");
    }
};

/// Ghostty's nightly release, which always holds the newest build.
pub const nightly_url = "https://github.com/ghostty-org/ghostty/releases/tag/tip";
const max_bytes = 32 * 1024 * 1024;
/// Relayed text goes to the daemon inline, within its request limit.
const max_relayed_text = 512 * 1024;
/// How long the host has to answer a question, and how long a read may
/// pause between chunks.
const answer_ms = 3000;
const stall_ms = 10_000;
/// Pasted images are removed a day after they were last pasted.
const keep_ms = 24 * 60 * 60 * 1000;

const query_mode = "\x1b[?5522$p";
const query_version = "\x1b[>0q";
pub const enable = "\x1b[?5522h";
/// Lists the clipboard's types, which never prompts, to learn whether the
/// host refuses reads before turning paste events on.
const probe_id = "corgi-probe";
const list_probe = "\x1b]5522;type=read:id=" ++ probe_id ++ ";Lg==\x1b\\";
const read_id = "corgi";
/// The host honours a paste's password only from a named program.
const corgi_name = "Q29yZ2k=";

const Status = enum { DATA, DONE, EBUSY, EFBIG, EINVAL, EIO, ENOSYS, EPERM, OK };

/// One read response or paste event, its metadata still encoded.
const Packet = struct {
    status: Status,
    id: []const u8 = "",
    mime: []const u8 = "",
    pw: []const u8 = "",
    payload: []const u8 = "",

    const Field = enum { type, status, id, mime, pw };

    fn parse(raw: []const u8) ?Packet {
        const split = std.mem.indexOfScalar(u8, raw, ';');
        var packet: Packet = .{ .status = .OK };
        var read = false;
        var status: ?Status = null;
        var fields = std.mem.splitScalar(u8, raw[0 .. split orelse raw.len], ':');
        while (fields.next()) |field| {
            const eq = std.mem.indexOfScalar(u8, field, '=') orelse return null;
            const value = field[eq + 1 ..];
            switch (std.meta.stringToEnum(Field, field[0..eq]) orelse continue) {
                .type => read = std.mem.eql(u8, value, "read"),
                .status => status = std.meta.stringToEnum(Status, value),
                .id => packet.id = value,
                .mime => packet.mime = value,
                .pw => packet.pw = value,
            }
        }
        if (!read) return null;
        packet.status = status orelse return null;
        if (split) |i| packet.payload = raw[i + 1 ..];
        return packet;
    }

    /// Whether the base64 MIME type is `mime`.
    fn names(packet: Packet, mime: []const u8) bool {
        var buf: [256]u8 = undefined;
        const size = base64.Decoder.calcSizeForSlice(packet.mime) catch return false;
        if (size != mime.len) return false;
        base64.Decoder.decode(buf[0..size], packet.mime) catch return false;
        return std.mem.eql(u8, buf[0..size], mime);
    }
};

/// Asking the host about paste events, the paste in progress, and what it
/// brought. `host_probe` feeds it the host's replies; the viewer writes `out`.
pub const State = struct {
    support: Support = .local,
    /// The host terminal as it names itself (XTVERSION), for messages.
    terminal: BoundedText(64) = .{},
    /// The terminal's OS, once a paste key that only one OS uses arrives.
    os: enum { unknown, macos, linux } = .unknown,
    /// A private directory beside the socket, for pasted images.
    folder: []const u8 = "",
    /// Bytes for the host terminal.
    out: std.ArrayList(u8) = .empty,
    asking: enum { none, mode, list } = .none,
    answer_by: i64 = 0,
    event: Event = .{},
    reading: ?Reading = null,
    stall_by: i64 = 0,
    result: ?Result = null,

    const Event = struct {
        phase: enum { none, receiving, ready } = .none,
        /// The one-time password, base64 as the host sent it.
        pw: BoundedText(256) = .{},
        listing: BoundedText(4096) = .{},
    };
    const Reading = struct {
        /// One type, or the text and image a relay offers.
        mimes: [2][]const u8 = undefined,
        data: [2]std.ArrayList(u8) = .{ .empty, .empty },
        count: usize,
        relay: bool,
        too_large: bool = false,

        fn deinit(reading: *Reading) void {
            for (&reading.data) |*data| data.deinit(a);
        }
    };

    pub fn deinit(s: *State) void {
        s.out.deinit(a);
        if (s.reading) |*reading| reading.deinit();
        if (s.result) |result| result.deinit();
    }

    /// Asks the host whether it supports paste events and what it is.
    pub fn start(s: *State, now: i64) !void {
        s.support = .probing;
        s.asking = .mode;
        s.answer_by = now + answer_ms;
        try s.out.appendSlice(a, query_mode ++ query_version);
    }

    /// The host's DECRQM answer for mode 5522: 1 set, 2 reset, else unknown.
    pub fn modeReport(s: *State, value: u8, now: i64) !void {
        if (s.asking != .mode) return;
        if (value != 1 and value != 2) return s.settle(.unsupported);
        s.asking = .list;
        s.answer_by = now + answer_ms;
        try s.out.appendSlice(a, list_probe);
    }

    pub fn terminalName(s: *State, reported: []const u8) void {
        s.terminal = .ascii(reported);
    }

    /// One OSC 5522 packet from the host, without its prefix and terminator.
    pub fn packet(s: *State, raw: []const u8, now: i64) !void {
        const p = Packet.parse(raw) orelse return;
        if (std.mem.eql(u8, p.id, probe_id)) return s.probeReply(p);
        if (std.mem.eql(u8, p.id, read_id)) return s.readReply(p, now);
        if (p.id.len == 0 and p.pw.len > 0) s.eventPacket(p);
    }

    /// The types a ready paste listed, once. Choose what to read and
    /// `request` it while the paste's password still holds.
    pub fn takeEvent(s: *State) ?[]const u8 {
        if (s.event.phase != .ready) return null;
        s.event.phase = .none;
        return s.event.listing.text();
    }

    /// Reads `mime` with the last paste's password; false while another
    /// read is in progress.
    pub fn request(s: *State, mime: []const u8, now: i64) !bool {
        return s.read(&.{mime}, false, now);
    }

    /// Reads `types` for a program that takes paste events; false while
    /// another read is in progress. The result is a `relay`.
    pub fn relay(s: *State, types: []const []const u8, now: i64) !bool {
        return s.read(types, true, now);
    }

    fn read(s: *State, mimes: []const []const u8, relaying: bool, now: i64) !bool {
        if (s.reading != null) return false;
        var reading: Reading = .{ .count = mimes.len, .relay = relaying };
        @memcpy(reading.mimes[0..mimes.len], mimes);
        var out: std.Io.Writer.Allocating = .fromArrayList(a, &s.out);
        defer s.out = out.toArrayList();
        try out.writer.print("\x1b]5522;type=read:id={s}:pw={s}:name={s};", .{ read_id, s.event.pw.text(), corgi_name });
        var list: [128]u8 = undefined;
        var fixed: std.Io.Writer = .fixed(&list);
        for (mimes, 0..) |mime, i| try fixed.print("{s}{s}", .{ if (i > 0) " " else "", mime });
        try base64.Encoder.encodeWriter(&out.writer, fixed.buffered());
        try out.writer.writeAll("\x1b\\");
        s.reading = reading;
        s.stall_by = now + stall_ms;
        return true;
    }

    pub fn takeResult(s: *State) ?Result {
        defer s.result = null;
        return s.result;
    }

    /// Gives up on a host that never answered and on a stalled read.
    pub fn tick(s: *State, now: i64) void {
        if (s.asking != .none and now >= s.answer_by) s.settle(.unsupported);
        if (s.reading != null and now >= s.stall_by) s.fail(.timed_out);
    }

    /// The card for `key`, if it was likely an attempt to paste an image
    /// that can't work. `agent` names the program in the pane, `host` this
    /// machine. A paste key that arrives as a key also tells the terminal's OS.
    pub fn notice(s: *State, key: Key, agent: []const u8, host: []const u8) ?Notice {
        switch (key) {
            .cmd => s.os = .macos,
            .ctrl_shift => s.os = .linux,
            .ctrl => {},
        }
        var n: Notice = .{};
        var buf: [96]u8 = undefined;
        const linux = s.onLinux();
        const paste_key = if (linux) "Ctrl+Shift+V" else "⌘+V";
        const program_name = s.programName();
        const ghostty = std.mem.eql(u8, program_name, "ghostty");
        switch (s.support) {
            .local, .probing => return null,
            .on => {
                if (key != .ctrl) return null;
                n.body = .initTruncated(std.fmt.bufPrint(&buf, "{s} reads the clipboard on {s}.", .{ agent, host }) catch "");
                n.add(.text, if (linux) "Paste images with " else "Paste images from your Mac with ");
                n.add(.key, paste_key);
                n.add(.text, ".");
            },
            .denied => if (ghostty) {
                n.body = .initTruncated("Ghostty is set to refuse clipboard reads.");
                n.enable("Set clipboard-read = ask", paste_key);
            } else {
                n.body = .initTruncated(std.fmt.bufPrint(&buf, "{s} refuses clipboard reads.", .{s.displayName(&buf)}) catch "");
                n.enable("Allow clipboard reads", paste_key);
            },
            .unsupported => if (s.multiplexer()) |between| {
                n.body = .initTruncated(std.fmt.bufPrint(&buf, "{s} sits between Corgi and your terminal.", .{between}) catch "");
                var lead: [32]u8 = undefined;
                n.enable(std.fmt.bufPrint(&lead, "Run Corgi outside {s}", .{between}) catch "", paste_key);
            } else if (linux) {
                var title: [32]u8 = undefined;
                n.body = .initTruncated(std.fmt.bufPrint(&buf, "{s} on Linux can't send images over SSH yet.", .{capitalized(program_name, &title)}) catch "");
                n.add(.text, "Only Ghostty Nightly on macOS can, for now.");
            } else {
                var named: [96]u8 = undefined;
                n.body = .initTruncated(std.fmt.bufPrint(&buf, "{s} can't send images over SSH.", .{s.displayName(&named)}) catch "");
                n.add(.text, "Use ");
                n.add(.link, "Ghostty Nightly");
                n.add(.text, " to enable paste with ");
                n.add(.key, paste_key);
                n.add(.text, ".");
            },
        }
        return n;
    }

    /// Linux, from the paste key, or a Ghostty built after macOS gained
    /// paste events that still has none.
    fn onLinux(s: *const State) bool {
        if (s.os != .unknown) return s.os == .linux;
        return s.support == .unsupported and std.mem.eql(u8, s.programName(), "ghostty") and std.mem.indexOfScalar(u8, s.terminal.text(), '+') != null;
    }

    /// The terminal's program name, from XTVERSION's "name version".
    fn programName(s: *const State) []const u8 {
        const full = s.terminal.text();
        return full[0 .. std.mem.indexOfScalar(u8, full, ' ') orelse full.len];
    }

    /// The terminal as a sentence starts it: "Ghostty 1.3.1".
    fn displayName(s: *const State, buf: []u8) []const u8 {
        const text = s.terminal.text();
        if (text.len == 0) return "This terminal";
        return capitalized(text, buf);
    }

    /// Image paste's state in a few words, for the setup menu.
    pub fn status(s: *const State, buf: []u8) []const u8 {
        return switch (s.support) {
            .local => "only over SSH",
            .probing => "checking",
            .on => "● On",
            .denied => "○ clipboard-read = deny",
            .unsupported => if (s.multiplexer()) |between|
                std.fmt.bufPrint(buf, "○ {s} in between", .{between}) catch "○ Off"
            else
                "○ no paste events",
        };
    }

    /// A multiplexer that answered for the terminal behind it.
    fn multiplexer(s: *const State) ?[]const u8 {
        for ([_][]const u8{ "tmux", "screen" }) |known| if (std.mem.eql(u8, s.programName(), known)) return known;
        return null;
    }

    fn settle(s: *State, support: Support) void {
        s.support = support;
        s.asking = .none;
    }

    fn probeReply(s: *State, p: Packet) !void {
        if (s.asking != .list) return;
        switch (p.status) {
            .OK, .DATA => {},
            .DONE => {
                s.settle(.on);
                try s.out.appendSlice(a, enable);
            },
            .EPERM => s.settle(.denied),
            else => s.settle(.unsupported),
        }
    }

    fn eventPacket(s: *State, p: Packet) void {
        switch (p.status) {
            .OK => s.event = .{ .phase = .receiving, .pw = BoundedText(256).init(p.pw) catch return },
            .DATA => if (s.event.phase == .receiving and p.names(".")) {
                var buf: [4096]u8 = undefined;
                const size = base64.Decoder.calcSizeForSlice(p.payload) catch return;
                if (size > buf.len) return;
                base64.Decoder.decode(buf[0..size], p.payload) catch return;
                s.event.listing = .ascii(buf[0..size]);
            },
            .DONE => if (s.event.phase == .receiving) {
                s.event.phase = .ready;
            },
            else => s.event = .{},
        }
    }

    fn readReply(s: *State, p: Packet, now: i64) !void {
        const reading = if (s.reading) |*reading| reading else return;
        s.stall_by = now + stall_ms;
        switch (p.status) {
            .OK => {},
            .DATA => {
                if (reading.too_large) return;
                const data = for (reading.mimes[0..reading.count], reading.data[0..reading.count]) |mime, *data| {
                    if (p.names(mime)) break data;
                } else return;
                const size = base64.Decoder.calcSizeForSlice(p.payload) catch return s.fail(.host_error);
                if (reading.data[0].items.len + reading.data[1].items.len + size > max_bytes) {
                    reading.too_large = true;
                    return;
                }
                const dest = try data.addManyAsSlice(a, size);
                base64.Decoder.decode(dest, p.payload) catch return s.fail(.host_error);
            },
            .DONE => s.finish(now),
            .EPERM => s.fail(.denied),
            else => s.fail(.host_error),
        }
    }

    fn finish(s: *State, now: i64) void {
        var reading = s.reading.?;
        s.reading = null;
        defer reading.deinit();
        if (reading.too_large) return s.deliver(.{ .failed = .too_large });
        if (reading.relay) return s.deliverRelay(&reading, now);
        const mime = reading.mimes[0];
        if (std.mem.eql(u8, mime, "text/plain")) {
            const text = reading.data[0].toOwnedSlice(a) catch return s.deliver(.{ .failed = .host_error });
            return s.deliver(.{ .text = text });
        }
        const path = saveImage(s.folder, mime, reading.data[0].items, now) catch |err| return s.deliver(.{ .failed = if (err == error.NotImage) .not_image else .save_failed });
        s.deliver(.{ .path = path });
    }

    fn deliverRelay(s: *State, reading: *Reading, now: i64) void {
        var relayed: Relay = .{};
        for (reading.mimes[0..reading.count], reading.data[0..reading.count]) |mime, *data| {
            if (data.items.len == 0) continue;
            if (std.mem.eql(u8, mime, "text/plain")) {
                if (data.items.len <= max_relayed_text) relayed.text = data.toOwnedSlice(a) catch null;
            } else if (saveImage(s.folder, mime, data.items, now)) |path| {
                relayed.image = .{ .mime = mime, .path = path };
            } else |_| {}
        }
        s.deliver(.{ .relay = relayed });
    }

    fn fail(s: *State, failure: Failure) void {
        if (s.reading) |*reading| reading.deinit();
        s.reading = null;
        s.deliver(.{ .failed = failure });
    }

    fn deliver(s: *State, result: Result) void {
        if (s.result) |old| old.deinit();
        s.result = result;
    }
};

/// `text` with its first letter capitalized, in `buf`.
fn capitalized(text: []const u8, buf: []u8) []const u8 {
    const n = @min(text.len, buf.len);
    @memcpy(buf[0..n], text[0..n]);
    if (n > 0) buf[0] = std.ascii.toUpper(buf[0]);
    return buf[0..n];
}

fn saveImage(folder: []const u8, mime: []const u8, data: []const u8, now: i64) ![]u8 {
    const image = for (images) |image| {
        if (std.mem.eql(u8, image.mime, mime)) break image;
    } else return error.NotImage;
    if (!image.matches(data)) return error.NotImage;
    return save(folder, data, image.extension, now);
}

/// Saves `data` as `<folder>/<hash>.<extension>`, replacing an earlier copy
/// of the same image, and removes images last pasted a day before `now`.
fn save(folder: []const u8, data: []const u8, extension: []const u8, now: i64) ![]u8 {
    if (!std.fs.path.isAbsolute(folder)) return error.RelativeFolder;
    try os.privateDirectory(folder);
    var dir = try std.Io.Dir.openDirAbsolute(os.io(), folder, .{ .iterate = true });
    defer dir.close(os.io());
    prune(dir, now);
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(data, &digest, .{});
    var buf: [64]u8 = undefined;
    const name = try std.fmt.bufPrint(&buf, "{s}.{s}", .{ std.fmt.bytesToHex(digest[0..16], .lower), extension });
    var atomic = try dir.createFileAtomic(os.io(), name, .{ .permissions = .fromMode(0o600), .replace = true });
    defer atomic.deinit(os.io());
    try atomic.file.writeStreamingAll(os.io(), data);
    try atomic.replace(os.io());
    return std.fs.path.join(a, &.{ folder, name });
}

fn prune(dir: std.Io.Dir, now: i64) void {
    var files = dir.iterate();
    while (files.next(os.io()) catch null) |file| {
        if (file.kind != .file) continue;
        const stat = dir.statFile(os.io(), file.name, .{}) catch continue;
        if (now - stat.mtime.toMilliseconds() > keep_ms) dir.deleteFile(os.io(), file.name) catch {};
    }
}

/// The packets a host sends for a paste: the password, then the listing.
fn hostPaste(comptime pw: []const u8, comptime listing: []const u8) []const u8 {
    return "\x1b]5522;type=read:status=OK:pw=" ++ pw ++ "\x1b\\" ++
        "\x1b]5522;type=read:status=DATA:mime=Lg==:pw=" ++ pw ++ ";" ++ listing ++ "\x1b\\" ++
        "\x1b]5522;type=read:status=DONE:pw=" ++ pw ++ "\x1b\\";
}

fn feedPackets(s: *State, bytes: []const u8, now: i64) !void {
    var rest = bytes;
    while (std.mem.indexOf(u8, rest, "\x1b]5522;")) |start| {
        const body = rest[start + 7 ..];
        const end = std.mem.indexOf(u8, body, "\x1b\\").?;
        try s.packet(body[0..end], now);
        rest = body[end + 2 ..];
    }
}

test "text wins, and an image goes only into a pane" {
    try std.testing.expectEqualStrings("text/plain", choose("image/png text/plain\n", true).read);
    try std.testing.expectEqualStrings("image/png", choose("image/tiff image/png\n", true).read);
    try std.testing.expectEqualStrings("image/jpeg", choose("image/jpeg", true).read);
    try std.testing.expectEqual(Failure.not_pane, choose("image/png", false).refuse);
    try std.testing.expectEqual(Failure.unsupported_image, choose("image/tiff\n", true).refuse);
    try std.testing.expect(choose("", true) == .nothing);
    try std.testing.expect(choose("application/pdf", true) == .nothing);
    try std.testing.expect(!images[3].matches("RIFF\x00\x00\x00\x00WAVE"));
    try std.testing.expect(images[3].matches("RIFF\x00\x00\x00\x00WEBPVP8 "));
}

test "paste events turn on only when the host supports them and allows reads" {
    var s: State = .{};
    defer s.deinit();
    try s.start(0);
    try std.testing.expectEqualStrings(query_mode ++ query_version, s.out.items);
    s.out.clearRetainingCapacity();
    try s.modeReport(2, 10);
    try std.testing.expectEqualStrings(list_probe, s.out.items);
    s.out.clearRetainingCapacity();
    try feedPackets(&s, "\x1b]5522;type=read:status=OK:id=corgi-probe\x1b\\\x1b]5522;type=read:status=DATA:id=corgi-probe:mime=Lg==;aW1hZ2UvcG5nCg==\x1b\\\x1b]5522;type=read:status=DONE:id=corgi-probe\x1b\\", 20);
    try std.testing.expectEqual(Support.on, s.support);
    try std.testing.expectEqualStrings(enable, s.out.items);

    var denied: State = .{};
    defer denied.deinit();
    try denied.start(0);
    try denied.modeReport(2, 0);
    try feedPackets(&denied, "\x1b]5522;type=read:status=EPERM:id=corgi-probe\x1b\\", 0);
    try std.testing.expectEqual(Support.denied, denied.support);
    try std.testing.expect(std.mem.indexOf(u8, denied.out.items, enable) == null);

    var unknown: State = .{};
    defer unknown.deinit();
    try unknown.start(0);
    try unknown.modeReport(0, 0);
    try std.testing.expectEqual(Support.unsupported, unknown.support);

    var silent: State = .{};
    defer silent.deinit();
    try silent.start(0);
    silent.tick(answer_ms - 1);
    try std.testing.expectEqual(Support.probing, silent.support);
    silent.tick(answer_ms);
    try std.testing.expectEqual(Support.unsupported, silent.support);
}

test "a paste reads with its one-time password and saves an image under its hash" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const root = try os.realpathAlloc(std.testing.allocator, tmp.dir, ".");
    defer std.testing.allocator.free(root);
    const folder = try std.fs.path.join(std.testing.allocator, &.{ root, "paste" });
    defer std.testing.allocator.free(folder);
    var s: State = .{ .support = .on, .folder = folder };
    defer s.deinit();

    try feedPackets(&s, hostPaste("b3RwLTE=", "aW1hZ2UvcG5nCg=="), 0);
    const listing = s.takeEvent().?;
    try std.testing.expectEqualStrings("image/png", choose(listing, true).read);
    try std.testing.expect(s.takeEvent() == null);
    try std.testing.expect(try s.request("image/png", 0));
    try std.testing.expectEqualStrings("\x1b]5522;type=read:id=corgi:pw=b3RwLTE=:name=Q29yZ2k=;aW1hZ2UvcG5n\x1b\\", s.out.items);
    try std.testing.expect(!try s.request("text/plain", 0));

    const png = "\x89PNG\r\n\x1a\nIHDR";
    try feedPackets(&s, "\x1b]5522;type=read:status=OK:id=corgi\x1b\\" ++
        "\x1b]5522;type=read:status=DATA:id=corgi:mime=" ++ "aW1hZ2UvcG5n" ++ ";" ++ "iVBORw0KGgo=" ++ "\x1b\\" ++
        // Another type's data and a late listing are not the image.
        "\x1b]5522;type=read:status=DATA:id=corgi:mime=" ++ "dGV4dC9wbGFpbg==" ++ ";eA==\x1b\\" ++
        "\x1b]5522;type=read:status=DATA:id=corgi:mime=" ++ "aW1hZ2UvcG5n" ++ ";" ++ "SUhEUg==" ++ "\x1b\\" ++
        "\x1b]5522;type=read:status=DONE:id=corgi\x1b\\", 1000);
    const result = s.takeResult().?;
    defer result.deinit();
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(png, &digest, .{});
    const name = std.fmt.bytesToHex(digest[0..16], .lower) ++ ".png".*;
    try std.testing.expect(std.mem.endsWith(u8, result.path, &name));
    try std.testing.expectEqualStrings(folder, std.fs.path.dirname(result.path).?);
    const saved = try std.Io.Dir.cwd().readFileAlloc(os.io(), result.path, std.testing.allocator, .limited(1024));
    defer std.testing.allocator.free(saved);
    try std.testing.expectEqualStrings(png, saved);
    const stat = try os.lstat(folder);
    try std.testing.expectEqual(@as(u32, 0o700), stat.mode & 0o777);
    try std.testing.expect(s.takeResult() == null);
}

test "a refused, stalled, damaged or oversized read reports why" {
    var s: State = .{ .support = .on };
    defer s.deinit();
    try feedPackets(&s, hostPaste("cHc=", "dGV4dC9wbGFpbgo="), 0);
    _ = s.takeEvent().?;
    _ = try s.request("text/plain", 0);
    try feedPackets(&s, "\x1b]5522;type=read:status=EPERM:id=corgi\x1b\\", 0);
    try std.testing.expectEqual(Failure.denied, s.takeResult().?.failed);

    _ = try s.request("text/plain", 0);
    s.tick(stall_ms - 1);
    try std.testing.expect(s.takeResult() == null);
    s.tick(stall_ms);
    try std.testing.expectEqual(Failure.timed_out, s.takeResult().?.failed);

    _ = try s.request("image/png", 0);
    try feedPackets(&s, "\x1b]5522;type=read:status=DATA:id=corgi:mime=" ++ "aW1hZ2UvcG5n" ++ ";bm90IGEgcG5n\x1b\\\x1b]5522;type=read:status=DONE:id=corgi\x1b\\", 0);
    try std.testing.expectEqual(Failure.not_image, s.takeResult().?.failed);

    _ = try s.request("image/png", 0);
    s.reading.?.too_large = true;
    try feedPackets(&s, "\x1b]5522;type=read:status=DONE:id=corgi\x1b\\", 0);
    try std.testing.expectEqual(Failure.too_large, s.takeResult().?.failed);

    _ = try s.request("text/plain", 0);
    try feedPackets(&s, "\x1b]5522;type=read:status=DATA:id=corgi:mime=" ++ "dGV4dC9wbGFpbg==" ++ ";aGk=\x1b\\\x1b]5522;type=read:status=DONE:id=corgi\x1b\\", 0);
    const text = s.takeResult().?;
    defer text.deinit();
    try std.testing.expectEqualStrings("hi", text.text);
}

fn fixText(n: Notice, buf: []u8) []const u8 {
    var w: std.Io.Writer = .fixed(buf);
    for (n.fix()) |part| w.writeAll(part.text.text()) catch {};
    return w.buffered();
}

test "an attempted image paste says why it can't work and what fixes it" {
    var buf: [128]u8 = undefined;
    var s: State = .{};
    try std.testing.expect(s.notice(.cmd, "Codex", "nocap") == null);
    s.support = .unsupported;
    s.terminalName("ghostty 1.3.1");
    var n = s.notice(.cmd, "Codex", "nocap").?;
    try std.testing.expectEqualStrings("Ghostty 1.3.1 can't send images over SSH.", n.body.text());
    try std.testing.expectEqualStrings("Use Ghostty Nightly to enable paste with ⌘+V.", fixText(n, &buf));
    try std.testing.expectEqual(Notice.Kind.link, n.fix()[1].kind);
    try std.testing.expectEqual(Notice.Kind.key, n.fix()[3].kind);
    // Ctrl+Shift+V only arrives from Ghostty on Linux, which has no fix yet.
    n = s.notice(.ctrl_shift, "Codex", "nocap").?;
    try std.testing.expectEqualStrings("Ghostty on Linux can't send images over SSH yet.", n.body.text());
    try std.testing.expectEqualStrings("Only Ghostty Nightly on macOS can, for now.", fixText(n, &buf));

    var nightly: State = .{ .support = .unsupported };
    nightly.terminalName("ghostty 1.3.2-main+5dc28bb8e");
    try std.testing.expect(std.mem.indexOf(u8, nightly.notice(.ctrl, "Codex", "nocap").?.body.text(), "on Linux") != null);

    var tmux: State = .{ .support = .unsupported };
    tmux.terminalName("tmux 3.4");
    n = tmux.notice(.ctrl, "Claude", "nocap").?;
    try std.testing.expectEqualStrings("tmux sits between Corgi and your terminal.", n.body.text());
    try std.testing.expectEqualStrings("Run Corgi outside tmux to enable paste with ⌘+V.", fixText(n, &buf));

    var denied: State = .{ .support = .denied };
    denied.terminalName("ghostty 1.3.2-main+5dc28bb8e");
    try std.testing.expectEqualStrings("Set clipboard-read = ask to enable paste with ⌘+V.", fixText(denied.notice(.cmd, "Codex", "nocap").?, &buf));

    var on: State = .{ .support = .on };
    try std.testing.expect(on.notice(.cmd, "Codex", "nocap") == null);
    n = on.notice(.ctrl, "Codex", "nocap").?;
    try std.testing.expectEqualStrings("Codex reads the clipboard on nocap.", n.body.text());
    try std.testing.expectEqualStrings("Paste images from your Mac with ⌘+V.", fixText(n, &buf));

    var unnamed: State = .{ .support = .unsupported };
    try std.testing.expectEqualStrings("This terminal can't send images over SSH.", unnamed.notice(.cmd, "Codex", "nocap").?.body.text());
}

test "a program that takes paste events is offered the text and the image together" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const root = try os.realpathAlloc(std.testing.allocator, tmp.dir, ".");
    defer std.testing.allocator.free(root);
    const folder = try std.fs.path.join(std.testing.allocator, &.{ root, "paste" });
    defer std.testing.allocator.free(folder);
    var s: State = .{ .support = .on, .folder = folder };
    defer s.deinit();
    try feedPackets(&s, hostPaste("cHc=", "dGV4dC9wbGFpbiBpbWFnZS9wbmcK"), 0);
    var buf: [2][]const u8 = undefined;
    const types = relayTypes(s.takeEvent().?, &buf);
    try std.testing.expectEqual(@as(usize, 2), types.len);
    try std.testing.expect(try s.relay(types, 0));
    try std.testing.expect(std.mem.endsWith(u8, s.out.items, ";dGV4dC9wbGFpbiBpbWFnZS9wbmc=\x1b\\"));
    try feedPackets(&s, "\x1b]5522;type=read:status=OK:id=corgi\x1b\\" ++
        "\x1b]5522;type=read:status=DATA:id=corgi:mime=dGV4dC9wbGFpbg==;aGk=\x1b\\" ++
        "\x1b]5522;type=read:status=DATA:id=corgi:mime=aW1hZ2UvcG5n;iVBORw0KGgo=\x1b\\" ++
        "\x1b]5522;type=read:status=DONE:id=corgi\x1b\\", 0);
    const result = s.takeResult().?;
    defer result.deinit();
    try std.testing.expectEqualStrings("hi", result.relay.text.?);
    try std.testing.expectEqualStrings("image/png", result.relay.image.?.mime);
    try std.testing.expect(std.mem.endsWith(u8, result.relay.image.?.path, ".png"));
}

test "image paste's state shows in a few words" {
    var buf: [48]u8 = undefined;
    var s: State = .{};
    try std.testing.expectEqualStrings("only over SSH", s.status(&buf));
    s.support = .on;
    try std.testing.expectEqualStrings("● On", s.status(&buf));
    s.support = .unsupported;
    try std.testing.expectEqualStrings("○ no paste events", s.status(&buf));
    s.terminalName("tmux 3.4");
    try std.testing.expectEqualStrings("○ tmux in between", s.status(&buf));
    s.support = .denied;
    try std.testing.expectEqualStrings("○ clipboard-read = deny", s.status(&buf));
}
