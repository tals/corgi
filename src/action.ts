import * as i18n from "./i18n";
export type Direction = "left" | "right" | "up" | "down";
export type Action = { name: string; value?: string | number };
export const specs: Record<string, string> = {
  new: "void",
  next: "void",
  prev: "void",
  "last-tab": "void",
  tab: "usize",
  "rename-tab": "void",
  rename: "[]const u8",
  "close-tab": "void",
  "move-tab": "Side",
  "new-workspace": "void",
  "edit-workspace": "void",
  "workspace-next": "void",
  "workspace-prev": "void",
  "last-workspace": "void",
  "choose-workspace": "void",
  worktrees: "usize",
  "worktree-next": "void",
  "worktree-prev": "void",
  "worktree-close": "void",
  "worktree-select": "[]const u8",
  "worktree-agent": "usize",
  "worktree-enter": "void",
  "worktree-remove": "void",
  "worktree-confirm": "void",
  "worktree-stop": "void",
  "worktree-refresh": "void",
  "worktree-review": "void",
  resources: "usize",
  "resource-next": "void",
  "resource-prev": "void",
  "resource-sort": "Side",
  "resource-tag": "void",
  "resource-tag-tree": "void",
  "resource-untag": "void",
  "resource-go": "void",
  "resource-signal": "Signal",
  "resource-close": "void",
  "git-next": "void",
  "git-prev": "void",
  "git-go": "void",
  "git-close": "void",
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
  "star-agent": "usize",
  "star-session": "usize",
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
  "copy-link": "void",
  detach: "void",
  sidebar: "void",
  review: "void",
  setup: "void",
  moonlander: "void",
  help: "void",
  keybindings: "void",
  onboard: "void",
  relaunch: "[]const u8",
};
export function parse(name: string, value = ""): Action {
  const type = specs[name];
  if (!Object.hasOwn(specs, name)) throw new Error("UnknownAction");
  if (type === "void") return { name };
  if (type === "usize") {
    if ((name === "worktrees" || name === "resources") && !value) return { name, value: 0 };
    if (!/^\+?\d+$/.test(value)) throw new Error("BadValue");
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new Error("BadValue");
    return { name, value: number };
  }
  if (type === "[]const u8") return { name, value };
  const values =
    type === "layout.Direction"
      ? ["left", "down", "up", "right"]
      : type === "Signal"
        ? ["term", "kill"]
        : ["left", "right"];
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
    onboard: i18n.t`Onboarding`,
    keybindings: i18n.t`Customize shortcuts`,
    new: i18n.t`New tab (agent picker)`,
    zoom: i18n.t`Zoom / unzoom pane`,
    close: i18n.t`Close pane`,
    "close-tab": i18n.t`Close tab`,
    "rename-tab": i18n.t`Rename tab`,
    sidebar: i18n.t`Toggle sidebar`,
    review: i18n.t`Review changes`,
    mute: i18n.t`Mute / unmute sounds`,
    "undo-close": i18n.t`Reopen last closed agent`,
    attention: i18n.t`Jump to attention`,
    "workspace-next": i18n.t`Next workspace`,
    "workspace-prev": i18n.t`Previous workspace`,
    "last-workspace": i18n.t`Last visited workspace`,
    "new-workspace": i18n.t`New workspace`,
    "edit-workspace": i18n.t`Edit workspace`,
    "close-workspace": i18n.t`Close workspace`,
    "choose-workspace": i18n.t`Choose workspace`,
    worktrees: i18n.t`Show worktrees`,
    resources: i18n.t`Show resources`,
    "goto-workspace": i18n.t`Select workspace`,
    open: i18n.t`Open folder as workspace`,
    "new-agent": i18n.t`New agent`,
    "star-agent": i18n.t`Star / unstar agent`,
    "star-session": i18n.t`Star / unstar headless agent`,
    "find-agent": i18n.t`Find agent`,
    "choose-agent": i18n.t`Choose agent`,
    "next-agent": i18n.t`Next agent`,
    "prev-agent": i18n.t`Previous agent`,
    "last-agent": i18n.t`Last visited agent`,
    rename: i18n.t`Name tab`,
    "resize-mode": i18n.t`Resize mode`,
    "next-pane": i18n.t`Next pane`,
    "prev-pane": i18n.t`Previous pane`,
    break: i18n.t`Move pane to a new tab`,
    next: i18n.t`Next tab`,
    prev: i18n.t`Previous tab`,
    "last-tab": i18n.t`Last visited tab`,
    tab: i18n.t`Select tab`,
    join: i18n.t`Move pane into tab`,
    "copy-mode": i18n.t`Scroll / copy mode`,
    paste: i18n.t`Paste copied text`,
    copy: i18n.t`Copy text`,
    "copy-link": i18n.t`Copy hovered link`,
    setup: i18n.t`Setup`,
    moonlander: i18n.t`Play Moonlander`,
    help: i18n.t`All shortcuts`,
    detach: i18n.t`Detach`,
    relaunch: i18n.t`Relaunch viewer`,
  };
  const directions: Record<string, Record<string, string>> = {
    "split": { right: i18n.t`Split right`, down: i18n.t`Split down` },
    "resize": {
      left: i18n.t`Resize left`,
      right: i18n.t`Resize right`,
      up: i18n.t`Resize up`,
      down: i18n.t`Resize down`,
    },
    "focus": { left: i18n.t`Focus left`, right: i18n.t`Focus right`, up: i18n.t`Focus up`, down: i18n.t`Focus down` },
    "swap": { left: i18n.t`Swap left`, right: i18n.t`Swap right`, up: i18n.t`Swap up`, down: i18n.t`Swap down` },
    "move-tab": { left: i18n.t`Move tab left`, right: i18n.t`Move tab right` },
  };
  const direction = directions[action.name]?.[String(action.value)];
  if (direction) return direction;
  return titles[action.name] ?? action.name.replaceAll("-", " ");
}
export const Action = { parse, needsPane, title };
