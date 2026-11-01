import { beforeEach, afterEach } from "bun:test";
import * as i18n from "../src/i18n";

// Rendering fixtures use English unless a test explicitly switches languages.
i18n.setLanguage("en");
beforeEach(() => i18n.setLanguage("en"));
afterEach(() => i18n.setLanguage("en"));
