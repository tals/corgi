//! Credential access runs in a short-lived helper. Only an explicit user action
//! permits that helper to display a Keychain dialog.
const std = @import("std");
const builtin = @import("builtin");
const options = @import("corgi_options");
const os = @import("os.zig");
const a = os.allocator;

pub const Interaction = enum { silent, interactive };
const ReadError = error{ Unavailable, NeedsConsent };

fn read(interaction: Interaction) ReadError![]u8 {
    const home = os.env("HOME") orelse return error.Unavailable;
    if (builtin.os.tag == .macos and os.env("CLAUDE_CONFIG_DIR") == null) {
        if (keychain(interaction)) |bytes| return bytes else |err| {
            if (err == error.NeedsConsent) return err;
        }
    }
    const root = os.env("CLAUDE_CONFIG_DIR") orelse std.fs.path.join(a, &.{ home, ".claude" }) catch return error.Unavailable;
    defer if (os.env("CLAUDE_CONFIG_DIR") == null) a.free(root);
    const path = std.fs.path.join(a, &.{ root, ".credentials.json" }) catch return error.Unavailable;
    defer a.free(path);
    if (std.posix.open(path, .{ .ACCMODE = .RDONLY, .CLOEXEC = true, .NONBLOCK = true }, 0)) |fd| {
        const file: std.fs.File = .{ .handle = fd };
        defer file.close();
        const stat = file.stat() catch return error.Unavailable;
        if (stat.kind != .file or stat.size > 65536) return error.Unavailable;
        return file.readToEndAlloc(a, 65536) catch error.Unavailable;
    } else |err| {
        if (err != error.FileNotFound) return error.Unavailable;
    }
    // Custom profiles must never silently fall back to another account's keychain item.
    return error.Unavailable;
}

const Ref = ?*const anyopaque;
extern "CoreFoundation" fn CFStringCreateWithCString(Ref, [*:0]const u8, u32) Ref;
extern "CoreFoundation" fn CFDictionaryCreate(Ref, [*]const Ref, [*]const Ref, isize, Ref, Ref) Ref;
extern "CoreFoundation" fn CFRelease(Ref) void;
extern "CoreFoundation" fn CFDataGetLength(Ref) isize;
extern "CoreFoundation" fn CFDataGetBytePtr(Ref) [*]const u8;
extern "CoreFoundation" var kCFBooleanTrue: Ref;
extern "Security" fn SecItemCopyMatching(Ref, *Ref) i32;
extern "Security" var kSecClass: Ref;
extern "Security" var kSecClassGenericPassword: Ref;
extern "Security" var kSecAttrService: Ref;
extern "Security" var kSecReturnData: Ref;
extern "Security" var kSecMatchLimit: Ref;
extern "Security" var kSecMatchLimitOne: Ref;
extern "Security" var kSecUseAuthenticationUI: Ref;
extern "Security" var kSecUseAuthenticationUIFail: Ref;

extern "Security" fn SecKeychainSetUserInteractionAllowed(u8) i32;
extern "Security" fn SecKeychainGetUserInteractionAllowed(*u8) i32;

fn prepareAccess(interaction: Interaction, set_interaction: *const fn (u8) callconv(.c) i32) ReadError!void {
    if (interaction == .silent and set_interaction(0) != 0) return error.NeedsConsent;
}

fn keychain(interaction: Interaction) ReadError![]u8 {
    // The per-query flag alone does not suppress legacy login-keychain ACL UI.
    // Fail closed if we cannot disable it. This affects only this helper process.
    try prepareAccess(interaction, SecKeychainSetUserInteractionAllowed);
    const service = CFStringCreateWithCString(null, "Claude Code-credentials", 0x08000100) orelse return error.Unavailable;
    defer CFRelease(service);
    const keys = [_]Ref{ kSecClass, kSecAttrService, kSecReturnData, kSecMatchLimit, kSecUseAuthenticationUI };
    const values = [_]Ref{ kSecClassGenericPassword, service, kCFBooleanTrue, kSecMatchLimitOne, kSecUseAuthenticationUIFail };
    const count: isize = if (interaction == .silent) keys.len else keys.len - 1;
    const query = CFDictionaryCreate(null, &keys, &values, count, null, null) orelse return error.Unavailable;
    defer CFRelease(query);
    var data: Ref = null;
    const status = SecItemCopyMatching(query, &data);
    if (status == -25308 or status == -25315 or status == -25293 or status == -128) return securityTool(interaction);
    if (status != 0 or data == null) return error.Unavailable;
    defer CFRelease(data);
    const len = CFDataGetLength(data);
    if (len <= 0 or len > 65536) return error.Unavailable;
    return a.dupe(u8, CFDataGetBytePtr(data)[0..@intCast(len)]) catch error.Unavailable;
}

