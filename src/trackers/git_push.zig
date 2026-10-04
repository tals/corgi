//! Daemon-owned pushes. Each job freezes the previewed ref and runs without a
//! shell; viewers only start jobs and display their shared status.
const std = @import("std");
const os = @import("../os.zig");
const a = os.allocator;
const git = @import("git_status.zig");
const WorkspaceId = @import("../workspace.zig").Workspace.Id;
const clock = @import("../clock.zig");
const BoundedText = @import("../bounded_text.zig").BoundedText;
const subprocess = @import("../subprocess.zig");

/// Shared with controller.zig's gitPushMessage, whichever side rejected the push.
pub const preview_changed = "Branch, commits, or upstream changed. Review the refreshed preview and retry.";
pub const Phase = enum { idle, pushing, succeeded, failed };
pub const View = struct { phase: Phase = .idle, message: []const u8 = "" };
pub const State = struct {
    phase: Phase = .idle,
    operation: u64 = 0,
    message: BoundedText(2048) = .{},
    until: i64 = 0,
    pub fn view(s: *const State) View {
        return .{ .phase = s.phase, .message = s.message.text() };
    }
};
pub const RefView = struct {
    root: []const u8 = "",
    head: []const u8 = "",
    branch: []const u8 = "",
    remote: []const u8 = "",
    destination: []const u8 = "",
    pub fn sameBranch(lhs: RefView, rhs: RefView) bool {
        return std.mem.eql(u8, lhs.root, rhs.root) and std.mem.eql(u8, lhs.branch, rhs.branch) and std.mem.eql(u8, lhs.remote, rhs.remote) and std.mem.eql(u8, lhs.destination, rhs.destination);
    }
    pub fn eql(lhs: RefView, rhs: RefView) bool {
        return lhs.sameBranch(rhs) and std.mem.eql(u8, lhs.head, rhs.head);
    }
};
pub const Ref = struct {
    root: BoundedText(std.fs.max_path_bytes) = .{},
    head: BoundedText(64) = .{},
    branch: BoundedText(1024) = .{},
    remote: BoundedText(1024) = .{},
    destination: BoundedText(1024) = .{},
    /// Empty when any part does not fit.
    pub fn init(root: []const u8, head: []const u8, branch: []const u8, remote: []const u8, destination: []const u8) Ref {
        return exact(root, head, branch, remote, destination) catch .{};
    }
    fn exact(root: []const u8, head: []const u8, branch: []const u8, remote: []const u8, destination: []const u8) error{TooLong}!Ref {
        return .{ .root = try .init(root), .head = try .init(head), .branch = try .init(branch), .remote = try .init(remote), .destination = try .init(destination) };
    }
    pub fn view(r: *const Ref) RefView {
        return .{
            .root = r.root.text(),
            .head = r.head.text(),
            .branch = r.branch.text(),
            .remote = r.remote.text(),
            .destination = r.destination.text(),
        };
    }
};

pub const Manager = struct {
    jobs: [32]?*Job = @splat(null),
    next_id: u64 = 1,
    pub fn busy(m: *const Manager) bool {
        for (m.jobs) |job| if (job != null) return true;
        return false;
    }
    pub fn deinit(m: *Manager) void {
        for (&m.jobs) |*slot| if (slot.*) |job| {
            job.quit.signal();
            job.thread.?.join();
            job.quit.deinit();
            a.destroy(job);
            slot.* = null;
        };
    }
    pub fn start(m: *Manager, store: anytype, id: WorkspaceId, expected: RefView) !void {
        const ws = store.get(id) orelse return error.NoWorkspace;
        const ref = ws.git_ref.view();
        if (!ref.eql(expected)) return error.GitPreviewChanged;
        if (ref.head.len == 0 or ref.branch.len == 0 or (ws.git_ahead orelse 0) == 0) return error.NothingToPush;
        for (m.jobs) |slot| if (slot) |job| {
            // Different workspaces/viewers of one checkout share the job.
            if (std.mem.eql(u8, job.ref.view().root, ref.root)) {
                if (!job.ref.view().eql(ref)) return error.GitPushInProgress;
                for (store.items.items) |*other| if (std.mem.eql(u8, other.git_ref.view().root, ref.root)) {
                    other.git_push = .{ .phase = .pushing, .operation = job.id };
                };
                return;
            }
        };
        const slot = for (&m.jobs) |*slot| {
            if (slot.* == null) break slot;
        } else return error.TooManyPushes;
        const job = try a.create(Job);
        errdefer a.destroy(job);
        job.* = .{ .ref = ws.git_ref, .id = m.next_id, .quit = try .init() };
        errdefer job.quit.deinit();
        m.next_id += 1;
        slot.* = job;
        errdefer slot.* = null;
        job.thread = try std.Thread.spawn(.{}, Job.run, .{job});
        for (store.items.items) |*other| if (std.mem.eql(u8, other.git_ref.view().root, ref.root)) {
            other.git_push = .{ .phase = .pushing, .operation = job.id };
        };
    }
    pub fn tick(m: *Manager, store: anytype, tracker: *git.Tracker) bool {
        var changed = false;
        const now = clock.milliTimestamp();
        for (&m.jobs) |*slot| if (slot.*) |job| {
            if (!job.done.load(.acquire)) continue;
            job.thread.?.join();
            job.quit.deinit();
            for (store.items.items) |*ws| if (ws.git_push.operation == job.id) {
                ws.git_push = job.result;
                ws.git_push.until = now + 1600;
            };
            a.destroy(job);
            slot.* = null;
            tracker.next_refresh = 0;
            changed = true;
        };
        for (store.items.items) |*ws| if (ws.git_push.phase == .succeeded and now >= ws.git_push.until) {
            ws.git_push = .{};
            changed = true;
        };
        return changed;
    }
};

