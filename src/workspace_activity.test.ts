import { test, expect, describe } from "bun:test";
import * as activity from "./workspace_activity";

const min = activity.minute_ms;
const on = { ...activity.defaults, enabled: true };

describe("parse", () => {
  test("missing keys take the defaults, and auto-order is off", () => {
    expect(activity.parse({})).toEqual(activity.defaults);
  });
  test("a malformed key takes its own default", () => {
    for (const bad of [0, -3, 2.5, "10", null, true])
      expect(
        activity.parse({
          workspace_auto_order: true,
          workspace_pause_after: 2,
          workspace_stale_after: bad,
          workspace_archive_after: 60,
        }),
      ).toEqual({ enabled: true, pause_after: 2, stale_after: 10, archive_after: 60 });
  });
  test("archive after takes off or a whole number of minutes", () => {
    expect(activity.parse({ workspace_archive_after: "off" }).archive_after).toBeNull();
    expect(activity.parse({ workspace_archive_after: 1440 }).archive_after).toBe(1440);
    expect(activity.parse({ workspace_archive_after: "Off" }).archive_after).toBe(480);
    expect(activity.parse({ workspace_archive_after: 0 }).archive_after).toBe(480);
  });
  test("thresholds out of order all take their defaults", () => {
    expect(
      activity.parse({
        workspace_auto_order: true,
        workspace_pause_after: 10,
        workspace_stale_after: 5,
        workspace_archive_after: 60,
      }),
    ).toEqual({ ...activity.defaults, enabled: true });
    expect(activity.parse({ workspace_stale_after: 600 })).toEqual(activity.defaults);
    expect(activity.parse({ workspace_stale_after: 600, workspace_archive_after: "off" })).toEqual({
      ...activity.defaults,
      stale_after: 600,
      archive_after: null,
    });
  });
  test("only true switches it on", () => {
    expect(activity.parse({ workspace_auto_order: "true" }).enabled).toBe(false);
    expect(activity.parse({ workspace_auto_order: 1 }).enabled).toBe(false);
  });
  test("the file form reads back", () => {
    const s = { enabled: true, pause_after: 1, stale_after: 3, archive_after: null };
    expect(activity.parse(activity.toFile(s))).toEqual(s);
    expect(activity.toFile(s).workspace_archive_after).toBe("off");
  });
  test("valid checks the order and whole minutes", () => {
    expect(activity.valid(activity.defaults)).toBe(true);
    expect(activity.valid({ ...activity.defaults, pause_after: 10 })).toBe(false);
    expect(activity.valid({ ...activity.defaults, stale_after: 480 })).toBe(false);
    expect(activity.valid({ ...activity.defaults, stale_after: 480, archive_after: null })).toBe(true);
    expect(activity.valid({ ...activity.defaults, pause_after: 0 })).toBe(false);
  });
});

describe("configure", () => {
  const none = { enabled: null, pause_after: null, stale_after: null, archive_after: null };
  test("changes only what the request names; archive 0 means Off", () => {
    expect(activity.configure(activity.defaults, none)).toEqual(activity.defaults);
    expect(activity.configure(activity.defaults, { ...none, enabled: true, stale_after: 30 })).toEqual({
      ...activity.defaults,
      enabled: true,
      stale_after: 30,
    });
    expect(activity.configure(activity.defaults, { ...none, archive_after: 0 })?.archive_after).toBeNull();
    expect(activity.wire({ ...activity.defaults, archive_after: null }).archive_after).toBe(0);
  });
  test("refuses thresholds out of order or zero", () => {
    expect(activity.configure(activity.defaults, { ...none, pause_after: 10 })).toBeNull();
    expect(activity.configure(activity.defaults, { ...none, stale_after: 480 })).toBeNull();
    expect(activity.configure(activity.defaults, { ...none, pause_after: 0 })).toBeNull();
    expect(activity.configure(activity.defaults, { ...none, stale_after: 600, archive_after: 0 })).toEqual({
      ...activity.defaults,
      stale_after: 600,
      archive_after: null,
    });
  });
});

