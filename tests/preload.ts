import { beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as i18n from "../src/i18n";

// Unit tests never reach a real daemon. Run from a Corgi pane, the inherited
// CORGI_SOCKET names the live one, and a test that found it unreachable would
// replace it with a daemon carrying this process's environment. A test that
// tries to start one fails at once instead of leaving `corgi serve` running.
const run = mkdtempSync(join(tmpdir(), "corgi-unit-"));
process.env.CORGI_SOCKET = join(run, "control.sock");
process.env.CORGI_APP_EXE = join(run, "corgi");
writeFileSync(process.env.CORGI_APP_EXE, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
delete process.env.CORGI_PANE;
process.on("exit", () => rmSync(run, { recursive: true, force: true }));

// Rendering fixtures use English unless a test explicitly switches languages.
i18n.setLanguage("en");
beforeEach(() => i18n.setLanguage("en"));
afterEach(() => i18n.setLanguage("en"));
