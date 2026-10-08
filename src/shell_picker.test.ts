import { expect, test } from "bun:test";
import { Picker, status, summary, missing } from "./shell_picker";

const shells = ["/bin/bash", "/opt/homebrew/bin/fish", "/bin/zsh"];

test("an older daemon's missing or malformed shell field reads as unknown", () => {
  expect(status()).toEqual({ setting: "", path: "", source: "fallback", default: "", default_source: "fallback" });
  expect(status({ setting: 3, source: "chosen", default_source: "setting" }).default_source).toBe("fallback");
  expect(summary(status())).toBe("");
});

test("the setup row names the shell and where it came from", () => {
  const account = status({ path: "/bin/zsh", source: "account", default: "/bin/zsh", default_source: "account" });
  expect(summary(account)).toBe("zsh · your account");
  expect(summary({ ...account, source: "env" })).toBe("zsh · $SHELL");
  expect(summary({ ...account, setting: "fish", path: "/opt/homebrew/bin/fish", source: "setting" })).toBe("fish");
  const gone = { ...account, setting: "/bin/zshh" };
  expect(missing(gone)).toBe(true);
  expect(summary(gone)).toBe("/bin/zshh not found · zsh");
});

test("the picker marks the shell in use and starts on it", () => {
  const base = status({ path: "/bin/zsh", source: "account", default: "/bin/zsh", default_source: "account" });
  let picker = Picker.open(base, shells);
  expect(picker.entries.map(e => picker.label(e))).toEqual(["Default", "bash", "fish", "zsh", "Other…"]);
  expect([picker.in_use, picker.selected]).toEqual([0, 0]);
  expect(picker.detail(picker.entries[0])).toBe("zsh · your account");
  expect(picker.action()).toBe("Keep");
  picker.move(true);
  expect(picker.action()).toBe("Use");
  for (let i = 0; i < 9; i++) picker.move(true);
  expect(picker.action()).toBe("Type a path");
  for (let i = 0; i < 9; i++) picker.move(false);
  expect(picker.selected).toBe(0);

  // A name on PATH matches the listed shell it resolves to.
  picker = Picker.open({ ...base, setting: "fish", path: "/opt/homebrew/bin/fish", source: "setting" }, shells);
  expect(picker.label(picker.entries[picker.in_use])).toBe("fish");
  expect(picker.entries).toHaveLength(5);

  // A typed shell /etc/shells doesn't list gets a row of its own.
  picker = Picker.open(
    { ...base, setting: "/usr/local/bin/xonsh", path: "/usr/local/bin/xonsh", source: "setting" },
    shells,
  );
  expect(picker.entries.map(e => picker.label(e))).toEqual(["Default", "bash", "fish", "zsh", "xonsh", "Other…"]);
  expect(picker.in_use).toBe(4);

  // So does one that is gone, marked as missing while panes use the default.
  picker = Picker.open({ ...base, setting: "/bin/zshh" }, shells);
  expect(picker.detail(picker.entries[picker.in_use])).toBe("/bin/zshh · not found");
});
