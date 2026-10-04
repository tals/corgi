const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const ghostty = b.dependency("ghostty", .{
        .target = target,
        .optimize = optimize,
        .simd = false,
        .@"emit-lib-vt" = true,
    });
    const mod = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    mod.addImport("ghostty-vt", ghostty.module("ghostty-vt"));
    if (target.result.os.tag == .macos) {
        // Explicit macOS targets don't inherit native framework search paths.
        // The release script supplies the SDK selected by xcrun as --sysroot.
        if (b.sysroot) |sdk| {
            mod.addSystemFrameworkPath(.{ .cwd_relative = b.pathJoin(&.{ sdk, "System/Library/Frameworks" }) });
            mod.addSystemIncludePath(.{ .cwd_relative = b.pathJoin(&.{ sdk, "usr/include" }) });
        }
        mod.linkFramework("Security", .{});
        mod.linkFramework("CoreFoundation", .{});
    }
    const options = b.addOptions();
    const viewer_test_driver = b.option(bool, "viewer-test-driver", "Enable stdio viewer integration harness") orelse false;
    options.addOption(bool, "viewer_test_driver", viewer_test_driver);
    // The integration-test binary already builds with the viewer harness.
    options.addOption(bool, "test_build", b.option(bool, "test-build", "Enable integration-test hooks (default: -Dviewer-test-driver)") orelse viewer_test_driver);
    // Live terminal checkpoints contain VT sequences, not Ghostty structs.
    // Retain the ABI advertised before the Ghostty f523504ea update so an
    // installed older runtime can hand off to this build. Bump this only when
    // the checkpoint format or its restoration semantics change incompatibly.
    options.addOption(u64, "terminal_checkpoint_abi", 0xa826bd22ebcdbe60);
    options.addOption([]const u8, "release_version", b.option([]const u8, "release-version", "Release version") orelse "0.1.0-dev");
    options.addOption([]const u8, "release_commit", b.option([]const u8, "release-commit", "Source commit") orelse gitCommit(b));
    options.addOption([]const u8, "update_url", b.option([]const u8, "update-url", "HTTPS update feed base URL") orelse "");
    options.addOption([]const u8, "update_public_key", b.option([]const u8, "update-public-key", "Ed25519 public key, hex") orelse "");
    options.addOption(bool, "update_test_mode", b.option(bool, "update-test-mode", "Allow local HTTP update fixtures (never publish)") orelse false);
    options.addOption(bool, "check_leaks", b.option(bool, "check-leaks", "Unit tests use the leak-checking allocator everywhere") orelse false);
    options.addOption([]const u8, "sentry_dsn", b.option([]const u8, "sentry-dsn", "Sentry DSN to send crash reports to (default: none)") orelse "");
    mod.addOptions("corgi_options", options);
    mod.linkLibrary(sentryLibrary(b, target, optimize));
    const exe = b.addExecutable(.{ .name = "corgi", .root_module = mod });
    // Sentry matches a Linux crash to its uploaded debug file by build ID.
    if (target.result.ofmt == .elf) exe.build_id = .sha1;
    const native_macos = @import("builtin").os.tag == .macos and target.result.os.tag == .macos;
    const codesign = b.option(bool, "codesign", "Sign macOS builds with a persistent Keychain identity") orelse native_macos;
    const signing_timestamp = b.option(bool, "signing-timestamp", "Request a secure timestamp for macOS code signing") orelse true;
    const run = if (codesign and native_macos) blk: {
        const identity = b.option([]const u8, "signing-identity", "Code-signing certificate name or SHA-1") orelse
            std.mem.trim(u8, b.run(&.{ "/bin/sh", b.pathFromRoot("scripts/sign-macos"), "--identity" }), " \r\n\t");
        const sign = b.addSystemCommand(&.{"/bin/sh"});
        sign.addFileArg(b.path("scripts/sign-macos"));
        sign.addArg(identity);
        sign.addFileArg(exe.getEmittedBin());
        const signed = sign.addOutputFileArg("corgi");
        sign.addArg(if (signing_timestamp) "true" else "false");
        b.getInstallStep().dependOn(&b.addInstallBinFile(signed, "corgi").step);
        const signed_run = std.Build.Step.Run.create(b, "run signed corgi");
        signed_run.addFileArg(signed);
        break :blk signed_run;
    } else blk: {
        b.installArtifact(exe);
        break :blk b.addRunArtifact(exe);
    };
    if (b.args) |args| run.addArgs(args);
    b.step("run", "Run Corgi").dependOn(&run.step);
    const test_filters = b.option([][]const u8, "test-filter", "Only run Zig tests whose names contain this; repeatable") orelse &.{};
    const tests = b.addTest(.{ .root_module = mod, .filters = test_filters });
    b.step("test", "Test layouts, hooks, signaling and terminal behavior").dependOn(&b.addRunArtifact(tests).step);

    // Opt-in live eval driver shares the production prompt, parser and harness.
    const eval_backend = b.createModule(.{ .root_source_file = b.path("src/summary_backend.zig"), .target = target, .optimize = optimize, .link_libc = true });
    eval_backend.addImport("ghostty-vt", ghostty.module("ghostty-vt"));
    eval_backend.addOptions("corgi_options", options);
    if (target.result.os.tag == .macos) {
        if (b.sysroot) |sdk| {
            eval_backend.addSystemFrameworkPath(.{ .cwd_relative = b.pathJoin(&.{ sdk, "System/Library/Frameworks" }) });
            eval_backend.addSystemIncludePath(.{ .cwd_relative = b.pathJoin(&.{ sdk, "usr/include" }) });
        }
        eval_backend.linkFramework("Security", .{});
        eval_backend.linkFramework("CoreFoundation", .{});
    }
    const eval_mod = b.createModule(.{ .root_source_file = b.path("evals/driver.zig"), .target = target, .optimize = optimize, .link_libc = true });
    eval_mod.addImport("backend", eval_backend);
    const eval_exe = b.addExecutable(.{ .name = "corgi-eval", .root_module = eval_mod });
    b.step("evals", "Build the activity eval driver (does not call models)").dependOn(&b.addInstallArtifact(eval_exe, .{}).step);

    // Real external runtimes are opt-in, never dependencies of the unit suite.
    const handoff = b.addSystemCommand(&.{ "bun", "run" });
    handoff.addFileArg(b.path("tests/run.ts"));
    handoff.addArg("herdr_handoff");
    handoff.addArg("--corgi");
    handoff.addArtifactArg(exe);
    if (b.option([]const u8, "herdr-bin", "Herdr executable for test-handoff (default: HERDR_TEST_BIN or PATH)")) |herdr| {
        handoff.addArgs(&.{ "--herdr", herdr });
    }
    if (b.args) |args| {
        handoff.addArg("--");
        handoff.addArgs(args);
    }
    handoff.setCwd(b.path("."));
    handoff.has_side_effects = true;
    b.step("test-handoff", "Run slow Herdr migration integration tests in disposable runtimes").dependOn(&handoff.step);
}

