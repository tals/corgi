import { test, expect } from "bun:test";
import { Presence } from "./presence";

const viewer = (viewer_id: number, active_seq: number, view_focus: number | null) => ({
  viewer_id,
  active_seq,
  view_focus,
});

test("one voice attaches at a time", () => {
  const p = new Presence(),
    first = p.watch("a", { muted: false, available: true }, 0);
  expect(first.voice_id).toMatch(/^v-/);
  expect(first.muted).toBe(false);
  expect(() => p.watch("b", { muted: false, available: true }, 0)).toThrow("VoiceAttached");
  expect(p.drop("b")).toBe(false);
  expect(p.drop("a")).toBe(true);
  expect(p.projection()).toBeUndefined();
  expect(p.watch("b", { muted: true, available: true }, 0).muted).toBe(true);
});

test("dictation goes to the focused pane of the viewer used last", () => {
  const p = new Presence();
  p.watch("a", { pane: 9, muted: false, available: true }, 0);
  const panes = new Set([3, 4, 9]);
  expect(p.target([viewer(1, 5, 3), viewer(2, 7, 4)], panes)).toEqual({ viewer: 2, pane: 4 });
  expect(p.target([viewer(1, 8n as any, 3), viewer(2, 7, 4)], panes)).toEqual({ viewer: 1, pane: 3 });
  expect(() => p.target([], panes)).toThrow("NoViewer");
  expect(() => p.target([viewer(1, 1, null)], panes)).toThrow("NoFocusedPane");
  expect(() => p.target([viewer(1, 1, 5)], panes)).toThrow("NoFocusedPane");
  expect(() => p.target([viewer(1, 1, 9)], panes)).toThrow("VoicePane");
});

test("the lease runs out without voice.set", () => {
  const p = new Presence(),
    { voice_id } = p.watch("a", { muted: false, available: true }, 1000);
  expect(p.expire(4000)).toBe(false);
  expect(p.set({ voice_id }, 3500)).toEqual({ muted: false });
  expect(p.expire(6000)).toBe(false);
  // A daemon busy elsewhere has read a heartbeat it has not handled yet.
  expect(p.expire(6501, 6000)).toBe(false);
  expect(p.expire(6501)).toBe(true);
  expect(p.projection()).toBeUndefined();
  expect(() => p.set({ voice_id }, 7000)).toThrow("VoiceGone");
  expect(() => p.toggle()).toThrow("NoVoice");
});

test("viewers toggle mute, but a voice that cannot listen stays muted", () => {
  const p = new Presence(),
    pushed: boolean[] = [];
  p.onMuted = muted => pushed.push(muted);
  const { voice_id } = p.watch("a", { muted: false, available: true }, 0);
  expect(p.projection()).toEqual({ state: "listening" });
  expect(p.toggle()).toEqual({ muted: true });
  expect(p.projection()).toEqual({ state: "muted" });
  expect(p.toggle()).toEqual({ muted: false });
  expect(pushed).toEqual([true, false]);
  p.set({ voice_id, available: false }, 0);
  expect(p.projection()).toEqual({ state: "muted" });
  expect(p.toggle()).toEqual({ muted: true });
  expect(p.projection()).toEqual({ state: "muted" });
  expect(pushed).toEqual([true, false]);
  // The microphone came back: the mute state from before holds.
  p.set({ voice_id, available: true }, 0);
  expect(p.projection()).toEqual({ state: "listening" });
});

test("the voice hears when the viewer or its focused pane changes", () => {
  const p = new Presence();
  expect(p.see({ viewer: true, focus: "a" })).toBe(false);
  expect(p.watch("v", { muted: false, available: true }, 0, { viewer: false, focus: null })).toMatchObject({
    viewer: false,
    focus: null,
  });
  expect(p.see({ viewer: false, focus: null })).toBe(false);
  expect(p.see({ viewer: true, focus: "dictation" })).toBe(true);
  expect(p.see({ viewer: true, focus: "dictation" })).toBe(false);
  expect(p.see({ viewer: true, focus: "build" })).toBe(true);
});
