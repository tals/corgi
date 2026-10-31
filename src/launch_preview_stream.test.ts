import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Stream } from "./launch_preview_stream";
import { preview } from "./agent_launcher";
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
  let changed = stream.feed(JSON.stringify({ type: "agent.preview", cwd: "/a", preview }) + "\n");
  preview.options.codex.model = "wrong directory";
  changed = stream.feed(JSON.stringify({ type: "agent.preview", cwd: "/b", preview }) + "\n") || changed;
  expect(changed).toBe(true);
  expect(stream.current("/a").options.codex.model).toBe("updated");
  expect(stream.current("/b").options.codex.model).toBe("");
  preview.pending = true;
  preview.options.codex.model = "";
  stream.feed(JSON.stringify({ type: "agent.preview", cwd: "/a", preview }) + "\n");
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
test("accounts survive a change of folder until the new folder's read lists its own", () => {
  const stream = new Stream();
  stream.cwd = "/a";
  const account = {
    provider: "claude",
    account: "/accounts/work",
    name: "work",
    option: { model: "opus", signed_in: true },
  };
  const message = (cwd: string, pending: boolean, accounts: object[]) =>
    JSON.stringify({ type: "agent.preview", cwd, preview: { pending, accounts } }) + "\n";
  stream.feed(message("/a", false, [account]));
  // As poll moves the stream to another folder.
  Object.assign(stream, { preview: stream.current("/b"), cwd: "/b", received: false });
  expect(stream.preview.accounts.map(a => [a.name, a.option.model, a.option.signed_in])).toEqual([["work", "", true]]);
  // The daemon's first answer there lists none yet.
  stream.feed(message("/b", true, []));
  expect(stream.preview.accounts.map(a => a.name)).toEqual(["work"]);
  stream.feed(message("/b", false, []));
  expect(stream.preview.accounts).toEqual([]);
});

test("the first frame has snapshot accounts and partial previews update while another row loads", () => {
  const stream = new Stream();
  stream.cwd = "/a";
  const known = [{ provider: "claude" as const, account: "/accounts/work", name: "work", managed: true }];
  const initial = stream.current("/a", known);
  expect(initial.accounts.map(a => a.name)).toEqual(["work"]);
  expect(initial.accounts[0].managed).toBe(true);
  const sent = preview({
    pending: true,
    options: { codex: { pending: true }, claude: { pending: false, account: "home@example.com" } },
    accounts: known.map(a => ({ ...a, option: { pending: true } })),
  });
  const receive = () => stream.feed(JSON.stringify({ type: "agent.preview", cwd: "/a", preview: sent }) + "\n");
  expect(receive()).toBe(true);
  expect(stream.preview.options.claude.account).toBe("home@example.com");
  sent.accounts[0].option.pending = false;
  sent.accounts[0].option.account = "work@example.com";
  expect(receive()).toBe(true);
  expect(stream.preview.pending).toBe(true);
  expect(stream.preview.accounts[0].option.account).toBe("work@example.com");
  const other = stream.current("/b");
  expect(other.accounts[0].option.account).toBe("work@example.com");
  expect(other.accounts[0].option.pending).toBe(true);
  sent.accounts = [];
  expect(receive()).toBe(true);
  expect(stream.preview.accounts).toEqual([]);
});
test("the stream subscribes again when Manage agents opens or closes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-stream-")),
    socket = join(dir, "s"),
    asked: boolean[] = [],
    server = createServer(connection =>
      connection.on("data", chunk => {
        for (const line of chunk.toString().split("\n"))
          if (line.includes('"agent.subscribe"')) asked.push(JSON.parse(line).all);
      }),
    );
  await new Promise<void>(resolve => server.listen(socket, resolve));
  const stream = new Stream(),
    subscribed = async (count: number) => {
      for (let i = 0; i < 200 && asked.length < count; i++) await new Promise(r => setTimeout(r, 5));
    };
  stream.socket = socket;
  try {
    stream.poll(1, "/tmp");
    await subscribed(1);
    stream.poll(1, "/tmp", true);
    await subscribed(2);
    stream.poll(1, "/tmp", true);
    stream.poll(1, "/tmp");
    await subscribed(3);
    expect(asked).toEqual([false, true, false]);
  } finally {
    stream.disconnect();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
