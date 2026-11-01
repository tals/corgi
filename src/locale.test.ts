import { expect, test } from "bun:test";
import * as locale from "./locale";

test("locale aliases normalize once at the boundary", () => {
  for (const [input, expected] of [
    ["zh_CN.UTF-8", "zh"],
    ["zh-Hans-SG", "zh"],
    ["zh_TW.UTF-8", "zh"],
    ["ja_JP", "ja"],
    ["ko-KR", "ko"],
    ["ru_RU.UTF-8@modifier", "ru"],
    ["en-GB", "en"],
    ["C.UTF-8", "en"],
    ["POSIX", "en"],
    ["de_DE", null],
  ] as const)
    expect(locale.parse(input!)).toBe(expected);
});

test("UI language honors explicit choices and Unix message locale precedence", () => {
  expect(locale.detect({ CORGI_LANG: "ja", LC_ALL: "C" }, "ru")).toBe("ja");
  expect(locale.detect({ CORGI_LANG: "invalid", LANG: "ja_JP" })).toBe("en");
  expect(locale.detect({ CORGI_LANG: "auto", LANG: "ja_JP" }, "ru")).toBe("ru");
  expect(locale.detect({ LC_ALL: "ko_KR", LC_MESSAGES: "ja_JP", LANG: "ru_RU" })).toBe("ko");
  expect(locale.detect({ LC_MESSAGES: "ja_JP", LANG: "ru_RU" })).toBe("ja");
  expect(locale.detect({ LANGUAGE: "de:ru:ja", LANG: "en_US.UTF-8" })).toBe("ru");
  expect(locale.detect({ LANGUAGE: "ja", LC_ALL: "C.UTF-8" })).toBe("en");
  expect(locale.detect({ LANGUAGE: "ja", LANG: "POSIX" })).toBe("en");
  expect(locale.detect({ LC_CTYPE: "UTF-8" }, undefined, ["fr-FR", "ja-JP"])).toBe("ja");
  expect(locale.detect({ LANG: "de_DE" }, undefined, ["ja-JP"])).toBe("en");
  expect(locale.detect({})).toBe("en");
});

test("plural categories come from the active language", () => {
  expect([1, 2, 5, 21].map(count => locale.plural("ru", count))).toEqual(["one", "few", "many", "one"]);
  expect(locale.plural("ja", 1)).toBe("other");
  expect(locale.plural("en", 1)).toBe("one");
});
