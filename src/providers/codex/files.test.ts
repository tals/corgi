import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect } from "bun:test";
import { Index, available } from "./files";
import { Agent } from "../../agents";
test("file names wait five seconds after protocol metadata, on the daemon clock", () => {
  const agent = new Agent();
  agent.provider = "codex";
  expect(available(agent, 0)).toBe(true);
  const applied = 50000000;
  agent.metadata_at = applied;
  agent.metadata_protocol_at = 1;
  expect(available(agent, applied + 5000000)).toBe(false);
  expect(available(agent, applied + 5000001)).toBe(true);
  agent.provider = "claude";
  expect(available(agent, applied + 6000000)).toBe(false);
});
test("index selects exact identity and latest complete name", () => {
  const index = new Index();
  index.load(
    '{"id":"a","thread_name":"Old"}\nbroken\n{"id":"b","thread_name":"Other"}\n{"id":"a","thread_name":"Investigate missing session details"}\n{"id":"a","thread_name":""}\n{"id":"a","thread_name":"Partial"}',
  );
  expect(index.name("a").text()).toBe("Investigate missing session details");
  expect(index.name("b").text()).toBe("Other");
  expect(index.name("missing").len).toBe(0);
});

test("index worker reads complete records and releases an interrupted refresh", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "corgi-index-worker-"));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = directory;
  const index = new Index();
  try {
    writeFileSync(
      path.join(directory, "session_index.jsonl"),
      '{"id":"a","thread_name":"Old"}\n' +
        '{"id":"b","thread_name":"Other"}\n' +
        '{"id":"a","thread_name":"Latest"}\n' +
        '{"id":"a","thread_name":"Partial"}',
    );
    await index.refreshAsync();
    expect(index.name("a").text()).toBe("Latest");
    expect(index.name("b").text()).toBe("Other");
    expect(index.name("missing").len).toBe(0);
    index.next_read = 0;
    const pending = index.refreshAsync();
    index.close();
    await pending;
    expect(index.names.size).toBe(0);
  } finally {
    index.close();
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("index sanitizes valid UTF8 names and skips invalid records", () => {
  const index = new Index();
  index.load(
    Buffer.concat([
      Buffer.from('{"id":"a","thread_name":"Café"}\n'),
      Buffer.from('{"id":"bad","thread_name":"'),
      Buffer.from([255]),
      Buffer.from('"}\n{"id":"replacement","thread_name":"\\ufffd"}\n'),
    ]),
  );
  expect(index.name("a").text()).toBe("Caf  ");
  expect(index.name("bad").len).toBe(0);
  expect(index.name("replacement").text()).toBe("   ");
});
