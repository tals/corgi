export type Direction = "left" | "right" | "up" | "down";
export type Action = { name: string; value?: string | number };
export const specs: Record<string, string> = {
  new: "void",
  next: "void",
  prev: "void",
  tab: "usize",
  "rename-tab": "void",
  rename: "[]const u8",
  "close-tab": "void",
  "move-tab": "Side",
  "new-workspace": "void",
  "edit-workspace": "void",
  "workspace-next": "void",
  "workspace-prev": "void",
  "choose-workspace": "void",
  worktrees: "usize",
  "worktree-next": "void",
  "worktree-prev": "void",
  "worktree-close": "void",
  "worktree-select": "[]const u8",
  "worktree-agent": "usize",
  "worktree-enter": "void",
  "worktree-remove": "void",
  "worktree-stop": "void",
  "goto-workspace": "usize",
  "close-workspace": "void",
  open: "[]const u8",
  "find-agent": "void",
  "choose-agent": "void",
  "next-agent": "void",
  "prev-agent": "void",
  "last-agent": "void",
  attention: "void",
  "new-agent": "void",
  mute: "void",
  focus: "layout.Direction",
  swap: "layout.Direction",
  "next-pane": "void",
  "prev-pane": "void",
  split: "Split",
  "resize-mode": "void",
  resize: "layout.Direction",
  zoom: "void",
  break: "void",
  join: "usize",
  close: "void",
  "undo-close": "void",
  "copy-mode": "void",
  paste: "void",
  copy: "[]const u8",
  detach: "void",
  sidebar: "void",
  setup: "void",
  help: "void",
  onboard: "void",
  relaunch: "[]const u8",
};
export function parse(name: string, value = ""): Action {
  const type = specs[name];
  if (!type) throw new Error("UnknownAction");
  if (type === "void") return { name };
  if (type === "usize") {
    if (name === "worktrees" && !value) return { name, value: 0 };
    if (!/^\+?\d+$/.test(value)) throw new Error("BadValue");
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new Error("BadValue");
    return { name, value: number };
  }
  if (type === "[]const u8") return { name, value };
  const values = type === "layout.Direction" ? ["left", "down", "up", "right"] : ["left", "right"];
  if (type === "Split") values.splice(0, 2, "right", "down");
  if (!value && (type === "Side" || type === "Split")) value = "right";
  if (!values.includes(value)) throw new Error("BadValue");
  return { name, value };
}
export function needsPane(action: Action): boolean {
  return [
    "split",
    "zoom",
    "close",
    "close-tab",
    "rename-tab",
    "rename",
    "move-tab",
    "break",
    "resize",
    "resize-mode",
    "focus",
    "swap",
    "next-pane",
    "prev-pane",
    "next",
    "prev",
    "tab",
    "join",
    "copy-mode",
    "paste",
  ].includes(action.name);
}
export function title(action: Action): string {
  const titles: Record<string, string> = {
    onboard: "Onboarding",
    new: "New tab (agent picker)",
    zoom: "Zoom / unzoom pane",
    close: "Close pane",
    "close-tab": "Close tab",
    "rename-tab": "Rename tab",
    sidebar: "Toggle sidebar",
    mute: "Mute / unmute sounds",
    "undo-close": "Reopen last closed agent",
    attention: "Jump to attention",
    "workspace-next": "Next workspace",
    "workspace-prev": "Previous workspace",
    "new-workspace": "New workspace",
    "edit-workspace": "Edit workspace",
    "close-workspace": "Close workspace",
    "choose-workspace": "Choose workspace",
    worktrees: "Show worktrees",
    "goto-workspace": "Select workspace",
    open: "Open folder as workspace",
    "new-agent": "New agent",
    "find-agent": "Find agent",
    "choose-agent": "Choose agent",
    "next-agent": "Next agent",
    "prev-agent": "Previous agent",
    "last-agent": "Last visited agent",
    rename: "Name tab",
    "resize-mode": "Resize mode",
    "next-pane": "Next pane",
    "prev-pane": "Previous pane",
    break: "Move pane to a new tab",
    next: "Next tab",
    prev: "Previous tab",
    tab: "Select tab",
    join: "Move pane into tab",
    "copy-mode": "Scroll / copy mode",
    paste: "Paste copied text",
    copy: "Copy text",
    setup: "Setup",
    help: "All shortcuts",
    detach: "Detach",
    relaunch: "Relaunch viewer",
  };
  if (["split", "resize", "focus", "swap", "move-tab"].includes(action.name))
    return (
      (action.name === "move-tab" ? "Move tab" : action.name[0].toUpperCase() + action.name.slice(1)) +
      " " +
      action.value
    );
  return titles[action.name] ?? action.name.replaceAll("-", " ");
}
export const Action = { parse, needsPane, title };
