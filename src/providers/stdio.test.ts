import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Claude } from "./claude/headless";
import { Pi } from "./pi/headless";
import { Stdio } from "./stdio";
import { max_image_bytes } from "./adapter";
import { n } from "../native_bridge";

test("Claude and Pi queue a full-size image and the following control message", () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-stdio-")),
    file = join(dir, "large.png");
  writeFileSync(file, Buffer.alloc(max_image_bytes, 42));
  try {
    for (const provider of ["claude", "pi"]) {
      const io = new Stdio(),
        client = provider === "claude" ? new Claude(io, null, true) : new Pi(io, dir);
      client.send({ kind: "prompt", text: "look", images: [{ path: file, mime: "image/png" }] });
      io.write({ control: "next" });
      const [prompt, control] = io.output
          .toString()
          .trimEnd()
          .split("\n")
          .map(line => JSON.parse(line)),
        data = provider === "claude" ? prompt.message.content[1].source.data : prompt.images[0].data;
      expect(Buffer.from(data, "base64").length).toBe(max_image_bytes);
      expect(control).toEqual({ control: "next" });
      client.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("large queued images survive handoff without entering its JSON manifest", () => {
  const io = new Stdio();
  io.input = Buffer.from([0xf0, 0x9f]);
  io.output = Buffer.alloc(28 * 1024 * 1024, 42);
  let restored: Stdio | undefined;
  try {
    const saved = io.save(true);
    expect(JSON.stringify(saved).length).toBeLessThan(1024);
    expect(saved.handles).toHaveLength(3);
    // A new process receives duplicates, not the old daemon's descriptors.
    saved.handles = saved.handles.map(fd => (fd < 0 ? fd : n.probe_dup_above(fd, 64)));
    restored = Stdio.restore(saved, true);
    expect(restored.input.equals(io.input)).toBe(true);
    expect(restored.output.equals(io.output)).toBe(true);
    restored.adopt();
    io.close();
    restored.write({ control: "still writable" });
    expect(restored.output.toString("utf8", restored.output.length - 29)).toContain("still writable");
  } finally {
    restored?.close();
    io.close();
  }
});
