import * as test from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as inputs from "../scripts/build_inputs";

test.test("dev cache invalidates native code separately from TypeScript and dependencies", () => {
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
    test.expect(inputs.source(root)).not.toBe(source);
    test.expect(native()).toBe(n);
    const changed = inputs.source(root);
    put("bun.lock", "changed");
    test.expect(inputs.source(root)).not.toBe(changed);
    test.expect(native()).toBe(n);
    put("native/.zig-cache/ignored.zig", "cached");
    put("native/zig-pkg/dependency/build.zig", "downloaded");
    test.expect(native()).toBe(n);
    put("native/build.zig", "changed");
    test.expect(native()).not.toBe(n);
    test.expect(inputs.native(root, "linux-arm64", false, "")).not.toBe(native());
    test.expect(inputs.native(root, "linux-x64", true, "")).not.toBe(native());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
