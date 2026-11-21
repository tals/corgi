import * as fs from "node:fs";
import * as transfer from "./machine_transfer";

/** Bun.mmap opens files read/write, which Linux forbids for a running executable.
 * A read-only snapshot also survives another builder replacing or truncating it. */
export function input(file: string): Buffer {
  const size = fs.statSync(file).size;
  if (size > 512 * 1024 * 1024) throw Error("ArtifactTooLarge");
  const bytes = fs.readFileSync(file);
  if (bytes.length > 512 * 1024 * 1024) throw Error("ArtifactTooLarge");
  return bytes;
}
export function write(fd: number, bytes: Uint8Array): void {
  let n = 0;
  while (n < bytes.byteLength) {
    const written = fs.writeSync(fd, bytes, n, bytes.byteLength - n);
    if (!written) throw Error("ShortWrite");
    n += written;
  }
}
export async function receive(
  transport: transfer.Transport,
  basis: string,
  destination: string,
  expectedBasis: string,
  expected: string,
): Promise<void> {
  if (![expectedBasis, expected].every(hash => /^[a-f0-9]{64}$/.test(hash))) throw Error("InvalidArtifactHash");
  const old = input(basis);
  if (new Bun.CryptoHasher("sha256").update(old).digest("hex") !== expectedBasis) throw Error("InstallationChanged");
  const fd = fs.openSync(destination, "wx", 0o700);
  try {
    await transfer.receive(transport, old, bytes => write(fd, bytes), expected);
    fs.fsyncSync(fd);
  } catch (error) {
    fs.unlinkSync(destination);
    throw error;
  } finally {
    fs.closeSync(fd);
  }
}