/// sentry-native with its in-process crash handler and no transport of its
/// own; src/crash.zig sends reports with curl.
fn sentryLibrary(b: *std.Build, target: std.Build.ResolvedTarget, optimize: std.builtin.OptimizeMode) *std.Build.Step.Compile {
    const upstream = b.dependency("sentry", .{});
    const lib = b.addLibrary(.{
        .name = "sentry",
        .linkage = .static,
        .root_module = b.createModule(.{ .target = target, .optimize = optimize, .link_libc = true }),
    });
    if (target.result.os.tag == .macos) if (b.sysroot) |sdk| {
        lib.root_module.addSystemIncludePath(.{ .cwd_relative = b.pathJoin(&.{ sdk, "usr/include" }) });
    };
    const flags: []const []const u8 = &.{
        "-DSENTRY_BUILD_STATIC",
        "-DSENTRY_BACKEND_INPROC",
        "-DSENTRY_WITH_UNWINDER_LIBBACKTRACE",
        "-include",
        b.pathFromRoot("src/sentry_cloexec.h"),
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
/// Development builds identify their checkout, marking uncommitted changes.
fn gitCommit(b: *std.Build) []const u8 {
    var code: u8 = 0;
    const head = b.runAllowFail(&.{ "git", "-C", b.pathFromRoot("."), "rev-parse", "HEAD" }, &code, .ignore) catch return "development";
    const commit = std.mem.trim(u8, head, " \r\n\t");
    const status = b.runAllowFail(&.{ "git", "-C", b.pathFromRoot("."), "status", "--porcelain" }, &code, .ignore) catch return commit;
    return if (std.mem.trim(u8, status, " \r\n\t").len > 0) b.fmt("{s}-dirty", .{commit}) else commit;
}
