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
    const package = @import("build.zig.zon");
    options.addOption(u64, "terminal_checkpoint_abi", std.hash.Wyhash.hash(0, package.dependencies.ghostty.hash));
    options.addOption([]const u8, "release_version", b.option([]const u8, "release-version", "Release version") orelse "0.1.0-dev");
    options.addOption([]const u8, "release_commit", b.option([]const u8, "release-commit", "Source commit") orelse gitCommit(b));
    options.addOption([]const u8, "update_url", b.option([]const u8, "update-url", "HTTPS update feed base URL") orelse "");
    options.addOption([]const u8, "update_public_key", b.option([]const u8, "update-public-key", "Ed25519 public key, hex") orelse "");
    options.addOption(bool, "update_test_mode", b.option(bool, "update-test-mode", "Allow local HTTP update fixtures (never publish)") orelse false);
    options.addOption(bool, "check_leaks", b.option(bool, "check-leaks", "Unit tests use the leak-checking allocator everywhere") orelse false);
    mod.addOptions("corgi_options", options);
    const exe = b.addExecutable(.{ .name = "corgi", .root_module = mod });
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

/// Development builds identify their checkout, marking uncommitted changes.
fn gitCommit(b: *std.Build) []const u8 {
    var code: u8 = 0;
    const head = b.runAllowFail(&.{ "git", "-C", b.pathFromRoot("."), "rev-parse", "HEAD" }, &code, .Ignore) catch return "development";
    const commit = std.mem.trim(u8, head, " \r\n\t");
    const status = b.runAllowFail(&.{ "git", "-C", b.pathFromRoot("."), "status", "--porcelain" }, &code, .Ignore) catch return commit;
    return if (std.mem.trim(u8, status, " \r\n\t").len > 0) b.fmt("{s}-dirty", .{commit}) else commit;
}
