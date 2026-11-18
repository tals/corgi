import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect } from "bun:test";
import { Index } from "./files";
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
  const index = new Index(),
    file = path.join(directory, "session_index.jsonl");
  try {
    writeFileSync(
      file,
      '{"id":"a","thread_name":"Old"}\n' +
        '{"id":"b","thread_name":"Other"}\n' +
        '{"id":"a","thread_name":"Latest"}\n' +
        '{"id":"a","thread_name":"Partial"}',
    );
    await index.refreshAsync(file);
    expect(index.name("a").text()).toBe("Latest");
    index.next_read = 0;
    const pending = index.refreshAsync(file);
    index.close();
    await pending;
    expect(index.names.size).toBe(0);
  } finally {
    index.close();
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