const Job = struct {
    id: u64,
    ref: Ref,
    thread: ?std.Thread = null,
    done: std.atomic.Value(bool) = .init(false),
    quit: subprocess.Quit = .{},
    result: State = .{},

    fn run(j: *Job) void {
        defer j.done.store(true, .release);
        j.push() catch |err| {
            j.result.phase = .failed;
            if (j.result.message.len == 0) j.result.message = git.cleaned(@TypeOf(j.result.message), switch (err) {
                error.GitPreviewChanged => preview_changed,
                error.NoPushDestination => "No remote tracking branch. Configure an upstream in your terminal, then retry.",
                error.TimedOut => "Push timed out. Check authentication and the remote in your terminal, then retry.",
                else => @errorName(err),
            });
            return;
        };
        j.result = .{ .phase = .succeeded };
    }
    fn push(j: *Job) !void {
        const ref = j.ref.view();
        const head = try j.command(&.{ "rev-parse", "--verify", "HEAD" }, false);
        defer a.free(head);
        const branch = try j.command(&.{ "symbolic-ref", "--quiet", "HEAD" }, false);
        defer a.free(branch);
        if (!std.mem.eql(u8, head, ref.head) or !std.mem.eql(u8, branch, ref.branch)) return error.GitPreviewChanged;
        if (!std.mem.startsWith(u8, branch, "refs/heads/")) return error.NoPushDestination;
        const remote_key = try std.fmt.allocPrint(a, "branch.{s}.remote", .{branch[11..]});
        defer a.free(remote_key);
        const merge_key = try std.fmt.allocPrint(a, "branch.{s}.merge", .{branch[11..]});
        defer a.free(merge_key);
        const remote = j.command(&.{ "config", "--get", remote_key }, false) catch return error.NoPushDestination;
        defer a.free(remote);
        const destination = j.command(&.{ "config", "--get", merge_key }, false) catch return error.NoPushDestination;
        defer a.free(destination);
        if (!std.mem.eql(u8, remote, ref.remote) or !std.mem.eql(u8, destination, ref.destination)) return error.GitPreviewChanged;
        if (remote.len == 0 or !std.mem.startsWith(u8, destination, "refs/heads/")) return error.NoPushDestination;
        const refspec = try std.fmt.allocPrint(a, "{s}:{s}", .{ ref.head, destination });
        defer a.free(refspec);
        const no_mirror = try std.fmt.allocPrint(a, "remote.{s}.mirror=false", .{remote});
        defer a.free(no_mirror);
        // Explicit refspec avoids configured matching/all-branch pushes, and a
        // frozen object id cannot accidentally include commits made after click.
        const result = try j.command(&.{ "-c", no_mirror, "push", "--porcelain", "--no-force", "--no-mirror", "--no-follow-tags", "--recurse-submodules=no", "--", remote, refspec }, true);
        a.free(result);
    }
    fn command(j: *Job, args: []const []const u8, pushing: bool) ![]u8 {
        var argv: std.ArrayList([]const u8) = .empty;
        defer argv.deinit(a);
        try argv.appendSlice(a, &.{ "git", "-c", "core.askPass=", "-c", "credential.interactive=false", "-C", j.ref.view().root });
        try argv.appendSlice(a, args);
        var env = try os.environMap(a);
        defer env.deinit();
        try env.put("GIT_TERMINAL_PROMPT", "0");
        try env.put("GCM_INTERACTIVE", "Never");
        const out = try subprocess.run(a, argv.items, .{
            .env = &env,
            .timeout_ms = if (pushing) 120000 else 5000,
            .max_output = 16384,
            .stderr = true,
            .quit = &j.quit,
        });
        defer out.deinit(a);
        if (!out.ok()) {
            if (pushing) {
                const message = if (out.stderr.len > 0) out.stderr else out.stdout;
                j.result.message = git.cleaned(@TypeOf(j.result.message), std.mem.trim(u8, message, " \t\r\n"));
            }
            return error.GitPushFailed;
        }
        return a.dupe(u8, std.mem.trim(u8, out.stdout, " \t\r\n"));
    }
};
