import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { readUsage } from "./usage";

function dbWith(rows: (string | number | null)[][]): string {
  const path = join(mkdtempSync(join(tmpdir(), "corgi-goose-usage-")), "sessions.db");
  const db = new Database(path);
  db.exec(
    `CREATE TABLE sessions (id TEXT PRIMARY KEY, accumulated_input_tokens INTEGER,
     accumulated_output_tokens INTEGER, accumulated_cache_read_tokens INTEGER,
     accumulated_cache_write_tokens INTEGER)`,
  );
  const insert = db.query(`INSERT INTO sessions VALUES (?, ?, ?, ?, ?)`);
  for (const row of rows) insert.run(...row);
  db.close();
  return path;
}

test("goose usage maps accumulated tokens like pi", () => {
  const path = dbWith([["s1", 100, 50, 20, 5]]);
  const usage = readUsage(path, "s1");
  expect(usage?.input).toBe(125n);
  expect(usage?.cached_input).toBe(20n);
  expect(usage?.output).toBe(50n);
});

test("goose usage treats nulls as zero and misses as null", () => {
  const path = dbWith([["s1", null, null, null, null]]);
  const usage = readUsage(path, "s1");
  expect(usage?.input).toBe(0n);
  expect(usage?.cached_input).toBe(0n);
  expect(usage?.output).toBe(0n);
  expect(readUsage(path, "nope")).toBeNull();
  expect(readUsage(join(tmpdir(), "corgi-goose-usage-missing.db"), "s1")).toBeNull();
});
