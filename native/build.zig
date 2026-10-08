//! The native layer Corgi's Bun application loads over FFI, and the
//! `corgi-hook` sender. Corgi's Zig sources it compiles are in zig/.
const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const ghostty = b.dependency("ghostty", .{ .target = target, .optimize = optimize, .simd = false, .@"emit-lib-vt" = true });
    const opts = b.addOptions();
    opts.addOption(bool, "check_leaks", false);
    opts.addOption(bool, "viewer_test_driver", false);
    opts.addOption(bool, "test_build", false);

    // Terminal emulation, frame diffs, keyboard encoding and process probes.
    const pane = b.createModule(.{ .root_source_file = b.path("zig/pane.zig"), .target = target, .optimize = optimize, .link_libc = true });
    pane.addImport("ghostty-vt", ghostty.module("ghostty-vt"));
    pane.addOptions("corgi_options", opts);
    const mod = b.createModule(.{ .root_source_file = b.path("bridge.zig"), .target = target, .optimize = optimize, .link_libc = true });
    mod.addImport("pane", pane);
    mod.addCSourceFile(.{ .file = b.path("posix.c"), .flags = &.{"-O3"} });
    // Each module below roots a copy of zig/: `pane` already owns the original os.zig.
    const sources = b.addWriteFiles();
    _ = sources.addCopyDirectory(b.path("zig"), "zig", .{});
    const frame_diff = b.createModule(.{ .root_source_file = sources.getDirectory().path(b, "zig/frame_diff.zig"), .target = target, .optimize = optimize, .link_libc = true });
    frame_diff.addImport("ghostty-vt", ghostty.module("ghostty-vt"));
    frame_diff.addImport("corgi_options", pane.import_table.get("corgi_options").?);
    mod.addImport("frame_diff", frame_diff);
    const keyboard = b.createModule(.{ .root_source_file = sources.getDirectory().path(b, "zig/keyboard.zig"), .target = target, .optimize = optimize });
    keyboard.addImport("ghostty-vt", ghostty.module("ghostty-vt"));
    mod.addImport("keyboard", keyboard);
    install(b, b.addLibrary(.{ .name = "corgi_probe", .linkage = .dynamic, .root_module = mod }));

    // Resource sampling and crash reports.
    const system_root = sources.add("zig/bun_system.zig", "pub const resource_os = @import(\"trackers/resource_os.zig\");\n");
    const resource_os = b.createModule(.{ .root_source_file = system_root, .target = target, .optimize = optimize, .link_libc = true });
    resource_os.addOptions("corgi_options", opts);
    const system = b.createModule(.{ .root_source_file = b.path("app_system.zig"), .target = target, .optimize = optimize, .link_libc = true });
    system.addImport("resource_os", resource_os);
    system.addCSourceFile(.{ .file = b.path("crash.c"), .flags = &.{ "-O2", "-DSENTRY_BUILD_STATIC" } });
    system.linkLibrary(sentryLibrary(b, target, optimize));
    install(b, b.addLibrary(.{ .name = "corgi_system", .linkage = .dynamic, .root_module = system }));

    // The hook sender: Corgi's own detection and os code, nothing else.
    const hook_root = sources.add("zig/hook_deps.zig", "pub const os = @import(\"os.zig\");\npub const detection = @import(\"detection.zig\");\n");
    const hook_deps = b.createModule(.{ .root_source_file = hook_root, .target = target, .optimize = optimize, .link_libc = true });
    hook_deps.addOptions("corgi_options", opts);
    const hook = b.createModule(.{ .root_source_file = b.path("hook.zig"), .target = target, .optimize = optimize, .link_libc = true, .strip = true });
    hook.addImport("hook_deps", hook_deps);
    install(b, b.addExecutable(.{ .name = "corgi-hook", .root_module = hook }));

    // PTY setup and descriptor readiness.
    const pty_exec = b.createModule(.{ .target = target, .optimize = optimize, .link_libc = true });
    pty_exec.addCSourceFile(.{ .file = b.path("pty-exec.c"), .flags = &.{ "-O2", "-Wall", "-Wextra" } });
    install(b, b.addExecutable(.{ .name = "pty-exec", .root_module = pty_exec }));
    const readiness = b.createModule(.{ .target = target, .optimize = optimize, .link_libc = true });
    readiness.addCSourceFile(.{ .file = b.path("readiness.c"), .flags = &.{ "-O3", "-pthread", "-Wall", "-Wextra" } });
    install(b, b.addLibrary(.{ .name = "corgi_fd", .linkage = .dynamic, .root_module = readiness }));
}

