import * as transfer from "../machine_transfer_file";

if (import.meta.main) {
  const [basis, destination, before, after] = process.argv.slice(2);
  await transfer.receive(
    {
      readable: Bun.stdin.stream(),
      writable: new WritableStream({ write: bytes => transfer.write(1, bytes) }),
    },
    basis,
    destination,
    before,
    after,
  );
}
