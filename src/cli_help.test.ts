import { expect, test } from "bun:test";
import commands from "../assets/cli-help.txt" with { type: "text" };
import main from "../assets/help.txt" with { type: "text" };
import * as cli_help from "./cli_help";
import * as i18n from "./i18n";

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
