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
    const native_macos = @import("builtin").os.tag == .macos and target.result.os.tag == .macos;
    const codesign = b.option(bool, "codesign", "Sign macOS builds with a persistent Keychain identity") orelse native_macos;
    const run = if (codesign and native_macos) blk: {
        const identity = b.option([]const u8, "signing-identity", "Code-signing certificate name or SHA-1") orelse
            std.mem.trim(u8, b.run(&.{ "/bin/sh", b.pathFromRoot("scripts/sign-macos"), "--identity" }), " \r\n\t");
        const sign = b.addSystemCommand(&.{"/bin/sh"});
        sign.addFileArg(b.path("scripts/sign-macos"));
        sign.addArg(identity);
        sign.addFileArg(exe.getEmittedBin());
        const signed = sign.addOutputFileArg("corgi");
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
    const tests = b.addTest(.{ .root_module = mod });
    b.step("test", "Test layouts, hooks, signaling and terminal behavior").dependOn(&b.addRunArtifact(tests).step);
}
