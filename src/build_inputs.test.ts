import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as inputs from "../scripts/build_inputs";

test("dev cache invalidates native code separately from TypeScript and dependencies", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "corgi-inputs-"));
  const put = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  const native = () => inputs.native(root, "linux-x64", false, "");
  try {
    put("src/main.ts", "original");
    put("native/build.zig", "original");
    put("bun.lock", "original");
    const n = native(),
      source = inputs.source(root);
    put("src/main.ts", "changed");
    expect(inputs.source(root)).not.toBe(source);
    expect(native()).toBe(n);
    const changed = inputs.source(root);
    put("bun.lock", "changed");
    expect(inputs.source(root)).not.toBe(changed);
    expect(native()).toBe(n);
    put("native/.zig-cache/ignored.zig", "cached");
    put("native/zig-pkg/dependency/build.zig", "downloaded");
    expect(native()).toBe(n);
    put("native/build.zig", "changed");
    expect(native()).not.toBe(n);
    expect(inputs.native(root, "linux-arm64", false, "")).not.toBe(native());
    expect(inputs.native(root, "linux-x64", true, "")).not.toBe(native());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
