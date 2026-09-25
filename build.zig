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
        mod.linkFramework("Security", .{});
        mod.linkFramework("CoreFoundation", .{});
    }
    const options = b.addOptions();
    options.addOption(bool, "viewer_test_driver", b.option(bool, "viewer-test-driver", "Enable stdio viewer integration harness") orelse false);
    options.addOption(u64, "terminal_checkpoint_abi", std.hash.Wyhash.hash(0, @embedFile("build.zig.zon")));
    mod.addOptions("corgi_options", options);
    const exe = b.addExecutable(.{ .name = "corgi", .root_module = mod });
    b.installArtifact(exe);
    const run = b.addRunArtifact(exe);
    if (b.args) |args| run.addArgs(args);
    b.step("run", "Run Corgi").dependOn(&run.step);
    const tests = b.addTest(.{ .root_module = mod });
    b.step("test", "Test layouts, hooks, signaling and terminal behavior").dependOn(&b.addRunArtifact(tests).step);
}