fn install(b: *std.Build, artifact: *std.Build.Step.Compile) void {
    if (artifact.root_module.resolved_target.?.result.os.tag == .macos) {
        if (b.sysroot) |sdk| {
            artifact.setLibCFile(sdkLibc(b, sdk));
            artifact.root_module.addSystemFrameworkPath(.{ .cwd_relative = b.pathJoin(&.{ sdk, "System/Library/Frameworks" }) });
        }
    }
    b.installArtifact(artifact);
}

fn sdkLibc(b: *std.Build, sdk: []const u8) std.Build.LazyPath {
    const include = b.pathJoin(&.{ sdk, "usr/include" });
    return b.addWriteFiles().add("libc.txt", b.fmt("include_dir={s}\nsys_include_dir={s}\ncrt_dir=\nmsvc_lib_dir=\nkernel32_lib_dir=\ngcc_dir=\n", .{ include, include }));
}

/// sentry-native with its in-process crash handler and no transport of its
/// own; the application sends reports itself.
fn sentryLibrary(b: *std.Build, target: std.Build.ResolvedTarget, optimize: std.builtin.OptimizeMode) *std.Build.Step.Compile {
    const upstream = b.dependency("sentry", .{});
    const lib = b.addLibrary(.{
        .name = "sentry",
        .linkage = .static,
        .root_module = b.createModule(.{ .target = target, .optimize = optimize, .link_libc = true }),
    });
    if (target.result.os.tag == .macos) if (b.sysroot) |sdk| lib.setLibCFile(sdkLibc(b, sdk));
    const flags: []const []const u8 = &.{
        "-DSENTRY_BUILD_STATIC",
        "-DSENTRY_BACKEND_INPROC",
        "-DSENTRY_WITH_UNWINDER_LIBBACKTRACE",
        "-include",
        b.pathFromRoot("zig/sentry_cloexec.h"),
    };
    lib.root_module.addIncludePath(upstream.path("include"));
    lib.root_module.addIncludePath(upstream.path("src"));
    lib.root_module.addCSourceFiles(.{ .root = upstream.path(""), .files = sentry_sources, .flags = flags });
    lib.root_module.addCSourceFiles(.{
        .root = upstream.path(""),
        .files = switch (target.result.os.tag) {
            .macos => &.{"src/modulefinder/sentry_modulefinder_apple.c"},
            .linux => &.{ "src/modulefinder/sentry_modulefinder_linux.c", "vendor/stb_sprintf.c" },
            else => @panic("sentry-native: unsupported target OS"),
        },
        .flags = flags,
    });
    lib.installHeadersDirectory(upstream.path("include"), "", .{ .include_extensions = &.{".h"} });
    return lib;
}
const sentry_sources: []const []const u8 = &.{
    "src/sentry_alloc.c",                          "src/sentry_backend.c",                    "src/sentry_core.c",
    "src/sentry_database.c",                       "src/sentry_envelope.c",                   "src/sentry_info.c",
    "src/sentry_json.c",                           "src/sentry_logger.c",                     "src/sentry_options.c",
    "src/sentry_os.c",                             "src/sentry_random.c",                     "src/sentry_ratelimiter.c",
    "src/sentry_scope.c",                          "src/sentry_session.c",                    "src/sentry_slice.c",
    "src/sentry_string.c",                         "src/sentry_sync.c",                       "src/sentry_transport.c",
    "src/sentry_utils.c",                          "src/sentry_uuid.c",                       "src/sentry_value.c",
    "src/sentry_tracing.c",                        "src/sentry_unix_pageallocator.c",         "src/path/sentry_path.c",
    "src/path/sentry_path_unix.c",                 "src/symbolizer/sentry_symbolizer_unix.c", "src/unwinder/sentry_unwinder.c",
    "src/unwinder/sentry_unwinder_libbacktrace.c", "src/transports/sentry_disk_transport.c",  "src/transports/sentry_function_transport.c",
    "src/transports/sentry_transport_none.c",      "src/backends/sentry_backend_inproc.c",    "vendor/mpack.c",
};
