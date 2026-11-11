import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Terminal } from "../src/pane/terminal";
import { Prediction } from "../src/instant_input";
import * as composer from "../src/instant_composer";
import type { View } from "../src/pane/surface";
import * as viewerNative from "../src/viewer_native";

for (const provider of ["claude", "codex"] as const) {
  const binary = Bun.which(provider);
  test.skipIf(!binary)(
    `real ${provider} predicts editing and Ctrl+J before delayed native frames, then answers locally`,
    async () => {
      const home = mkdtempSync(join(tmpdir(), "corgi-idle-"));
      const screen = new Terminal(60, 32);
      let lastOutput = performance.now();
      const env = { ...process.env, HOME: home, [`CORGI_LAB_${provider.toUpperCase()}`]: binary! };
      for (const key of Object.keys(env))
        if (key.startsWith("CORGI_") && !key.startsWith("CORGI_LAB_")) delete env[key];
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "remote_agent.ts"), provider], {
        env,
        cwd: home,
        terminal: {
          cols: 60,
          rows: 32,
          data(tty, data) {
            lastOutput = performance.now();
            screen.feed(data);
            const reply = screen.native({ op: "takePending" }) as string;
            if (reply) tty.write(reply);
          },
        },
      });
      const wait = async (predicate: () => boolean) => {
        const until = Date.now() + 25000;
        while (!predicate()) {
          if (child.exitCode !== null || Date.now() >= until) throw Error(`${provider}: ${screen.text()}`);
          await Bun.sleep(50);
        }
      };
      try {
        await wait(
          () => performance.now() - lastOutput >= 200 && composer.inspect(screen.surface(1).surface, provider) !== null,
        );
        expect(screen.text()).not.toMatch(/Select login method|Sign in with ChatGPT|Enter API key/);
        const initial = screen.surface(1);
        const prediction = new Prediction(() => 6500);
        prediction.configure(provider, "native", true);
        prediction.receive(initial, 0);
        const frames: View[] = [];
        const ctrlJ = viewerNative.encodeKey(screen.handle, { codepoint: 106, mods: { ctrl: true } });
        const suffix = " a sentence that wraps the prompt while typing across its edge";
        const wrapped = "hellorld\n\nend" + suffix;
        const actions: [string, string, number][] = [
          ["h", "h", 1],
          ["ello", "hello", 5],
          [ctrlJ, "hello\n", 6],
          ["world", "hello\nworld", 11],
          ["\x1b[A", "hello\nworld", 5],
          ["\x7f", "hell\nworld", 4],
          ["\x1b[B", "hell\nworld", 9],
          ["\x01", "hell\nworld", 5],
          ["\x7f", "hellworld", 4],
          ["\x1b[3~", "hellorld", 4],
          ["\x05", "hellorld", 8],
          ["\n", "hellorld\n", 9],
          ["\n", "hellorld\n\n", 10],
          ["end", "hellorld\n\nend", 13],
          [suffix, wrapped, wrapped.length],
          [ctrlJ, wrapped + "\n", wrapped.length + 1],
          ["x", wrapped + "\nx", wrapped.length + 2],
          ["\x7f", wrapped + "\n", wrapped.length + 1],
          ["\x7f", wrapped, wrapped.length],
        ];
        let now = 0;
        for (const [input, value, cursor] of actions) {
          const draft = { text: value, cursor };
          prediction.input(input, (now += 50));
          const preview = prediction.surface(now);
          expect(preview, JSON.stringify(input)).not.toBeNull();
          const predicted = composer.inspect(preview!, provider)!;
          expect(composer.matches(predicted, draft), JSON.stringify(input)).toBe(true);
          if (provider === "claude") expect(composer.inspect({ ...preview!, cursor: null }, provider)).toBeNull(); // No stale painted caret.
          child.terminal!.write(input);
          await wait(() => {
            const actual = composer.inspect(screen.surface(1).surface, provider);
            return actual !== null && composer.matches(actual, draft);
          });
          const actual = screen.surface(1);
          expect(predicted.top).toBe(composer.inspect(actual.surface, provider)!.top);
          frames.push(actual);
        }
        // All edits are already visible when the first one-second-old frame arrives.
        // Matching older states must not rewind the text or caret, including joins.
        for (const frame of frames) {
          prediction.receive(frame, (now += 50) + 1000);
          const shown = composer.inspect(prediction.surface(now + 1000) ?? frame.surface, provider)!;
          expect(composer.matches(shown, { text: wrapped, cursor: wrapped.length })).toBe(true);
        }
        expect(prediction.surface(now + 1000)).toBeNull();
        // Exercise the actual encoded controls, then deliver old screens whose
        // transport receipts already cover later edits. Receipt time is not
        // application render time.
        prediction.reset();
        child.terminal!.write("\x03");
        await wait(() => composer.inspect(screen.surface(1).surface, provider)?.lines.join("") === "");
        screen.resize(40, 32);
        child.terminal!.resize(40, 32);
        await wait(
          () => performance.now() - lastOutput >= 200 && composer.inspect(screen.surface(1).surface, provider) !== null,
        );
        prediction.receive(screen.surface(1), (now += 1100));
        const ctrl = (letter: string) =>
          viewerNative.encodeKey(screen.handle, { codepoint: letter.charCodeAt(0), mods: { ctrl: true } });
        const first = provider === "claude" ? "alXpharavo" : "Xalpharavo";
        const long = "one two three four five six seven eight nine ten eleven";
        const longDraft = provider === "claude" ? long + "\nCD" : "\nCD" + long;
        const cut = provider === "claude" ? "one two three four five six seven \nCD" : "\n";
        const cutCursor = provider === "claude" ? 34 : 1;
        const final = cut.slice(0, cutCursor) + "tail" + cut.slice(cutCursor);
        const edges: [string, string, number][] = [
          ["alpha", "alpha", 5],
          [ctrl("j"), "alpha\n", 6],
          ["bravo", "alpha\nbravo", 11],
          [ctrl("j"), "alpha\nbravo\n", 12],
          ["charlie", "alpha\nbravo\ncharlie", 19],
          [ctrl("u"), "alpha\nbravo\n", 12],
          ["C", "alpha\nbravo\nC", 13],
          ["\x1b[A", "alpha\nbravo\nC", 7],
          [ctrl("u"), "alpha\nravo\nC", 6],
          [ctrl("u"), "alpharavo\nC", 5],
          ["\x1b[B", "alpharavo\nC", 11],
          ["\x1b[B", "alpharavo\nC", 11],
          ["D", "alpharavo\nCD", 12],
          ["\x1b[A", "alpharavo\nCD", 2],
          ["\x1b[A", "alpharavo\nCD", provider === "claude" ? 2 : 0],
          ["\x1b[A", "alpharavo\nCD", provider === "claude" ? 2 : 0],
          ["X", first + "\nCD", provider === "claude" ? 3 : 1],
          [ctrl("a"), first + "\nCD", 0],
          [ctrl("k"), "\nCD", 0],
          [ctrl("e"), "\nCD", provider === "claude" ? 0 : 3],
          [long, longDraft, provider === "claude" ? long.length : longDraft.length],
          [ctrl("u"), cut, cutCursor],
          ["tail", final, cutCursor + 4],
        ];
        frames.length = 0;
        for (const [input, value, cursor] of edges) {
          const draft = { text: value, cursor };
          prediction.input(input, (now += 30));
          const preview = prediction.surface(now);
          expect(preview, JSON.stringify(input)).not.toBeNull();
          expect(composer.matches(composer.inspect(preview!, provider)!, draft), JSON.stringify(input)).toBe(true);
          child.terminal!.write(input);
          await wait(() => {
            const actual = composer.inspect(screen.surface(1).surface, provider);
            return actual !== null && composer.matches(actual, draft);
          });
          frames.push(screen.surface(1));
        }
        const receipt = { epoch: "native-test", sequence: 100n };
        prediction.delivered(prediction.sequence, receipt);
        for (const frame of frames) {
          prediction.receive({ ...frame, input_ack: receipt }, (now += 50));
          const shown = prediction.surface(now) ?? frame.surface;
          expect(composer.matches(composer.inspect(shown, provider)!, { text: final, cursor: cutCursor + 4 })).toBe(
            true,
          );
        }
        // Resize a known document; Ghostty and the native app reflow separately.
        screen.resize(32, 32);
        child.terminal!.resize(32, 32);
        await wait(() => {
          const actual = composer.inspect(screen.surface(1).surface, provider);
          return actual !== null && composer.matches(actual, { text: final, cursor: cutCursor + 4 });
        });
        prediction.receive(screen.surface(1), (now += 50));
        prediction.input("!", (now += 50));
        const resizedDraft = {
          text: final.slice(0, cutCursor + 4) + "!" + final.slice(cutCursor + 4),
          cursor: cutCursor + 5,
        };
        expect(composer.matches(composer.inspect(prediction.surface(now)!, provider)!, resizedDraft)).toBe(true);
        child.terminal!.write("!");
        await wait(() => {
          const actual = composer.inspect(screen.surface(1).surface, provider);
          return actual !== null && composer.matches(actual, resizedDraft);
        });
        child.terminal!.write("\r");
        await wait(() => screen.text().includes(`Sandbox reply from ${provider === "claude" ? "Claude" : "Codex"}`));
      } finally {
        if (child.exitCode === null) child.kill();
        await child.exited;
        child.terminal?.close();
        screen.destroy();
        rmSync(home, { recursive: true, force: true });
      }
    },
    60000,
  );
}
