import { beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as i18n from "../src/i18n";

// Unit tests never reach a real daemon. Run from a Corgi pane, the inherited
// CORGI_SOCKET names the live one, and a test that found it unreachable would
// replace it with a daemon carrying this process's environment.
const run = mkdtempSync(join(tmpdir(), "corgi-unit-"));
process.env.CORGI_SOCKET = join(run, "control.sock");
delete process.env.CORGI_PANE;
delete process.env.CORGI_APP_EXE;
process.on("exit", () => rmSync(run, { recursive: true, force: true }));

// Rendering fixtures use English unless a test explicitly switches languages.
i18n.setLanguage("en");
beforeEach(() => i18n.setLanguage("en"));
afterEach(() => i18n.setLanguage("en"));