describe("Clock", () => {
  const pause = 5 * min;
  const run = (c: activity.Clock, from: number, to: number, active: boolean) => {
    for (let t = from + 250; t <= to; t += 250) {
      if (active) c.worked(t);
      c.advance(t, pause);
    }
  };
  test("runs one for one while someone works", () => {
    const c = new activity.Clock(0);
    c.worked(0);
    run(c, 0, 10 * min, true);
    expect(c.reading).toBe(10 * min);
  });
  test("a long quiet period adds exactly pause after", () => {
    const c = new activity.Clock(0);
    c.worked(0);
    run(c, 0, 2 * min, true);
    run(c, 2 * min, 62 * min, false);
    expect(c.reading).toBe(7 * min);
    expect(c.paused(62 * min, pause)).toBe(true);
    c.worked(62 * min);
    run(c, 62 * min, 63 * min, false);
    expect(c.reading).toBe(8 * min);
  });
  test("a sleep between two ticks adds at most the cap", () => {
    const c = new activity.Clock(0);
    c.worked(0);
    c.advance(10 * 60 * min, pause);
    expect(c.reading).toBe(activity.tick_cap_ms);
    c.worked(20 * 60 * min);
    c.advance(30 * 60 * min, pause);
    expect(c.reading).toBe(2 * activity.tick_cap_ms);
  });
  test("a wall clock set back doesn't hold the pause off", () => {
    const c = new activity.Clock(0);
    c.worked(0);
    run(c, 0, 1 * min, false);
    // Set back an hour: the pause still starts five minutes past the activity.
    run(c, -60 * min, 0, false);
    expect(c.reading).toBe(5 * min);
    // Activity right after a jump back counts from then, not an hour before.
    c.worked(-120 * min);
    run(c, -120 * min, -110 * min, false);
    expect(c.reading).toBe(10 * min);
  });
  test("a fresh clock waits for activity", () => {
    const c = new activity.Clock(1000);
    c.reading = 42;
    c.advance(5000, pause);
    expect(c.reading).toBe(42);
    expect(c.paused(5000, pause)).toBe(true);
    c.worked(5000);
    c.advance(6000, pause);
    expect(c.reading).toBe(1042);
  });
});

describe("step", () => {
  test("defaults step at 10 min, about 26, 69 and 182 min, and 8 h", () => {
    const b = activity.boundaries(activity.defaults).map(ms => ms / min);
    expect(b[0]).toBe(10);
    expect(Math.round(b[1])).toBe(26);
    expect(Math.round(b[2])).toBe(69);
    expect(Math.round(b[3])).toBe(182);
    expect(b[4]).toBe(480);
    const s = activity.defaults;
    expect(activity.step(10 * min, s)).toBe(0);
    expect(activity.step(10 * min + 1, s)).toBe(1);
    expect(activity.step(25 * min, s)).toBe(1);
    expect(activity.step(27 * min, s)).toBe(2);
    expect(activity.step(70 * min, s)).toBe(3);
    expect(activity.step(183 * min, s)).toBe(4);
    expect(activity.step(479 * min, s)).toBe(4);
    expect(activity.step(480 * min, s)).toBe(5);
    expect(activity.step(5000 * min, s)).toBe(5);
  });
  test("with archive Off the fade ends 8 h past stale after", () => {
    const s = { ...activity.defaults, stale_after: 600, archive_after: null };
    expect(activity.boundaries(s)[4]).toBe(1080 * min);
    expect(activity.step(1079 * min, s)).toBe(4);
    expect(activity.step(1080 * min, s)).toBe(5);
  });
  test("never gets lighter as idle time grows", () => {
    let last = 0;
    for (let t = 0; t < 600 * min; t += 17_000) {
      const n = activity.step(t, activity.defaults);
      expect(n).toBeGreaterThanOrEqual(last);
      last = n;
    }
    expect(last).toBe(5);
  });
});

