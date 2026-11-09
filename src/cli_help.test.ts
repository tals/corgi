import { expect, test } from "bun:test";
import commands from "../assets/cli-help.txt" with { type: "text" };
import main from "../assets/help.txt" with { type: "text" };
import * as cli_help from "./cli_help";
import * as i18n from "./i18n";
import * as releaseLabel from "./release_label";
import { displayWidth } from "./text";

test("tagged help keeps the English agent reference in sync", () => {
  const previous = i18n.language();
  try {
    i18n.setLanguage("en");
    expect(cli_help.commands()).toBe(commands);
    expect(cli_help.main()).toBe(main);
  } finally {
    i18n.setLanguage(previous);
  }
});

test("the overview fits 80 columns and is plain off a terminal", () => {
  const previous = i18n.language();
  try {
    i18n.setLanguage("en");
    const release = releaseLabel.of(
        "0.1.0-dev",
        "3bda17b229cdb2981bbebaca28bdc89d59f62591-dirty",
        "2026-11-08T09:15:44Z",
      ),
      plain = cli_help.overview(false, release);
    expect(plain).not.toContain("\x1b");
    expect(plain).toContain("Build 3bda17b-dirty built on ");
    expect(plain).toContain("corgi help --all");
    expect(plain).toContain("https://discord.gg/8v6eNAKuT");
    for (const line of plain.split("\n")) expect(displayWidth(line)).toBeLessThanOrEqual(80);
    const rich = cli_help.overview(true, release);
    expect(rich).toContain(
      "\x1b]8;;https://github.com/tals/corgi/commit/3bda17b229cdb2981bbebaca28bdc89d59f62591\x1b\\3bda17b",
    );
    expect(rich.replace(/\x1b\[[\d;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, "")).toBe(plain);
  } finally {
    i18n.setLanguage(previous);
  }
});

test("the overview leaves out a build it doesn't know", () => {
  const overview = cli_help.overview(false, releaseLabel.of("0.1.0-dev", "bun-port"));
  expect(overview).not.toContain("Build");
  expect(overview.split("\n")[0]).toBe(i18n.t`Happy helper for your terminal.`);
});
