/** Private sandbox control socket. Real machines never install a fault proxy. */
import { createConnection } from "node:net";
export interface Faults {
  latency_ms: number;
  bandwidth_kib: number;
  outage_until: number;
  hang_seconds: number;
  hang_every_seconds: number;
  next_hang_at: number;
  accepted: number;
}
export interface Command {
  machine?: string;
  latency_ms?: number;
  bandwidth_kib?: number;
  outage_seconds?: number;
  hang_seconds?: number;
  hang_every_seconds?: number;
  drop?: boolean;
}
export function request(path: string, command: Command = {}): Promise<Record<string, Faults>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let data = "";
    const timer = setTimeout(() => socket.destroy(Error("SandboxControlTimedOut")), 1500);
    socket.on("connect", () => socket.write(JSON.stringify(command) + "\n"));
    socket.on("error", reject);
    socket.on("close", () => {
      clearTimeout(timer);
      reject(Error("SandboxControlClosed"));
    });
    socket.on("data", bytes => {
      data += bytes.toString();
      if (data.length > 65536) return socket.destroy(Error("SandboxReplyTooLarge"));
      if (!data.includes("\n")) return;
      try {
        const value = JSON.parse(data.slice(0, data.indexOf("\n")));
        if (value.error) reject(Error(value.error));
        else resolve(value);
      } catch (error) {
        reject(error);
      }
      socket.destroy();
    });
  });
}