describe("regroup", () => {
  const ws = (id: number, active_at: number, group: activity.Group = "active", archived = false): activity.Item => ({
    id,
    archived,
    active_at,
    group,
  });
  const ids = (items: activity.Item[]) => items.map(w => w.id);
  const clock = 100 * min;
  test("active ones keep their order while their activity changes", () => {
    const items = [ws(1, clock - 1 * min), ws(2, clock - 9 * min), ws(3, clock - 5 * min)];
    expect(activity.regroup(items, clock, on)).toBe(false);
    items[1].active_at = clock;
    expect(activity.regroup(items, clock, on)).toBe(false);
    for (let i = 0; i < 50; i++) activity.regroup(items, clock + i, on);
    expect(ids(items)).toEqual([1, 2, 3]);
  });
  test("a quiet one goes below every active one, and the rest keep their order", () => {
    const items = [ws(1, clock), ws(3, clock - 11 * min), ws(2, clock)];
    expect(activity.regroup(items, clock, on)).toBe(true);
    expect(ids(items)).toEqual([1, 2, 3]);
    expect(items[2].group).toBe("stale");
  });
  test("stale ones sort by idle time, ties keep their order", () => {
    const items = [
      ws(5, clock - 120 * min, "stale"),
      ws(1, clock),
      ws(6, clock - 30 * min, "stale"),
      ws(7, clock - 30 * min, "stale"),
      ws(4, clock - 30 * min, "stale"),
    ];
    activity.regroup(items, clock, on);
    expect(ids(items)).toEqual([1, 6, 7, 4, 5]);
  });
  test("a stale one waking goes to the end of the active group", () => {
    const items = [ws(1, clock), ws(2, clock), ws(6, clock - 30 * min, "stale"), ws(5, clock - 60 * min, "stale")];
    activity.regroup(items, clock, on);
    items[3].active_at = clock;
    expect(activity.regroup(items, clock, on)).toBe(true);
    expect(ids(items)).toEqual([1, 2, 5, 6]);
    expect(items[2].group).toBe("active");
  });
  test("a waking one goes after active ones placed after it", () => {
    const items = [ws(9, clock - 30 * min, "stale"), ws(1, clock), ws(2, clock)];
    items[0].active_at = clock;
    activity.regroup(items, clock, on);
    expect(ids(items)).toEqual([1, 2, 9]);
  });
  test("new and unarchived ones join the end of the active group, archived ones go last", () => {
    const items = [
      ws(1, clock),
      ws(8, clock - 50 * min, "stale", true),
      ws(6, clock - 30 * min, "stale"),
      ws(3, clock - 300 * min, "stale"),
    ];
    activity.regroup(items, clock, on);
    expect(ids(items)).toEqual([1, 6, 3, 8]);
    // Unarchived with fresh activity.
    items[3].archived = false;
    items[3].active_at = clock;
    activity.regroup(items, clock, on);
    expect(ids(items)).toEqual([1, 8, 6, 3]);
    // A brand-new one, first seen.
    items.push(ws(4, 0));
    activity.regroup(items, clock, on);
    expect(ids(items)).toEqual([1, 8, 4, 6, 3]);
    expect(items[2].active_at).toBe(clock);
  });
  test("a first-seen one is neither stale nor archived at once", () => {
    const items = [ws(1, 0, "stale")];
    activity.regroup(items, clock, on);
    expect(items[0]).toMatchObject({ active_at: clock, group: "active" });
  });
  test("switching on keeps the active ones in their relative order", () => {
    const items = [ws(1, clock - 40 * min), ws(2, clock), ws(3, clock - 20 * min), ws(4, clock - 1 * min)];
    activity.resync(items, clock, on);
    expect(ids(items)).toEqual([1, 2, 3, 4]);
    expect(items.map(w => w.group)).toEqual(["stale", "active", "stale", "active"]);
    activity.regroup(items, clock, on);
    expect(ids(items)).toEqual([2, 4, 3, 1]);
  });
});

describe("moveAllowed", () => {
  const items: activity.Item[] = [
    { id: 1, archived: false, active_at: 0, group: "active" },
    { id: 2, archived: false, active_at: 0, group: "active" },
    { id: 3, archived: false, active_at: 0, group: "stale" },
    { id: 4, archived: false, active_at: 0, group: "stale" },
    { id: 5, archived: true, active_at: 0, group: "active" },
  ];
  test("within the active group", () => {
    expect(activity.moveAllowed(items, 2, 1, true)).toBe(true);
    expect(activity.moveAllowed(items, 1, 2, true)).toBe(true);
  });
  test("the slot after the last active one belongs to the active group", () => {
    expect(activity.moveAllowed(items, 1, 3, true)).toBe(true);
  });
  test("below the first stale one is refused", () => {
    expect(activity.moveAllowed(items, 1, 4, true)).toBe(false);
    expect(activity.moveAllowed(items, 1, 5, true)).toBe(false);
    expect(activity.moveAllowed(items, 1, 1, true)).toBe(false);
  });
  test("a stale one can't move", () => {
    expect(activity.moveAllowed(items, 3, 1, true)).toBe(false);
    expect(activity.moveAllowed(items, 4, 3, true)).toBe(false);
  });
  test("last is fine without stale ones", () => {
    expect(activity.moveAllowed(items.slice(0, 2), 1, 1, true)).toBe(true);
  });
  test("anything goes with auto-order off", () => {
    expect(activity.moveAllowed(items, 3, 1, false)).toBe(true);
    expect(activity.moveAllowed(items, 1, 1, false)).toBe(true);
  });
});

