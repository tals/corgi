import { expect, test } from "bun:test";
import { writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { Parser, Editor } from "./sandbox_input";
import { Sandbox, type World } from "./sandbox";
import { Terminal } from "../src/pane/terminal";
import { Prediction } from "../src/instant_input";
import * as composer from "../src/instant_composer";
import type { View } from "../src/pane/surface";

test("split arrows, modified Enter and bracketed paste never become literal escape fragments", () => {
  const parser = new Parser(),
    editor = new Editor();
  const bytes = new TextEncoder().encode(
    "hello\x1b[D\x1b[D\x7fX\x1b[3~\x1b[F\x1b[27;2;13~second\x1b[200~a\x1b[Db\x1b[201~",
  );
  const events = Array.from(bytes).flatMap(byte => parser.read(Uint8Array.of(byte)));
  for (const event of events) if (event.kind === "key") editor.key(event.data);
  expect(editor.text).toBe("heXo\nsecond");
  expect(events.at(-1)).toEqual({ kind: "paste", data: "a\x1b[Db" });
});

for (const provider of ["claude", "codex"] as const) {
  test(`${provider}: actual sandbox PTY edits converge while delayed intermediate screens keep the latest draft`, async () => {
    const sandbox = new Sandbox(
      `typing-test-${process.pid}-${provider}`,
      {} as World,
      resolve(import.meta.dir, ".."),
      "unused",
    );
    const screen = new Terminal(40, 24);
    const frames: View[] = [];
    let child: ReturnType<typeof Bun.spawn> | undefined;
    const wait = async (predicate: () => boolean) => {
      const deadline = performance.now() + 3000;
      while (!predicate()) {
        if (performance.now() > deadline) throw Error(screen.text());
        await Bun.sleep(5);
      }
    };
    try {
      sandbox.prepareHome();
      writeFileSync(
        join(sandbox.env.CLAUDE_CONFIG_DIR, ".claude.json"),
        JSON.stringify({ oauthAccount: { emailAddress: "sandbox@example.com" } }),
      );
      writeFileSync(
        join(sandbox.env.CODEX_HOME, "auth.json"),
        JSON.stringify({
          tokens: { id_token: "x." + Buffer.from('{"email":"sandbox@example.com"}').toString("base64url") + ".x" },
        }),
      );
      child = Bun.spawn([join(sandbox.home, "bin", provider)], {
        env: sandbox.env,
        cwd: sandbox.dir,
        terminal: {
          cols: 40,
          rows: 24,
          data(_terminal, data) {
            screen.feed(data);
            const frame = screen.surface(1);
            if (composer.inspect(frame.surface, provider)) frames.push(frame);
          },
        },
      });
      await wait(() => frames.length > 0);
      const prediction = new Prediction(() => 6500);
      prediction.configure(provider, "sandbox", true);
      prediction.receive(frames.at(-1)!);
      frames.length = 0;
      const actions = [
        "hello",
        "\x1b[D",
        "\x1b[D",
        "\x7f",
        "X",
        "\x1b[3~",
        "\x1b[F",
        "\x1b[27;2;13~",
        "second",
        "\x1b[A",
        "\x7f",
        "\x1b[B",
        "\x1b[H",
        ">",
        "\x1b[F",
        "\x1b[27;2;13~",
        "\x1b[27;2;13~",
        "\x1b[A",
        "\x1b[A",
        "\x1b[H",
        "\x7f",
        "\x1b[F",
        "\x1b[3~",
        "\x1b[3~",
      ];
      for (const key of actions) {
        const count = frames.length;
        prediction.input(key);
        expect(prediction.surface(), key).not.toBeNull();
        child.terminal!.write(key);
        await wait(() => frames.length > count);
      }
      const final = frames.at(-1)!;
      expect(composer.inspect(final.surface, provider)!.lines).toEqual(["heX>second"]);
      expect(screen.text()).not.toContain("[27;");
      // The server's whole trajectory arrives only after local editing finishes.
      for (const [index, frame] of frames.entries()) {
        prediction.receive(frame);
        const shown = prediction.surface() ?? frame.surface;
        expect(
          shown.cursor,
          JSON.stringify({
            index,
            incoming: composer.inspect(frame.surface, provider)?.lines,
            preview: !!prediction.surface(),
          }),
        ).toEqual(final.surface.cursor);
        expect(composer.inspect(shown, provider)!.lines).toEqual(["heX>second"]);
      }
      expect(prediction.surface()).toBeNull();
      child.terminal!.write("\r");
      await wait(() => screen.text().includes("Working on: heX"));
    } finally {
      child?.kill();
      if (child) {
        await child.exited;
        child.terminal?.close();
      }
      screen.destroy();
      rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });
}
