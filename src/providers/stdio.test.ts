import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Claude } from "./claude/headless";
import { Pi } from "./pi/headless";
import { Stdio } from "./stdio";
import { max_image_bytes } from "./adapter";

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
