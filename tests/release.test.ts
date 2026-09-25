import { test, expect } from "bun:test";
import { publish, releaseVersion, installer, loadCredentials, type Store } from "../scripts/release.ts";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const bytes = (s: string) => new TextEncoder().encode(s);
class MemoryStore implements Store {
  files = new Map<string, Uint8Array>();
  writes: string[] = [];
  fail = "";
  async get(key: string) { return this.files.get(key) ?? null; }
  async put(key: string, value: Uint8Array) { this.writes.push(key); this.files.set(key, value); }
  async publicGet(key: string) { if (key === this.fail) throw new Error("Offline"); return this.files.get(key)!; }
}
const assets = ["macos", "linux", "manifest.json"].map(name => ({ key: `releases/1.2.3/${name}`, bytes: bytes(name), type: "application/octet-stream" }));
test("publication verifies every platform before advancing the channel", async () => {
  const store = new MemoryStore();
  await publish(store, assets, bytes("signed feed"), bytes("installer"));
  expect(store.writes.at(-1)).toBe("channels/stable.json");
  expect(store.writes.slice(0, 3)).toEqual(assets.map(a => a.key));
});
test("failed public download leaves channel untouched; retry reuses identical uploads", async () => {
  const store = new MemoryStore();
  store.files.set("channels/stable.json", bytes("old"));
  store.fail = assets[1].key;
  await expect(publish(store, assets, bytes("new"), bytes("installer"))).rejects.toThrow("Offline");
  expect(store.files.get("channels/stable.json")).toEqual(bytes("old"));
  store.fail = "";
  await publish(store, assets, bytes("new"), bytes("installer"));
  expect(store.writes.filter(k => k === assets[0].key).length).toBe(1);
});
test("immutable release collision never changes the channel", async () => {
  const store = new MemoryStore();
  store.files.set(assets[0].key, bytes("different"));
  await expect(publish(store, assets, bytes("new"), bytes("installer"))).rejects.toThrow("Refusing to overwrite");
  expect(store.writes).toEqual([]);
});
test("versions are stable semantic versions and cannot become paths", () => {
  for (const v of ["../1.0.0", "v1.0.0", "01.2.3", "1.0.0-beta", "1.2.3/4"]) expect(() => releaseVersion(v)).toThrow();
  expect(releaseVersion("1.2.3")).toBe("1.2.3");
});
test("installer pins both checksums and shell-quotes the base URL", () => {
  const script = installer("https://example.com/a'b", "1.2.3", { "macos-aarch64": { sha256: "mac" }, "linux-x86_64": { sha256: "linux" } });
  expect(script).toContain("'https://example.com/a'\\''b'");
  expect(script).toContain("${CORGI_INSTALL_ROOT:-$HOME/.local/share/corgi}");
  const p = Bun.spawnSync(["/bin/sh", "-n"], { stdin: Buffer.from(script) });
  expect(p.exitCode).toBe(0);
});
test("private file credentials work without exporting secrets into the shell", async () => {
  const dir = await mkdtemp(join(tmpdir(), "corgi-credentials-test-"));
  const path = join(dir, "credentials.json");
  try {
    await writeFile(path, JSON.stringify({ accessKeyId: "test-id", secretAccessKey: "test-secret" }), { mode: 0o600 });
    expect(await loadCredentials({ credentialsFile: path }, {})).toEqual({ accessKeyId: "test-id", secretAccessKey: "test-secret" });
    expect(await loadCredentials({ credentialsFile: path }, { AWS_ACCESS_KEY_ID: "env-id", AWS_SECRET_ACCESS_KEY: "env-secret" })).toEqual({ accessKeyId: "env-id", secretAccessKey: "env-secret" });
    await expect(loadCredentials({ credentialsFile: path }, { AWS_ACCESS_KEY_ID: "partial" })).rejects.toThrow("Set both");
    await chmod(path, 0o644);
    await expect(loadCredentials({ credentialsFile: path }, {})).rejects.toThrow("private");
    await chmod(path, 0o600);
    await writeFile(path, '{"secretAccessKey":"sensitive-malformed-value');
    await expect(loadCredentials({ credentialsFile: path }, {})).rejects.toThrow("must contain valid JSON");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