describe("activity of agents", () => {
  test("only a turn being processed counts", () => {
    const a = { state: "working" as const, paused: false, attention: "none" as const };
    expect(activity.working(a)).toBe(true);
    expect(activity.working({ ...a, paused: true })).toBe(false);
    expect(activity.working({ ...a, attention: "needs_input" })).toBe(false);
    for (const state of ["blocked", "idle", "initializing", "unknown", "done"] as const)
      expect(activity.working({ ...a, state })).toBe(false);
  });
  test("waiting means blocked or asking", () => {
    expect(activity.waiting({ state: "blocked", attention: "none" })).toBe(true);
    expect(activity.waiting({ state: "working", attention: "needs_input" })).toBe(true);
    expect(activity.waiting({ state: "idle", attention: "finished" })).toBe(false);
  });
});

describe("auto-archive", () => {
  const s = { ...on, archive_after: 60 };
  const w = (idle: number, group: activity.Group = "stale"): activity.Item => ({
    id: 1,
    archived: false,
    active_at: 1000 * min - idle,
    group,
  });
  test("due once idle reaches archive after and the guard has passed", () => {
    expect(activity.due(w(60 * min), 1000 * min, 0, s)).toBe(true);
    expect(activity.due(w(59 * min), 1000 * min, 0, s)).toBe(false);
    expect(activity.due(w(60 * min), 1000 * min, 1001 * min, s)).toBe(false);
    expect(activity.due(w(60 * min, "active"), 1000 * min, 0, s)).toBe(false);
    expect(activity.due({ ...w(60 * min), archived: true }, 1000 * min, 0, s)).toBe(false);
    expect(activity.due(w(60 * min), 1000 * min, 0, { ...s, archive_after: null })).toBe(false);
    expect(activity.due(w(60 * min), 1000 * min, 0, { ...s, enabled: false })).toBe(false);
  });
  const clear: activity.Facts = {
    others: true,
    on_screen: false,
    waiting: false,
    inventory: () => ({ processes: 0, available: true, partial: false }),
    served: () => false,
  };
  test("each blocker, first match first", () => {
    expect(activity.blocker(clear)).toBeNull();
    expect(activity.blocker({ ...clear, others: false, on_screen: true })).toBe("last-workspace");
    expect(activity.blocker({ ...clear, on_screen: true, waiting: true })).toBe("on-screen");
    expect(activity.blocker({ ...clear, waiting: true })).toBe("waiting-agent");
    expect(activity.blocker({ ...clear, inventory: () => ({ processes: 2, available: false, partial: false }) })).toBe(
      "process-list-unavailable",
    );
    expect(activity.blocker({ ...clear, inventory: () => ({ processes: 0, available: true, partial: true }) })).toBe(
      "process-list-partial",
    );
    expect(activity.blocker({ ...clear, inventory: () => ({ processes: 1, available: true, partial: false }) })).toBe(
      "running-process",
    );
    expect(activity.blocker({ ...clear, served: () => true })).toBe("served-link");
  });
  test("the process list is read only when nothing cheaper blocks", () => {
    let read = 0;
    activity.blocker({
      ...clear,
      on_screen: true,
      inventory: () => {
        read++;
        return { processes: 0, available: true, partial: false };
      },
    });
    expect(read).toBe(0);
  });
  test("a reason is reported once per workspace until cleared", () => {
    const r = new activity.Reported();
    expect(r.report(1, "on-screen")).toBe(true);
    expect(r.report(1, "on-screen")).toBe(false);
    expect(r.report(2, "on-screen")).toBe(true);
    expect(r.report(1, "running-process")).toBe(true);
    // A reason that comes back after another is still logged only once.
    expect(r.report(1, "on-screen")).toBe(false);
    r.clear(1);
    expect(r.report(1, "on-screen")).toBe(true);
    r.retain(id => id !== 2);
    expect(r.report(2, "on-screen")).toBe(true);
    expect(r.report(1, "on-screen")).toBe(false);
  });
  test("the quick blockers need no process list", () => {
    const unread: activity.Facts = {
      ...clear,
      inventory: () => {
        throw Error("read");
      },
      served: () => {
        throw Error("read");
      },
    };
    expect(activity.quickBlocker(unread)).toBeNull();
    expect(activity.quickBlocker({ ...unread, others: false })).toBe("last-workspace");
    expect(activity.quickBlocker({ ...unread, on_screen: true })).toBe("on-screen");
    expect(activity.quickBlocker({ ...unread, waiting: true })).toBe("waiting-agent");
  });
  test("the guard arms on switch-on, a lower archive after and leaving Off", () => {
    const clock = 500 * min;
    expect(activity.armGuard(null, s, clock)).toBe(clock + 60 * min);
    expect(activity.armGuard({ enabled: false, archive_after: 60 }, s, clock)).toBe(clock + 60 * min);
    expect(activity.armGuard({ enabled: true, archive_after: 480 }, s, clock)).toBe(clock + 60 * min);
    expect(activity.armGuard({ enabled: true, archive_after: null }, s, clock)).toBe(clock + 60 * min);
    expect(activity.armGuard({ enabled: true, archive_after: 60 }, s, clock)).toBeNull();
    expect(activity.armGuard({ enabled: true, archive_after: 30 }, s, clock)).toBeNull();
    expect(activity.armGuard({ enabled: true, archive_after: 60 }, { ...s, enabled: false }, clock)).toBeNull();
    expect(activity.armGuard(null, { ...s, archive_after: null }, clock)).toBeNull();
  });
});

