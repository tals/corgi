import { expect, test } from "bun:test";
import * as language from "./language";

test("explicit locale URLs override saved and browser preferences, including English", () => {
  expect(language.choose("/en/", "ru", ["ja-JP"])).toBe("en");
  expect(language.choose("/zh/moonlander", "ko", ["ru-RU"])).toBe("zh");
  expect(language.choose("/", "ru", ["ja-JP"])).toBe("ru");
  expect(language.choose("/", "bad", ["fr-FR", "ko-KR"])).toBe("ko");
  expect(language.choose("/", null, ["zh-Hans-CN"])).toBe("zh");
  expect(language.choose("/", null, ["fr-FR"])).toBe("en");
});

test("language links preserve the page and replace only the locale segment", () => {
  expect(language.localizedPath("/ru/moonlander", "ja")).toBe("/ja/moonlander");
  expect(language.localizedPath("/moonlander", "zh")).toBe("/zh/moonlander");
  expect(language.localizedPath("/en/", "ko")).toBe("/ko/");
  expect(language.localizedPath("/ru", "en")).toBe("/en/");
  expect(language.pathLanguage("/environment")).toBeNull();
});
