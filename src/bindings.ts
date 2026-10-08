import { specs as actionSpecs, title as actionTitle } from "./action";
import type { Action } from "./action";
import type { Preset } from "./keymap";
import type { Mods, Key } from "./keyboard";
export type { Mods };
export interface Binding {
  key: number;
  mods: Mods;
  prefixed: boolean;
  action: Action;
}
const tables: Record<Preset, Binding[]> = {
  corgi: [
    { key: 99, mods: {}, prefixed: true, action: { name: "new" } },
    { key: 110, mods: {}, prefixed: true, action: { name: "next" } },
    { key: 112, mods: {}, prefixed: true, action: { name: "prev" } },
    { key: 49, mods: {}, prefixed: true, action: { name: "tab", value: 1 } },
    { key: 50, mods: {}, prefixed: true, action: { name: "tab", value: 2 } },
    { key: 51, mods: {}, prefixed: true, action: { name: "tab", value: 3 } },
    { key: 52, mods: {}, prefixed: true, action: { name: "tab", value: 4 } },
    { key: 53, mods: {}, prefixed: true, action: { name: "tab", value: 5 } },
    { key: 54, mods: {}, prefixed: true, action: { name: "tab", value: 6 } },
    { key: 55, mods: {}, prefixed: true, action: { name: "tab", value: 7 } },
    { key: 56, mods: {}, prefixed: true, action: { name: "tab", value: 8 } },
    { key: 57, mods: {}, prefixed: true, action: { name: "tab", value: 9 } },
    { key: 84, mods: {}, prefixed: true, action: { name: "rename-tab" } },
    { key: 88, mods: {}, prefixed: true, action: { name: "close-tab" } },
    { key: 119, mods: {}, prefixed: true, action: { name: "new-workspace" } },
    { key: 87, mods: {}, prefixed: true, action: { name: "edit-workspace" } },
    { key: 125, mods: {}, prefixed: true, action: { name: "workspace-next" } },
    { key: 123, mods: {}, prefixed: true, action: { name: "workspace-prev" } },
    { key: 103, mods: {}, prefixed: true, action: { name: "find-agent" } },
    { key: 93, mods: {}, prefixed: true, action: { name: "next-agent" } },
    { key: 91, mods: {}, prefixed: true, action: { name: "prev-agent" } },
    { key: 9, mods: {}, prefixed: true, action: { name: "last-agent" } },
    { key: 102, mods: {}, prefixed: true, action: { name: "attention" } },
    { key: 97, mods: {}, prefixed: true, action: { name: "new-agent" } },
    { key: 109, mods: {}, prefixed: true, action: { name: "mute" } },
    {
      key: 104,
      mods: {},
      prefixed: true,
      action: { name: "focus", value: "left" },
    },
    {
      key: 106,
      mods: {},
      prefixed: true,
      action: { name: "focus", value: "down" },
    },
    {
      key: 107,
      mods: {},
      prefixed: true,
      action: { name: "focus", value: "up" },
    },
    {
      key: 108,
      mods: {},
      prefixed: true,
      action: { name: "focus", value: "right" },
    },
    {
      key: 72,
      mods: {},
      prefixed: true,
      action: { name: "swap", value: "left" },
    },
    {
      key: 74,
      mods: {},
      prefixed: true,
      action: { name: "swap", value: "down" },
    },
    {
      key: 75,
      mods: {},
      prefixed: true,
      action: { name: "swap", value: "up" },
    },
    {
      key: 76,
      mods: {},
      prefixed: true,
      action: { name: "swap", value: "right" },
    },
    {
      key: 118,
      mods: {},
      prefixed: true,
      action: { name: "split", value: "right" },
    },
    {
      key: 45,
      mods: {},
      prefixed: true,
      action: { name: "split", value: "down" },
    },
    { key: 114, mods: {}, prefixed: true, action: { name: "resize-mode" } },
    { key: 122, mods: {}, prefixed: true, action: { name: "zoom" } },
    { key: 33, mods: {}, prefixed: true, action: { name: "break" } },
    { key: 120, mods: {}, prefixed: true, action: { name: "close" } },
    { key: 117, mods: {}, prefixed: true, action: { name: "undo-close" } },
    { key: 115, mods: {}, prefixed: true, action: { name: "copy-mode" } },
    { key: 113, mods: {}, prefixed: true, action: { name: "detach" } },
    { key: 98, mods: {}, prefixed: true, action: { name: "sidebar" } },
    { key: 105, mods: {}, prefixed: true, action: { name: "setup" } },
    { key: 63, mods: {}, prefixed: true, action: { name: "help" } },
    {
      key: 37,
      mods: {},
      prefixed: true,
      action: { name: "split", value: "right" },
    },
    {
      key: 34,
      mods: {},
      prefixed: true,
      action: { name: "split", value: "down" },
    },
    { key: 44, mods: {}, prefixed: true, action: { name: "rename-tab" } },
    { key: 67, mods: {}, prefixed: true, action: { name: "setup" } },
    { key: 100, mods: {}, prefixed: true, action: { name: "detach" } },
    { key: 65, mods: {}, prefixed: true, action: { name: "new-agent" } },
    { key: 1, mods: {}, prefixed: true, action: { name: "new-agent" } },
    { key: 20, mods: {}, prefixed: false, action: { name: "new" } },
    {
      key: 116,
      mods: { ctrl: true, shift: true },
      prefixed: false,
      action: { name: "undo-close" },
    },
    {
      key: 116,
      mods: { super: true, shift: true },
      prefixed: false,
      action: { name: "undo-close" },
    },
    { key: 57364, mods: {}, prefixed: false, action: { name: "attention" } },
  ],
  tmux: [
    { key: 99, mods: {}, prefixed: true, action: { name: "new" } },
    { key: 110, mods: {}, prefixed: true, action: { name: "next" } },
    { key: 112, mods: {}, prefixed: true, action: { name: "prev" } },
    { key: 48, mods: {}, prefixed: true, action: { name: "tab", value: 1 } },
    { key: 49, mods: {}, prefixed: true, action: { name: "tab", value: 2 } },
    { key: 50, mods: {}, prefixed: true, action: { name: "tab", value: 3 } },
    { key: 51, mods: {}, prefixed: true, action: { name: "tab", value: 4 } },
    { key: 52, mods: {}, prefixed: true, action: { name: "tab", value: 5 } },
    { key: 53, mods: {}, prefixed: true, action: { name: "tab", value: 6 } },
    { key: 54, mods: {}, prefixed: true, action: { name: "tab", value: 7 } },
    { key: 55, mods: {}, prefixed: true, action: { name: "tab", value: 8 } },
    { key: 56, mods: {}, prefixed: true, action: { name: "tab", value: 9 } },
    { key: 57, mods: {}, prefixed: true, action: { name: "tab", value: 10 } },
    { key: 44, mods: {}, prefixed: true, action: { name: "rename-tab" } },
    { key: 38, mods: {}, prefixed: true, action: { name: "close-tab" } },
    { key: 78, mods: {}, prefixed: true, action: { name: "new-workspace" } },
    { key: 36, mods: {}, prefixed: true, action: { name: "edit-workspace" } },
    { key: 125, mods: {}, prefixed: true, action: { name: "workspace-next" } },
    { key: 123, mods: {}, prefixed: true, action: { name: "workspace-prev" } },
    {
      key: 115,
      mods: {},
      prefixed: true,
      action: { name: "choose-workspace" },
    },
    { key: 71, mods: {}, prefixed: true, action: { name: "find-agent" } },
    { key: 70, mods: {}, prefixed: true, action: { name: "attention" } },
    { key: 97, mods: {}, prefixed: true, action: { name: "new-agent" } },
    { key: 109, mods: {}, prefixed: true, action: { name: "mute" } },
    {
      key: 57350,
      mods: {},
      prefixed: true,
      action: { name: "focus", value: "left" },
    },
    {
      key: 57353,
      mods: {},
      prefixed: true,
      action: { name: "focus", value: "down" },
    },
    {
      key: 57352,
      mods: {},
      prefixed: true,
      action: { name: "focus", value: "up" },
    },
    {
      key: 57351,
      mods: {},
      prefixed: true,
      action: { name: "focus", value: "right" },
    },
    { key: 111, mods: {}, prefixed: true, action: { name: "next-pane" } },
    {
      key: 37,
      mods: {},
      prefixed: true,
      action: { name: "split", value: "right" },
    },
    {
      key: 34,
      mods: {},
      prefixed: true,
      action: { name: "split", value: "down" },
    },
    {
      key: 57350,
      mods: { ctrl: true },
      prefixed: true,
      action: { name: "resize", value: "left" },
    },
    {
      key: 57353,
      mods: { ctrl: true },
      prefixed: true,
      action: { name: "resize", value: "down" },
    },
    {
      key: 57352,
      mods: { ctrl: true },
      prefixed: true,
      action: { name: "resize", value: "up" },
    },
    {
      key: 57351,
      mods: { ctrl: true },
      prefixed: true,
      action: { name: "resize", value: "right" },
    },
    { key: 122, mods: {}, prefixed: true, action: { name: "zoom" } },
    { key: 33, mods: {}, prefixed: true, action: { name: "break" } },
    { key: 120, mods: {}, prefixed: true, action: { name: "close" } },
    { key: 117, mods: {}, prefixed: true, action: { name: "undo-close" } },
    { key: 91, mods: {}, prefixed: true, action: { name: "copy-mode" } },
    { key: 93, mods: {}, prefixed: true, action: { name: "paste" } },
    { key: 100, mods: {}, prefixed: true, action: { name: "detach" } },
    { key: 98, mods: {}, prefixed: true, action: { name: "sidebar" } },
    { key: 67, mods: {}, prefixed: true, action: { name: "setup" } },
    { key: 63, mods: {}, prefixed: true, action: { name: "help" } },
  ],
  herdr: [
    { key: 99, mods: {}, prefixed: true, action: { name: "new" } },
    { key: 110, mods: {}, prefixed: true, action: { name: "next" } },
    { key: 112, mods: {}, prefixed: true, action: { name: "prev" } },
    { key: 49, mods: {}, prefixed: true, action: { name: "tab", value: 1 } },
    { key: 50, mods: {}, prefixed: true, action: { name: "tab", value: 2 } },
    { key: 51, mods: {}, prefixed: true, action: { name: "tab", value: 3 } },
    { key: 52, mods: {}, prefixed: true, action: { name: "tab", value: 4 } },
    { key: 53, mods: {}, prefixed: true, action: { name: "tab", value: 5 } },
    { key: 54, mods: {}, prefixed: true, action: { name: "tab", value: 6 } },
    { key: 55, mods: {}, prefixed: true, action: { name: "tab", value: 7 } },
    { key: 56, mods: {}, prefixed: true, action: { name: "tab", value: 8 } },
    { key: 57, mods: {}, prefixed: true, action: { name: "tab", value: 9 } },
    { key: 84, mods: {}, prefixed: true, action: { name: "rename-tab" } },
    { key: 88, mods: {}, prefixed: true, action: { name: "close-tab" } },
    { key: 78, mods: {}, prefixed: true, action: { name: "new-workspace" } },
    { key: 87, mods: {}, prefixed: true, action: { name: "edit-workspace" } },
    { key: 125, mods: {}, prefixed: true, action: { name: "workspace-next" } },
    { key: 123, mods: {}, prefixed: true, action: { name: "workspace-prev" } },
    {
      key: 119,
      mods: {},
      prefixed: true,
      action: { name: "choose-workspace" },
    },
    {
      key: 103,
      mods: {},
      prefixed: true,
      action: { name: "choose-workspace" },
    },
    { key: 68, mods: {}, prefixed: true, action: { name: "close-workspace" } },
    { key: 102, mods: {}, prefixed: true, action: { name: "find-agent" } },
    { key: 111, mods: {}, prefixed: true, action: { name: "attention" } },
    { key: 97, mods: {}, prefixed: true, action: { name: "new-agent" } },
    { key: 109, mods: {}, prefixed: true, action: { name: "mute" } },
    {
      key: 104,
      mods: {},
      prefixed: true,
      action: { name: "focus", value: "left" },
    },
    {
      key: 106,
      mods: {},
      prefixed: true,
      action: { name: "focus", value: "down" },
    },
    {
      key: 107,
      mods: {},
      prefixed: true,
      action: { name: "focus", value: "up" },
    },
    {
      key: 108,
      mods: {},
      prefixed: true,
      action: { name: "focus", value: "right" },
    },
    {
      key: 72,
      mods: {},
      prefixed: true,
      action: { name: "swap", value: "left" },
    },
    {
      key: 74,
      mods: {},
      prefixed: true,
      action: { name: "swap", value: "down" },
    },
    {
      key: 75,
      mods: {},
      prefixed: true,
      action: { name: "swap", value: "up" },
    },
    {
      key: 76,
      mods: {},
      prefixed: true,
      action: { name: "swap", value: "right" },
    },
    { key: 9, mods: {}, prefixed: true, action: { name: "next-pane" } },
    {
      key: 9,
      mods: { shift: true },
      prefixed: true,
      action: { name: "prev-pane" },
    },
    {
      key: 118,
      mods: {},
      prefixed: true,
      action: { name: "split", value: "right" },
    },
    {
      key: 45,
      mods: {},
      prefixed: true,
      action: { name: "split", value: "down" },
    },
    { key: 114, mods: {}, prefixed: true, action: { name: "resize-mode" } },
    { key: 122, mods: {}, prefixed: true, action: { name: "zoom" } },
    { key: 33, mods: {}, prefixed: true, action: { name: "break" } },
    { key: 120, mods: {}, prefixed: true, action: { name: "close" } },
    { key: 117, mods: {}, prefixed: true, action: { name: "undo-close" } },
    { key: 91, mods: {}, prefixed: true, action: { name: "copy-mode" } },
    { key: 113, mods: {}, prefixed: true, action: { name: "detach" } },
    { key: 98, mods: {}, prefixed: true, action: { name: "sidebar" } },
    { key: 115, mods: {}, prefixed: true, action: { name: "setup" } },
    { key: 63, mods: {}, prefixed: true, action: { name: "help" } },
  ],
  cmux: [
    {
      key: 116,
      mods: { super: true },
      prefixed: false,
      action: { name: "new" },
    },
    {
      key: 93,
      mods: { super: true, shift: true },
      prefixed: false,
      action: { name: "next" },
    },
    {
      key: 91,
      mods: { super: true, shift: true },
      prefixed: false,
      action: { name: "prev" },
    },
    {
      key: 49,
      mods: { ctrl: true },
      prefixed: false,
      action: { name: "tab", value: 1 },
    },
    {
      key: 50,
      mods: { ctrl: true },
      prefixed: false,
      action: { name: "tab", value: 2 },
    },
    {
      key: 51,
      mods: { ctrl: true },
      prefixed: false,
      action: { name: "tab", value: 3 },
    },
    {
      key: 52,
      mods: { ctrl: true },
      prefixed: false,
      action: { name: "tab", value: 4 },
    },
    {
      key: 53,
      mods: { ctrl: true },
      prefixed: false,
      action: { name: "tab", value: 5 },
    },
    {
      key: 54,
      mods: { ctrl: true },
      prefixed: false,
      action: { name: "tab", value: 6 },
    },
    {
      key: 55,
      mods: { ctrl: true },
      prefixed: false,
      action: { name: "tab", value: 7 },
    },
    {
      key: 56,
      mods: { ctrl: true },
      prefixed: false,
      action: { name: "tab", value: 8 },
    },
    {
      key: 57,
      mods: { ctrl: true },
      prefixed: false,
      action: { name: "tab", value: 9 },
    },
    {
      key: 114,
      mods: { super: true },
      prefixed: false,
      action: { name: "rename-tab" },
    },
    {
      key: 110,
      mods: { super: true },
      prefixed: false,
      action: { name: "new-workspace" },
    },
    {
      key: 114,
      mods: { super: true, shift: true },
      prefixed: false,
      action: { name: "edit-workspace" },
    },
    {
      key: 112,
      mods: { super: true },
      prefixed: false,
      action: { name: "choose-workspace" },
    },
    {
      key: 119,
      mods: { super: true, shift: true },
      prefixed: false,
      action: { name: "close-workspace" },
    },
    {
      key: 49,
      mods: { super: true },
      prefixed: false,
      action: { name: "goto-workspace", value: 1 },
    },
    {
      key: 50,
      mods: { super: true },
      prefixed: false,
      action: { name: "goto-workspace", value: 2 },
    },
    {
      key: 51,
      mods: { super: true },
      prefixed: false,
      action: { name: "goto-workspace", value: 3 },
    },
    {
      key: 52,
      mods: { super: true },
      prefixed: false,
      action: { name: "goto-workspace", value: 4 },
    },
    {
      key: 53,
      mods: { super: true },
      prefixed: false,
      action: { name: "goto-workspace", value: 5 },
    },
    {
      key: 54,
      mods: { super: true },
      prefixed: false,
      action: { name: "goto-workspace", value: 6 },
    },
    {
      key: 55,
      mods: { super: true },
      prefixed: false,
      action: { name: "goto-workspace", value: 7 },
    },
    {
      key: 56,
      mods: { super: true },
      prefixed: false,
      action: { name: "goto-workspace", value: 8 },
    },
    {
      key: 57,
      mods: { super: true },
      prefixed: false,
      action: { name: "goto-workspace", value: 9 },
    },
    {
      key: 112,
      mods: { super: true, shift: true },
      prefixed: false,
      action: { name: "find-agent" },
    },
    {
      key: 117,
      mods: { super: true, shift: true },
      prefixed: false,
      action: { name: "attention" },
    },
    {
      key: 57350,
      mods: { super: true, alt: true },
      prefixed: false,
      action: { name: "focus", value: "left" },
    },
    {
      key: 57353,
      mods: { super: true, alt: true },
      prefixed: false,
      action: { name: "focus", value: "down" },
    },
    {
      key: 57352,
      mods: { super: true, alt: true },
      prefixed: false,
      action: { name: "focus", value: "up" },
    },
    {
      key: 57351,
      mods: { super: true, alt: true },
      prefixed: false,
      action: { name: "focus", value: "right" },
    },
    {
      key: 100,
      mods: { super: true },
      prefixed: false,
      action: { name: "split", value: "right" },
    },
    {
      key: 100,
      mods: { super: true, shift: true },
      prefixed: false,
      action: { name: "split", value: "down" },
    },
    {
      key: 104,
      mods: { ctrl: true, shift: true },
      prefixed: false,
      action: { name: "resize", value: "left" },
    },
    {
      key: 106,
      mods: { ctrl: true, shift: true },
      prefixed: false,
      action: { name: "resize", value: "down" },
    },
    {
      key: 107,
      mods: { ctrl: true, shift: true },
      prefixed: false,
      action: { name: "resize", value: "up" },
    },
    {
      key: 108,
      mods: { ctrl: true, shift: true },
      prefixed: false,
      action: { name: "resize", value: "right" },
    },
    {
      key: 13,
      mods: { super: true, shift: true },
      prefixed: false,
      action: { name: "zoom" },
    },
    {
      key: 119,
      mods: { super: true },
      prefixed: false,
      action: { name: "close" },
    },
    {
      key: 116,
      mods: { super: true, shift: true },
      prefixed: false,
      action: { name: "undo-close" },
    },
    {
      key: 109,
      mods: { super: true, shift: true },
      prefixed: false,
      action: { name: "copy-mode" },
    },
    {
      key: 98,
      mods: { super: true },
      prefixed: false,
      action: { name: "sidebar" },
    },
    {
      key: 44,
      mods: { super: true },
      prefixed: false,
      action: { name: "setup" },
    },
    { key: 99, mods: {}, prefixed: true, action: { name: "new" } },
    { key: 110, mods: {}, prefixed: true, action: { name: "next" } },
    { key: 112, mods: {}, prefixed: true, action: { name: "prev" } },
    { key: 49, mods: {}, prefixed: true, action: { name: "tab", value: 1 } },
    { key: 50, mods: {}, prefixed: true, action: { name: "tab", value: 2 } },
    { key: 51, mods: {}, prefixed: true, action: { name: "tab", value: 3 } },
    { key: 52, mods: {}, prefixed: true, action: { name: "tab", value: 4 } },
    { key: 53, mods: {}, prefixed: true, action: { name: "tab", value: 5 } },
    { key: 54, mods: {}, prefixed: true, action: { name: "tab", value: 6 } },
    { key: 55, mods: {}, prefixed: true, action: { name: "tab", value: 7 } },
    { key: 56, mods: {}, prefixed: true, action: { name: "tab", value: 8 } },
    { key: 57, mods: {}, prefixed: true, action: { name: "tab", value: 9 } },
    { key: 84, mods: {}, prefixed: true, action: { name: "rename-tab" } },
    { key: 88, mods: {}, prefixed: true, action: { name: "close-tab" } },
    { key: 119, mods: {}, prefixed: true, action: { name: "new-workspace" } },
    { key: 87, mods: {}, prefixed: true, action: { name: "edit-workspace" } },
    { key: 125, mods: {}, prefixed: true, action: { name: "workspace-next" } },
    { key: 123, mods: {}, prefixed: true, action: { name: "workspace-prev" } },
    { key: 103, mods: {}, prefixed: true, action: { name: "find-agent" } },
    { key: 93, mods: {}, prefixed: true, action: { name: "next-agent" } },
    { key: 91, mods: {}, prefixed: true, action: { name: "prev-agent" } },
    { key: 9, mods: {}, prefixed: true, action: { name: "last-agent" } },
    { key: 102, mods: {}, prefixed: true, action: { name: "attention" } },
    { key: 97, mods: {}, prefixed: true, action: { name: "new-agent" } },
    { key: 109, mods: {}, prefixed: true, action: { name: "mute" } },
    {
      key: 104,
      mods: {},
      prefixed: true,
      action: { name: "focus", value: "left" },
    },
    {
      key: 106,
      mods: {},
      prefixed: true,
      action: { name: "focus", value: "down" },
    },
    {
      key: 107,
      mods: {},
      prefixed: true,
      action: { name: "focus", value: "up" },
    },
    {
      key: 108,
      mods: {},
      prefixed: true,
      action: { name: "focus", value: "right" },
    },
    {
      key: 72,
      mods: {},
      prefixed: true,
      action: { name: "swap", value: "left" },
    },
    {
      key: 74,
      mods: {},
      prefixed: true,
      action: { name: "swap", value: "down" },
    },
    {
      key: 75,
      mods: {},
      prefixed: true,
      action: { name: "swap", value: "up" },
    },
    {
      key: 76,
      mods: {},
      prefixed: true,
      action: { name: "swap", value: "right" },
    },
    {
      key: 118,
      mods: {},
      prefixed: true,
      action: { name: "split", value: "right" },
    },
    {
      key: 45,
      mods: {},
      prefixed: true,
      action: { name: "split", value: "down" },
    },
    { key: 114, mods: {}, prefixed: true, action: { name: "resize-mode" } },
    { key: 122, mods: {}, prefixed: true, action: { name: "zoom" } },
    { key: 33, mods: {}, prefixed: true, action: { name: "break" } },
    { key: 120, mods: {}, prefixed: true, action: { name: "close" } },
    { key: 117, mods: {}, prefixed: true, action: { name: "undo-close" } },
    { key: 115, mods: {}, prefixed: true, action: { name: "copy-mode" } },
    { key: 113, mods: {}, prefixed: true, action: { name: "detach" } },
    { key: 98, mods: {}, prefixed: true, action: { name: "sidebar" } },
    { key: 105, mods: {}, prefixed: true, action: { name: "setup" } },
    { key: 63, mods: {}, prefixed: true, action: { name: "help" } },
    {
      key: 37,
      mods: {},
      prefixed: true,
      action: { name: "split", value: "right" },
    },
    {
      key: 34,
      mods: {},
      prefixed: true,
      action: { name: "split", value: "down" },
    },
    { key: 44, mods: {}, prefixed: true, action: { name: "rename-tab" } },
    { key: 67, mods: {}, prefixed: true, action: { name: "setup" } },
    { key: 100, mods: {}, prefixed: true, action: { name: "detach" } },
    { key: 65, mods: {}, prefixed: true, action: { name: "new-agent" } },
    { key: 1, mods: {}, prefixed: true, action: { name: "new-agent" } },
  ],
};
export function table(preset: Preset): Binding[] {
  return tables[preset];
}
function sameMods(a: Mods, b: Mods): boolean {
  return ["shift", "alt", "ctrl", "super"].every(
    (k) => !!a[k as keyof Mods] === !!b[k as keyof Mods],
  );
}
export function lookup(
  preset: Preset,
  prefixed: boolean,
  key: number,
  mods: Mods = {},
): Action | null {
  return (
    table(preset).find(
      (b) => b.key === key && b.prefixed === prefixed && sameMods(b.mods, mods),
    )?.action ?? null
  );
}
export function chord(
  preset: Preset,
  prefixed: boolean,
  k: Key,
): Action | null {
  let cp = k.codepoint;
  if (cp >= 65 && cp <= 90) cp += 32;
  if (k.mods.shift && cp === 125) cp = 93;
  if (k.mods.shift && cp === 123) cp = 91;
  if (cp === 57345) cp = 13;
  if (cp === 57346) cp = 9;
  if (cp < 128 && sameMods(k.mods, {})) return null;
  return (prefixed ? lookup(preset, true, cp, k.mods) : null) ?? lookup(preset, false, cp, k.mods);
}
export function prefixedSequence(preset: Preset, seq: string): Action | null {
  if (seq === "\x1b[Z") return lookup(preset, true, 9, { shift: true });
  const m = /^\x1b\[1;([2-9])([ABCD])$/.exec(seq);
  if (!m) return null;
  const bits = Number(m[1]) - 1;
  return lookup(
    preset,
    true,
    { A: 57352, B: 57353, C: 57351, D: 57350 }[m[2]]!,
    {
      shift: !!(bits & 1),
      alt: !!(bits & 2),
      ctrl: !!(bits & 4),
      super: !!(bits & 8),
    },
  );
}
export function find(preset: Preset, action: Action): Binding | null {
  return (
    table(preset).find(
      (b) => b.action.name === action.name && b.action.value === action.value,
    ) ?? null
  );
}
export function first(
  preset: Preset,
  action: Action,
  prefixed: boolean,
): Binding | null {
  return (
    table(preset).find(
      (b) =>
        b.prefixed === prefixed &&
        b.action.name === action.name &&
        b.action.value === action.value,
    ) ?? null
  );
}
export function format(b: Binding): string {
  let text =
    (b.mods.super ? "Cmd+" : "") +
    (b.mods.alt ? "Opt+" : "") +
    (b.mods.ctrl ? "Ctrl+" : "") +
    (b.mods.shift ? "Shift+" : "");
  const names: Record<number, string> = {
    9: "Tab",
    13: "Enter",
    57350: "←",
    57351: "→",
    57352: "↑",
    57353: "↓",
  };
  if (names[b.key]) return text + names[b.key];
  if (b.key < 27) return text + "Ctrl+" + String.fromCharCode(b.key + 64);
  if (b.key >= 57364 && b.key <= 57388) return text + "F" + (b.key - 57363);
  return (
    text +
    String.fromCodePoint(
      !sameMods(b.mods, {}) && b.key >= 97 && b.key <= 122 ? b.key - 32 : b.key,
    )
  );
}
export function compact(b: Binding): string {
  return (
    (b.mods.shift ? "⇧" : "") +
    format({
      ...b,
      mods: {},
      key:
        !sameMods(b.mods, {}) && b.key >= 97 && b.key <= 122
          ? b.key - 32
          : b.key,
    })
  );
}

export function writeTable(presets?: Preset[]): string {
  const selected = presets ?? (["corgi", "tmux", "herdr", "cmux"] as Preset[]);
  const titleCase: Record<string, string> = {
    corgi: "Corgi",
    tmux: "tmux",
    herdr: "Herdr",
    cmux: "cmux",
  };
  let out =
    "| Action |" +
    selected.map((p) => " " + titleCase[p] + " |").join("") +
    "\n| --- |" +
    selected.map(() => " --- |").join("") +
    "\n";
  const actions: Action[] = [];
  for (const [name, type] of Object.entries(actionSpecs)) {
    const values =
      type === "void"
        ? [undefined]
        : type === "usize"
          ? [1]
          : type === "Split"
            ? ["right", "down"]
            : type === "Side"
              ? ["left", "right"]
              : type === "layout.Direction"
                ? ["left", "down", "up", "right"]
                : [];
    for (const value of values) {
      const a: Action = { name, ...(value === undefined ? {} : { value }) };
      if (selected.some((p) => table(p).some((b) => sameRow(b, a))))
        actions.push(a);
    }
  }
  for (const a of actions) {
    out += "| " + actionTitle(a) + " |";
    for (const preset of selected) {
      const list = table(preset),
        cells: string[] = [];
      for (let i = 0; i < list.length; i++) {
        const b = list[i];
        if (!sameRow(b, a)) continue;
        let last = i;
        while (
          last + 1 < list.length &&
          sameRow(list[last + 1], a) &&
          list[last + 1].key === list[last].key + 1 &&
          sameMods(list[last + 1].mods, b.mods) &&
          list[last + 1].prefixed === b.prefixed
        )
          last++;
        cells.push(
          "`" +
            (b.prefixed ? "prefix " : "") +
            format(b) +
            (last > i ? "–" + String.fromCodePoint(list[last].key) : "") +
            "`",
        );
        i = last;
      }
      out += " " + cells.join(", ") + " |";
    }
    out += "\n";
  }
  return out;
}
function sameRow(binding: Binding, action: Action) {
  return (
    binding.action.name === action.name &&
    (["tab", "goto-workspace"].includes(action.name) ||
      binding.action.value === action.value)
  );
}