describe("typing", () => {
  test("mouse and focus reports alone aren't typing", () => {
    for (const report of ["\x1b[M !!", "\x1b[32;10;5M", "\x1b[<0;1;1M\x1b[I", "\x1b[<65;3;4m", "\x1b[O"])
      expect(activity.typing(report)).toBe(false);
  });
  test("keys are, alone or beside a report", () => {
    for (const keys of ["a", "\x1b[A", "\x1b[Ia", "\r"]) expect(activity.typing(keys)).toBe(true);
  });
});
describe("restore", () => {
  const restored = (saved: unknown) => {
    const r = {
      work_clock: new activity.Clock(0),
      guard_settings: { enabled: true, archive_after: 60 } as activity.Applied | null,
    };
    activity.restore(r, saved);
    return { clock: r.work_clock.reading, guard: r.work_clock.guard, applied: r.guard_settings };
  };
  test("anything malformed starts over", () => {
    expect(restored({ clock: "x", guard: -5, applied: { enabled: "yes" } })).toEqual({
      clock: 0,
      guard: 0,
      applied: null,
    });
    expect(restored("garbage")).toEqual({ clock: 0, guard: 0, applied: null });
    expect(restored(null)).toEqual({ clock: 0, guard: 0, applied: null });
    expect(restored({ clock: 1.5, guard: 20 })).toEqual({ clock: 0, guard: 20, applied: null });
  });
  test("a saved archive after of 0 or malformed is Off", () => {
    expect(restored({ clock: 10, guard: 20, applied: { enabled: true, archive_after: 0 } })).toEqual({
      clock: 10,
      guard: 20,
      applied: { enabled: true, archive_after: null },
    });
    expect(restored({ clock: 10, guard: 20, applied: { enabled: false, archive_after: 2.5 } }).applied).toEqual({
      enabled: false,
      archive_after: null,
    });
    expect(
      restored(
        activity.save({
          work_clock: Object.assign(new activity.Clock(0), { reading: 7, guard: 9 }),
          guard_settings: { enabled: true, archive_after: 120 },
        }),
      ),
    ).toEqual({
      clock: 7,
      guard: 9,
      applied: { enabled: true, archive_after: 120 },
    });
  });
  test("a live handoff keeps the pause where it was; a cold start counts as paused", () => {
    const pause = 5 * min,
      old = new activity.Clock(0);
    old.worked(10 * min);
    const owner = (c: activity.Clock) => ({ work_clock: c, guard_settings: null }),
      cold = activity.save(owner(old)),
      live = activity.save(owner(old), 12 * min);
    expect(cold.since_activity).toBeNull();
    expect(live.since_activity).toBe(2 * min);
    expect(activity.save(owner(new activity.Clock(0)), 12 * min).since_activity).toBeNull();
    // Taken up on another timeline: 2 minutes in, the clock runs 3 more.
    const handed = owner(new activity.Clock(500 * min));
    activity.restore(handed, JSON.parse(JSON.stringify(live)), 500 * min);
    expect(handed.work_clock.last_activity).toBe(498 * min);
    expect(handed.work_clock.paused(500 * min, pause)).toBe(false);
    for (let t = 500 * min + 250; t <= 510 * min; t += 250) handed.work_clock.advance(t, pause);
    expect(handed.work_clock.reading).toBe(3 * min);
    // A cold start, or a checkpoint that didn't keep it, starts paused.
    for (const [saved, at] of [
      [live, null],
      [cold, 500 * min],
      [{ ...live, since_activity: -1 }, 500 * min],
      [{ ...live, since_activity: "2m" }, 500 * min],
    ] as const) {
      const r = owner(new activity.Clock(500 * min));
      activity.restore(r, saved, at);
      expect(r.work_clock.last_activity).toBeNull();
    }
  });
});
