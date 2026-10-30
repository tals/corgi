/** Read actual isolated fixture PTY sizes; API layout defaults are not terminal sizes. */
import { closeSync, constants, openSync } from "node:fs";
import { n, ptr } from "../../src/native_ffi";

export function read(pids: number[], match = false) {
  const dimensions = new Uint16Array(2);
  return pids.map(pid => {
    const fd = openSync(`/proc/${pid}/fd/0`, constants.O_RDONLY | constants.O_NOCTTY);
    try {
      if (n.probe_winsize(fd, ptr(dimensions)) !== 0) throw Error(`Cannot read PTY dimensions for ${pid}`);
      const [cols, rows] = dimensions;
      if (match && (cols !== 132 || rows !== 47)) throw Error(`PTY ${pid} is ${cols}x${rows}, expected 132x47`);
      return { pid, cols, rows };
    } finally {
      closeSync(fd);
    }
  });
}
