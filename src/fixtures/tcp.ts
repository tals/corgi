import type { Server } from "node:net";

/** Starts a fake daemon's `server` on a free local port, and returns the port. */
export async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("NoAddress");
  return address.port;
}