extern "Security" fn SecKeychainCopyDefault(*?*anyopaque) i32;
extern "Security" fn SecKeychainGetStatus(?*anyopaque, *u32) i32;

fn unlocked() bool {
    var keychain_ref: ?*anyopaque = null;
    if (SecKeychainCopyDefault(&keychain_ref) != 0 or keychain_ref == null) return false;
    defer CFRelease(keychain_ref);
    var status: u32 = 0;
    // kSecUnlockStateStatus
    return SecKeychainGetStatus(keychain_ref, &status) == 0 and status & 1 != 0;
}

// Claude Code reads its item through /usr/bin/security, the only client in the
// item's partition list. It rewrites the item on each token refresh, so an
// "Always Allow" granted to our binary never lasts. Read it the same way; the
// child is outside our interaction guard, so silent mode refuses a locked
// keychain, the only state in which `security` would show UI.
fn securityTool(interaction: Interaction) ReadError![]u8 {
    if (interaction == .silent and !unlocked()) return error.NeedsConsent;
    const result = std.process.Child.run(.{
        .allocator = a,
        .argv = &.{ "/usr/bin/security", "find-generic-password", "-s", "Claude Code-credentials", "-w" },
        .max_output_bytes = 65536,
    }) catch return error.Unavailable;
    a.free(result.stderr);
    const ok = result.term == .Exited and result.term.Exited == 0;
    const len = std.mem.trimRight(u8, result.stdout, "\n").len;
    if (!ok or len == 0) {
        a.free(result.stdout);
        return if (interaction == .silent) error.NeedsConsent else error.Unavailable;
    }
    return a.realloc(result.stdout, len) catch result.stdout[0..len];
}

// Stdout is a private pipe to the metadata worker, never a viewer RPC response.
pub fn serve(interaction: Interaction) !void {
    if (options.viewer_test_driver) {
        if (os.env("CORGI_TEST_CLAUDE_CREDENTIALS")) |path| {
            const file = try std.fs.openFileAbsolute(path, .{});
            defer file.close();
            const bytes = try file.readToEndAlloc(a, 65536);
            defer a.free(bytes);
            const fixture = try std.json.parseFromSlice(std.json.Value, a, bytes, .{});
            defer fixture.deinit();
            if (os.env("CORGI_TEST_CLAUDE_CREDENTIAL_LOG")) |log_path| {
                const log = try std.fs.createFileAbsolute(log_path, .{ .truncate = false });
                defer log.close();
                try log.seekFromEnd(0);
                try log.writeAll(@tagName(interaction));
                try log.writeAll("\n");
            }
            const selected = fixture.value.object.get(@tagName(interaction)) orelse return error.InvalidFixture;
            if (selected.object.get("delay_ms")) |delay| std.Thread.sleep(@as(u64, @intCast(delay.integer)) * std.time.ns_per_ms);
            return reply(selected);
        }
    }
    const bytes = read(interaction) catch |err| return reply(.{ .needs_consent = err == error.NeedsConsent });
    defer a.free(bytes);
    try reply(.{ .credentials = bytes });
}
fn reply(value: anytype) !void {
    const bytes = try std.json.Stringify.valueAlloc(a, value, .{});
    defer a.free(bytes);
    try os.writeAll(1, bytes);
}

test "silent credential reads fail closed if legacy UI cannot be disabled" {
    const Fake = struct {
        fn fail(state: u8) callconv(.c) i32 {
            std.debug.assert(state == 0);
            return -1;
        }
        fn forbidden(_: u8) callconv(.c) i32 {
            @panic("interactive helper must not change global interaction policy");
        }
    };
    try std.testing.expectError(error.NeedsConsent, prepareAccess(.silent, Fake.fail));
    try prepareAccess(.interactive, Fake.forbidden);
}

test "silent mode disables actual macOS legacy Keychain interaction without reading credentials" {
    if (builtin.os.tag != .macos) return error.SkipZigTest;
    var original: u8 = 0;
    try std.testing.expectEqual(@as(i32, 0), SecKeychainGetUserInteractionAllowed(&original));
    defer _ = SecKeychainSetUserInteractionAllowed(original);
    try prepareAccess(.silent, SecKeychainSetUserInteractionAllowed);
    var current: u8 = 1;
    try std.testing.expectEqual(@as(i32, 0), SecKeychainGetUserInteractionAllowed(&current));
    try std.testing.expectEqual(@as(u8, 0), current);
}
