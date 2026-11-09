import { expect, test } from "bun:test";
import { Parser, Editor } from "./sandbox_input";

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
