import { test, expect } from "bun:test";
import { Stream } from "./launch_preview_stream";
test("preview stream handles partial and consecutive messages and ignores old directories", () => {
  const stream = new Stream();
  stream.cwd = "/a";
  const preview = {
      pending: false,
      installed: { codex: true, claude: true },
      options: {
        codex: { model: "initial", signed_in: true },
        claude: { model: "", signed_in: null },
      },
    },
    first = JSON.stringify({ type: "agent.preview", cwd: "/a", preview });
  expect(stream.feed(first.slice(0, 100))).toBe(false);
  expect(stream.feed(first.slice(100) + "\n")).toBe(true);
  expect(stream.current("/a").options.codex.model).toBe("initial");
  preview.options.codex.model = "updated";
  let changed = stream.feed(
    JSON.stringify({ type: "agent.preview", cwd: "/a", preview }) + "\n",
  );
  preview.options.codex.model = "wrong directory";
  changed =
    stream.feed(
      JSON.stringify({ type: "agent.preview", cwd: "/b", preview }) + "\n",
    ) || changed;
  expect(changed).toBe(true);
  expect(stream.current("/a").options.codex.model).toBe("updated");
  expect(stream.current("/b").options.codex.model).toBe("");
  preview.pending = true;
  preview.options.codex.model = "";
  stream.feed(
    JSON.stringify({ type: "agent.preview", cwd: "/a", preview }) + "\n",
  );
  expect(stream.preview.pending).toBe(true);
  expect(stream.preview.options.codex.model).toBe("updated");
});
test("the stream follows conversations: the whole list, then what changed", () => {
  const stream = new Stream();
  expect(stream.history.pending).toBe(true);
  stream.feed(
    JSON.stringify({
      type: "agent.history",
      update: {
        epoch: 7,
        revision: 2,
        full: true,
        entries: [
          {
            provider: "claude",
            session: "s1",
            title: "Older",
            cwd: "/a",
            updated_at: 5,
          },
          {
            provider: "codex",
            session: "s2",
            title: "Newer",
            cwd: "/a",
            updated_at: 9,
          },
        ],
      },
    }) + "\n",
  );
  expect(stream.history.pending).toBe(false);
  expect(stream.history.entries[0].title).toBe("Newer");
  stream.feed(
    JSON.stringify({
      type: "agent.history",
      update: {
        epoch: 7,
        revision: 4,
        full: false,
        entries: [
          {
            provider: "claude",
            session: "s1",
            title: "Older, used again",
            cwd: "/a",
            updated_at: 12,
          },
        ],
        removed: [{ provider: "codex", session: "s2" }],
      },
    }) + "\n",
  );
  expect(stream.history.entries).toHaveLength(1);
  expect(stream.history.entries[0].title).toBe("Older, used again");
  expect(
    stream.feed(
      JSON.stringify({
        type: "agent.history",
        history: {
          pending: false,
          entries: [
            {
              provider: "claude",
              session: "s3",
              title: "From an older daemon",
              cwd: "/a",
              updated_at: 1,
            },
          ],
        },
      }) + "\n",
    ),
  ).toBe(true);
  expect(stream.history.entries[0].title).toBe("From an older daemon");
});
