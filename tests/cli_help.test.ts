import { readdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { EXE, ROOT, TestCase, registerCase, run, tempDir, writeExecutable } from "./support";

class CliHelp extends TestCase {
  async test_information_commands_need_no_runtime_or_native_libraries() {
    const temp = tempDir("corgi-help-");
    const env = {
      ...process.env,
      HOME: join(temp.name, "home"),
      XDG_STATE_HOME: join(temp.name, "state"),
      XDG_CONFIG_HOME: join(temp.name, "config"),
      TMPDIR: join(temp.name, "tmp"),
      CORGI_NATIVE_ROOT: join(temp.name, "no-native"),
      CORGI_SOCKET: join(temp.name, "no-runtime", "control.sock"),
      CORGI_PANE: "invalid",
      CORGI_AGENT_MODE: "1",
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    };
    try {
      for (const [args, text] of [
        [["--help"], "corgi shutdown"],
        [["serve", "--help"], "corgi serve"],
        [["pane", "send", "--stdin", "--help"], "corgi pane send"],
        [["account", "remove", "work", "--help"], "corgi account remove"],
        [["integration", "uninstall", "--help"], "corgi integration uninstall"],
        [["help", "launcher", "clone"], "--flags FLAGS"],
        [["--skill", "--help"], "print bundled agent instructions"],
        [["--version"], "corgi "],
        [["--skill"], "corgi"],
      ] as const) {
        const result = await run([EXE, ...args], { env, timeout: 3000 });
        this.assertIn(text, result.stdout);
        this.assertEqual(result.stderr, "");
      }
      const source = await run([process.execPath, join(ROOT, "src/main.ts"), "pane", "read", "--help"], { env });
      this.assertIn("corgi pane read", source.stdout);
      this.assertEqual(source.stderr, "");
      this.assertEqual(readdirSync(temp.name), [], "help must not create state, logs or native caches");
    } finally {
      temp.cleanup();
    }
  }

  async test_provider_help_is_forwarded_by_command_and_executable_alias() {
    const temp = tempDir("corgi-help-provider-");
    try {
      const provider = writeExecutable(join(temp.name, "provider"), "#!/bin/sh\nprintf 'provider:%s\\n' \"$@\"\n");
      const env = {
        ...process.env,
        HOME: temp.name,
        XDG_STATE_HOME: join(temp.name, "state"),
        XDG_CONFIG_HOME: join(temp.name, "config"),
        CODEX_HOME: join(temp.name, "codex-home"),
        CORGI_CODEX_BIN: provider,
        CORGI_SOCKET: join(temp.name, "no-runtime.sock"),
        CORGI_PANE: "1",
      };
      const alias = join(temp.name, "codex");
      symlinkSync(EXE, alias);
      for (const prefix of [[EXE, "agent", "codex"], [alias]]) {
        const result = await run([...prefix, "--help", "--no-agent"], { env });
        this.assertEqual(result.stdout, "provider:--help\nprovider:--no-agent\n");
        this.assertEqual(result.stderr, "");
      }
    } finally {
      temp.cleanup();
    }
  }
}
registerCase("CLI help", CliHelp);
