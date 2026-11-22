import { afterEach, expect, test } from "bun:test";
import { connect, createServer, type AddressInfo, type Server } from "node:net";
import * as portForwards from "./port_forwards";

const servers: { stop(): void }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
});

/** A link to "the machine", which is this one: `ports` maps the machine's
 * ports to where they're served here. */
function fakeLink(ports: Map<number, number>, refuse = new Set<number>()) {
  const dialed: string[] = [];
  let prepared = 0;
  const link: portForwards.Link = {
    async prepare() {
      prepared++;
    },
    dial(host, port) {
      dialed.push(`${host}:${port}`);
      const socket = connect({ host: "127.0.0.1", port: ports.get(port) ?? 1 });
      let settle: (failure: portForwards.Failure | null) => void = () => {};
      const done = new Promise<portForwards.Failure | null>(resolve => (settle = resolve));
      if (refuse.has(port)) {
        socket.destroy();
        settle("refused");
      }
      socket.once("close", () => settle(null));
      socket.once("error", () => settle("refused"));
      return { input: socket, output: socket, done, close: () => socket.destroy() };
    },
  };
  return { link, dialed, prepared: () => prepared };
}
function serve(body: string) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: request => new Response(`${body} ${new URL(request.url).pathname}`),
  });
  servers.push({ stop: () => server.stop(true) });
  return server.port!;
}
/** A request on a connection of its own, which closes after. */
const close = { keepalive: false, headers: { connection: "close" } };
/** Waits for `ready`, a few milliseconds at a time. */
async function until(ready: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !ready(); i++) await Bun.sleep(5);
  expect(ready()).toBe(true);
}
/** A port nothing on this computer listens on, as far as one can tell. */
async function freePort(): Promise<number> {
  const server: Server = createServer();
  await new Promise<void>(resolve => server.listen({ host: "127.0.0.1", port: 0 }, resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test("links to the machine's own loopback are forwarded; others aren't", () => {
  expect(portForwards.target("http://localhost:5173/app?x=1#top")).toEqual({ host: "localhost", port: 5173 });
  expect(portForwards.target("http://app.localhost:3000")).toEqual({ host: "localhost", port: 3000 });
  expect(portForwards.target("http://127.0.0.1:8000")).toEqual({ host: "localhost", port: 8000 });
  expect(portForwards.target("http://127.0.0.2:8000")).toEqual({ host: "127.0.0.2", port: 8000 });
  expect(portForwards.target("http://[::1]:9000")).toEqual({ host: "localhost", port: 9000 });
  expect(portForwards.target("http://0.0.0.0:8000/")).toEqual({ host: "localhost", port: 8000 });
  expect(portForwards.target("http://[::]:8000/")).toEqual({ host: "localhost", port: 8000 });
  expect(portForwards.target("https://localhost/")).toEqual({ host: "localhost", port: 443 });
  expect(portForwards.target("http://LOCALHOST")).toEqual({ host: "localhost", port: 80 });
  for (const url of [
    "https://example.com",
    "http://10.0.0.2:3000",
    "http://localhost.example.com:3000",
    "ftp://localhost",
    "nonsense",
  ])
    expect(portForwards.target(url)).toBeNull();
});

test("a forwarded link changes only its host and port, as the machine wrote it", () => {
  expect(portForwards.rewrite("http://localhost:5173/app?x=1#top", 5173, true)).toBe(
    "http://localhost:5173/app?x=1#top",
  );
  expect(portForwards.rewrite("http://localhost:3000", 49152, true)).toBe("http://localhost:49152");
  expect(portForwards.rewrite("http://0.0.0.0:8000/", 8000, true)).toBe("http://localhost:8000/");
  expect(portForwards.rewrite("http://[::1]:8000/", 8000, true)).toBe("http://[::1]:8000/");
  expect(portForwards.rewrite("http://[::1]:8000/", 8000, false)).toBe("http://127.0.0.1:8000/");
  expect(portForwards.rewrite("http://127.0.0.2:8000/", 8001, true)).toBe("http://127.0.0.1:8001/");
  expect(portForwards.rewrite("https://localhost/", 8443, true)).toBe("https://localhost:8443/");
  expect(portForwards.rewrite("http://user:pw@localhost:3000/a", 3001, true)).toBe("http://user:pw@localhost:3001/a");
  // Escapes stay as they were, where a parser might write them again.
  expect(portForwards.rewrite("http://localhost:3000/q?a=%26b%2B&c=d e", 3001, true)).toBe(
    "http://localhost:3001/q?a=%26b%2B&c=d e",
  );
});

test("a sign-in link's loopback callback is found in its query or fragment", () => {
  const redirect = "http://localhost:1455/auth/callback";
  expect(
    portForwards.callbacks(
      `https://auth.example.com/oauth/authorize?client_id=x&redirect_uri=${encodeURIComponent(redirect)}&state=y`,
    ),
  ).toEqual([redirect]);
  expect(portForwards.callbacks(`https://auth.example.com/#redirect_uri=${encodeURIComponent(redirect)}`)).toEqual([
    redirect,
  ]);
  expect(portForwards.callbacks("https://auth.example.com/?next=https%3A%2F%2Fexample.com%2F")).toEqual([]);
  expect(portForwards.callbacks(`myapp://open?u=${encodeURIComponent(redirect)}`)).toEqual([]);
});

test("a hovered link reserves a port here; its first request realizes it", async () => {
  const there = await freePort(),
    served = serve("hello");
  const { link, dialed, prepared } = fakeLink(new Map([[there, served]]));
  const forwards = new portForwards.Forwards(link),
    realized: number[] = [];
  forwards.onRealized = forward => realized.push(forward.port);
  const url = `http://localhost:${there}/app`;
  try {
    // A Cmd+click opens a link elsewhere as it is, and one here nowhere until it's reserved.
    expect(forwards.opens("https://example.com/")).toBe("https://example.com/");
    expect(forwards.opens(url)).toBeNull();
    forwards.reserve(url);
    await until(() => forwards.local(url) !== null);
    expect(forwards.opens(url)).toBe(url);
    // Free here, the port keeps its number, and the link its address.
    expect(forwards.local(url)).toBe(url);
    expect(forwards.local(`http://0.0.0.0:${there}/x`)).toBe(`http://localhost:${there}/x`);
    // Nothing is listed or reaches the machine until a request comes.
    expect(forwards.list).toEqual([]);
    expect(prepared()).toBe(0);
    expect(await (await fetch(`http://127.0.0.1:${there}/app`)).text()).toBe("hello /app");
    expect(realized).toEqual([there]);
    expect(forwards.list.map(f => [f.port, f.local, f.realized])).toEqual([[there, there, true]]);
    expect(dialed).toEqual([`localhost:${there}`]);
    await fetch(`http://127.0.0.1:${there}/again`);
    expect(prepared()).toBe(1);
    expect(realized).toEqual([there]);
  } finally {
    forwards.close();
  }
});

test("a port probe or a browser's preconnect realizes nothing", async () => {
  const there = await freePort();
  const { link, dialed } = fakeLink(new Map([[there, serve("x")]]));
  const forwards = new portForwards.Forwards(link),
    url = `http://localhost:${there}/`;
  try {
    forwards.reserve(url);
    await until(() => forwards.local(url) !== null);
    const socket = connect({ host: "127.0.0.1", port: there });
    await new Promise(resolve => socket.once("connect", resolve));
    socket.destroy();
    await Bun.sleep(20);
    expect(forwards.list).toEqual([]);
    expect(dialed).toEqual([]);
  } finally {
    forwards.close();
  }
});

test("a connection closed without a word is let go, and keeps no reservation", async () => {
  const there = await freePort();
  const { link, dialed } = fakeLink(new Map([[there, serve("x")]]));
  let now = 1_000;
  const forwards = new portForwards.Forwards(link, () => now),
    url = `http://localhost:${there}/`;
  try {
    forwards.reserve(url);
    await until(() => forwards.local(url) !== null);
    const socket = connect({ host: "127.0.0.1", port: there });
    await new Promise(resolve => socket.once("connect", resolve));
    const closed = new Promise(resolve => socket.once("close", resolve));
    socket.end();
    await Promise.race([closed, Bun.sleep(1000)]);
    expect(socket.closed).toBe(true);
    now += portForwards.reserved_ms;
    forwards.expire();
    expect(forwards.local(url)).toBeNull();
    expect(dialed).toEqual([]);
  } finally {
    forwards.close();
  }
});

test("a request that half-closes after it's sent still gets its reply", async () => {
  const there = await freePort();
  const { link } = fakeLink(new Map([[there, serve("x")]]));
  const forwards = new portForwards.Forwards(link),
    url = `http://localhost:${there}/`;
  try {
    forwards.reserve(url);
    await until(() => forwards.local(url) !== null);
    const socket = connect({ host: "127.0.0.1", port: there, allowHalfOpen: true });
    await new Promise(resolve => socket.once("connect", resolve));
    let reply = "";
    socket.on("data", chunk => (reply += chunk));
    const closed = new Promise(resolve => socket.once("close", resolve));
    socket.end("GET /a HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    await Promise.race([closed, Bun.sleep(2000)]);
    expect(reply).toContain("x /a");
  } finally {
    forwards.close();
  }
});

test("a click realizes the link's forward and opens it here, on another port when its own is in use", async () => {
  // The machine's port is served on this computer too, so it's taken here.
  const served = serve("there");
  const { link } = fakeLink(new Map([[served, served]]));
  const forwards = new portForwards.Forwards(link);
  try {
    const opened = (await forwards.open(`http://localhost:${served}/`))!;
    const [forward] = forwards.list;
    expect(forward.local).not.toBe(served);
    // The next port up, when it's free.
    const next = createServer();
    const free = await new Promise<boolean>(resolve =>
      next.once("error", () => resolve(false)).listen({ host: "127.0.0.1", port: served + 1 }, () => resolve(true)),
    );
    if (free) next.close();
    expect(forward.local === served + 1).toBe(!free);
    expect(opened).toEqual({ url: `http://localhost:${forward.local}/`, unavailable: [] });
    expect(await (await fetch(`http://127.0.0.1:${forward.local}/`)).text()).toBe("there /");
    forwards.stop(forward);
    expect(forwards.list).toEqual([]);
    await expect(fetch(`http://127.0.0.1:${forward.local}/`)).rejects.toThrow();
    expect(await forwards.open("https://example.com/")).toBeNull();
  } finally {
    forwards.close();
  }
});

test("an unrealized reservation expires, and gives its port up to a forward that wants it", async () => {
  let now = 1000;
  const there = await freePort(),
    url = `http://localhost:${there}/`;
  const atlas = new portForwards.Forwards(fakeLink(new Map([[there, serve("atlas")]])).link, () => now),
    borealis = new portForwards.Forwards(fakeLink(new Map([[there, serve("borealis")]])).link, () => now);
  try {
    atlas.reserve(url);
    await until(() => atlas.local(url) !== null);
    // Resting on it again keeps it longer.
    now += portForwards.reserved_ms - 1;
    atlas.reserve(url);
    await Bun.sleep(5);
    now += portForwards.reserved_ms - 1;
    atlas.expire();
    expect(atlas.local(url)).toBe(url);
    now += 2;
    atlas.expire();
    expect(atlas.local(url)).toBeNull();
    await expect(fetch(`http://127.0.0.1:${there}/`)).rejects.toThrow();
    // Another machine's link takes an unrealized reservation's port.
    atlas.reserve(url);
    await until(() => atlas.local(url) === url);
    borealis.reserve(url);
    await until(() => borealis.local(url) === url);
    expect(atlas.local(url)).toBeNull();
    // Realized, it's kept: the other machine's link gets another port.
    await borealis.open(url);
    atlas.reserve(url);
    await until(() => atlas.local(url) !== null);
    expect(atlas.local(url)).not.toBe(url);
    expect(await (await fetch(`http://127.0.0.1:${there}/`)).text()).toBe("borealis /");
    now += portForwards.reserved_ms * 2;
    borealis.expire();
    expect(borealis.list.length).toBe(1);
  } finally {
    atlas.close();
    borealis.close();
  }
});

test("a sign-in link opens as it is, its callback's port forwarded unchanged", async () => {
  const there = await freePort(),
    callback = `http://localhost:${there}/auth/callback`,
    url = `https://auth.example.com/authorize?redirect_uri=${encodeURIComponent(callback)}`;
  const { link } = fakeLink(new Map([[there, serve("signed in")]]));
  const forwards = new portForwards.Forwards(link);
  try {
    // Hovering it reserves the callback's own port; the link itself stays.
    forwards.reserve(url);
    await until(() => forwards.local(callback) === callback);
    expect(forwards.local(url)).toBeNull();
    expect(await forwards.open(url)).toEqual({ url, unavailable: [] });
    expect(forwards.list.map(f => [f.port, f.local])).toEqual([[there, there]]);
    expect(await (await fetch(`http://127.0.0.1:${there}/auth/callback?code=1`)).text()).toBe(
      "signed in /auth/callback",
    );
  } finally {
    forwards.close();
  }
  // In use here, the callback can't come back: the click says so.
  const taken = serve("local"),
    blocked = `https://auth.example.com/authorize?redirect_uri=${encodeURIComponent(`http://localhost:${taken}/cb`)}`;
  const other = new portForwards.Forwards(fakeLink(new Map()).link);
  try {
    // Hovering it says so before the click.
    other.reserve(blocked);
    await until(() => other.unavailable(blocked).length > 0);
    expect(other.unavailable(blocked)).toEqual([taken]);
    expect(await other.open(blocked)).toEqual({ url: blocked, unavailable: [taken] });
    expect(other.list).toEqual([]);
  } finally {
    other.close();
  }
});

test("a port nothing listens on there says so, until one answers", async () => {
  const there = await freePort(),
    refuse = new Set([there]);
  const { link } = fakeLink(new Map([[there, serve("late")]]), refuse);
  const forwards = new portForwards.Forwards(link);
  try {
    const { url } = (await forwards.open(`http://localhost:${there}`))!;
    const [forward] = forwards.list;
    await fetch(url.replace("localhost", "127.0.0.1")).catch(() => {});
    await until(() => forward.failure !== null);
    expect(forward.failure).toBe("refused");
    refuse.clear();
    expect(await (await fetch(url.replace("localhost", "127.0.0.1"))).text()).toBe("late /");
    expect(forward.failure).toBeNull();
  } finally {
    forwards.close();
  }
});

test("a machine that can't be reached fails the request, and is tried again for the next", async () => {
  let attempts = 0;
  const there = await freePort();
  const forwards = new portForwards.Forwards({
    prepare: () => (attempts++ ? Promise.resolve() : Promise.reject(Error("MachineUnreachable"))),
    dial: fakeLink(new Map([[there, serve("back")]])).link.dial,
  });
  try {
    const { url } = (await forwards.open(`http://localhost:${there}/`))!;
    await expect(fetch(url.replace("localhost", "127.0.0.1"))).rejects.toThrow();
    expect(forwards.list[0].failure).toBe("unreachable");
    expect(await (await fetch(url.replace("localhost", "127.0.0.1"))).text()).toBe("back /");
    expect(attempts).toBe(2);
  } finally {
    forwards.close();
  }
});

test("a reservation lasts while the pointer rests on its link, and a minute after it leaves", async () => {
  let now = 1000;
  const there = await freePort(),
    url = `http://localhost:${there}/`;
  const forwards = new portForwards.Forwards(fakeLink(new Map()).link, () => now);
  try {
    forwards.hover(url);
    await until(() => forwards.local(url) !== null);
    now += portForwards.hover_ms - 1;
    // Checked again where the pointer rests, it isn't a move.
    forwards.hover(url, false);
    forwards.expire();
    expect(forwards.local(url)).toBe(url);
    forwards.hover(url);
    forwards.hover(null);
    now += portForwards.reserved_ms - 1;
    forwards.expire();
    expect(forwards.local(url)).toBe(url);
    now += 1;
    forwards.expire();
    expect(forwards.local(url)).toBeNull();
    // A pointer that left the window from the link stops holding it after a while.
    forwards.hover(url);
    await until(() => forwards.local(url) !== null);
    now += portForwards.hover_ms;
    forwards.hover(url, false);
    forwards.expire();
    expect(forwards.local(url)).toBeNull();
    // Checked again at rest it stays gone; moving within the link brings it back.
    forwards.hover(url, false);
    await Bun.sleep(20);
    expect(forwards.local(url)).toBeNull();
    forwards.hover(url);
    await until(() => forwards.local(url) === url);
  } finally {
    forwards.close();
  }
});

test("a click on a link to a port a sign-in had first makes a forward that lasts; a hover doesn't", async () => {
  let now = 1000;
  const there = await freePort(),
    app = `http://localhost:${there}/`,
    signin = `https://auth.example.com/?redirect_uri=${encodeURIComponent(`${app}cb`)}`;
  const forwards = new portForwards.Forwards(fakeLink(new Map([[there, serve("app")]])).link, () => now);
  try {
    forwards.hover(signin);
    await until(() => forwards.local(app) !== null);
    forwards.hover(null);
    await forwards.open(app);
    expect(forwards.list.length).toBe(1);
    now += portForwards.callback_ms * 2;
    forwards.expire();
    expect(forwards.list.length).toBe(1);
  } finally {
    forwards.close();
  }
  // Hovering a link to a sign-in's callback leaves it one, which goes once it's been idle a while.
  const callback = `${app}cb`,
    hovered = new portForwards.Forwards(fakeLink(new Map([[there, serve("done")]])).link, () => now);
  try {
    await hovered.open(signin);
    expect(await (await fetch(callback, close)).text()).toBe("done /cb");
    await until(() => hovered.list[0]?.open === 0);
    hovered.hover(app);
    hovered.hover(null);
    now += portForwards.callback_ms * 2;
    hovered.expire();
    expect(hovered.list).toEqual([]);
  } finally {
    hovered.close();
  }
});

test("a sign-in's callback forward goes once it's been idle a while, and never sits on a moved port", async () => {
  let now = 1000;
  const there = await freePort(),
    callback = `http://localhost:${there}/cb`,
    url = `https://auth.example.com/?redirect_uri=${encodeURIComponent(callback)}`;
  const forwards = new portForwards.Forwards(fakeLink(new Map([[there, serve("done")]])).link, () => now);
  try {
    await forwards.open(url);
    expect(await (await fetch(`http://127.0.0.1:${there}/cb`, close)).text()).toBe("done /cb");
    await until(() => forwards.list[0]?.open === 0);
    now += portForwards.callback_ms - 1;
    forwards.expire();
    expect(forwards.list.length).toBe(1);
    now += 1;
    forwards.expire();
    expect(forwards.list).toEqual([]);
  } finally {
    forwards.close();
  }
  // A link to the callback's port moved it here: the callback can't use that.
  const taken = serve("local"),
    moved = `https://auth.example.com/?redirect_uri=${encodeURIComponent(`http://localhost:${taken}/cb`)}`;
  const other = new portForwards.Forwards(fakeLink(new Map()).link);
  try {
    await other.open(`http://localhost:${taken}/`);
    expect(other.list[0].local).not.toBe(taken);
    expect(await other.open(moved)).toEqual({ url: moved, unavailable: [taken] });
  } finally {
    other.close();
  }
});

test("the way to the machine is readied again for connections after a while", async () => {
  let now = 1000,
    prepared = 0;
  const there = await freePort(),
    { link } = fakeLink(new Map([[there, serve("x")]]));
  const forwards = new portForwards.Forwards(
    {
      prepare: async () => {
        prepared++;
      },
      dial: link.dial,
    },
    () => now,
  );
  try {
    const { url } = (await forwards.open(`http://localhost:${there}/`))!;
    const local = url.replace("localhost", "127.0.0.1");
    await Promise.all([fetch(local, close), fetch(local, close), fetch(local, close)]);
    expect(prepared).toBe(1);
    now += 120_000;
    await fetch(local, close);
    expect(prepared).toBe(2);
  } finally {
    forwards.close();
  }
});

test("a callback is forwarded on the loopback address its link names, or says it can't be", async () => {
  expect(portForwards.returnAddress("http://localhost:1455/cb")).toBe("127.0.0.1");
  expect(portForwards.returnAddress("http://127.0.0.2:1455/cb")).toBe("127.0.0.2");
  expect(portForwards.returnAddress("http://[::1]:1455/cb")).toBe("::1");
  for (const host of ["127.0.0.2", "[::1]"]) {
    const there = await freePort(),
      callback = `http://${host}:${there}/cb`,
      url = `https://auth.example.com/?redirect_uri=${encodeURIComponent(callback)}`;
    const forwards = new portForwards.Forwards(fakeLink(new Map([[there, serve("back")]])).link);
    try {
      const { unavailable } = (await forwards.open(url))!;
      // Where this computer has no such address, the click says the link can't come back.
      if (unavailable.length) expect(unavailable).toEqual([there]);
      else expect(await (await fetch(`http://${host}:${there}/cb`, close)).text()).toBe("back /cb");
    } finally {
      forwards.close();
    }
  }
});

test("a link back into its own port isn't a callback", () => {
  const next = encodeURIComponent("http://localhost:3000/home");
  expect(portForwards.callbacks(`http://localhost:3000/login?next=${next}`)).toEqual([]);
  expect(portForwards.callbacks(`http://127.0.0.1:3000/login?next=${next}`)).toEqual([]);
  expect(portForwards.callbacks(`http://localhost:8080/login?next=${next}`)).toEqual(["http://localhost:3000/home"]);
});

test("a pointer at rest gets its link reserved again after another machine's forward took the port", async () => {
  const there = await freePort(),
    url = `http://localhost:${there}/`;
  const atlas = new portForwards.Forwards(fakeLink(new Map()).link),
    borealis = new portForwards.Forwards(fakeLink(new Map()).link);
  try {
    atlas.hover(url);
    await until(() => atlas.local(url) === url);
    await borealis.open(url);
    expect(atlas.local(url)).toBeNull();
    atlas.hover(url, false);
    await until(() => atlas.local(url) !== null);
    expect(atlas.local(url)).not.toBe(url);
  } finally {
    atlas.close();
    borealis.close();
  }
});

test("a link back into its own port warns when its forward had to move off that port", async () => {
  const taken = serve("this computer's"),
    next = encodeURIComponent(`http://localhost:${taken}/home`),
    url = `http://localhost:${taken}/login?next=${next}`;
  const forwards = new portForwards.Forwards(fakeLink(new Map()).link);
  try {
    expect(portForwards.returns(url)).toEqual([`http://localhost:${taken}/home`]);
    forwards.reserve(url);
    await until(() => forwards.local(url) !== null);
    expect(forwards.unavailable(url)).toEqual([taken]);
    const opened = (await forwards.open(url))!;
    expect(opened.unavailable).toEqual([taken]);
    expect(opened.url).not.toContain(`localhost:${taken}/login`);
    // The forward itself is an ordinary one: it stays.
    expect(forwards.list[0].realized).toBe(true);
  } finally {
    forwards.close();
  }
  // Where it keeps its port, the way back works and nothing's said.
  const free = await freePort(),
    kept = `http://localhost:${free}/login?next=${encodeURIComponent(`http://localhost:${free}/home`)}`;
  const other = new portForwards.Forwards(fakeLink(new Map()).link);
  try {
    expect(await other.open(kept)).toEqual({ url: kept, unavailable: [] });
  } finally {
    other.close();
  }
});

test("a forward keeps the link it was made for, whatever the browser asks it for", async () => {
  const there = await freePort(),
    home = `http://localhost:${there}/`,
    admin = `http://localhost:${there}/admin?x=1`;
  const forwards = new portForwards.Forwards(fakeLink(new Map([[there, serve("app")]])).link);
  try {
    forwards.hover(home);
    await until(() => forwards.local(home) !== null);
    forwards.hover(admin);
    expect(await (await fetch(`http://127.0.0.1:${there}/admin?x=1`, close)).text()).toBe("app /admin");
    expect(forwards.list[0].url).toBe(home);
    // A click in Corgi is seen.
    await forwards.open(admin);
    expect(forwards.list[0].url).toBe(admin);
  } finally {
    forwards.close();
  }
});

test("closing gives up on a way to the machine still being readied", async () => {
  const there = await freePort();
  let signal: AbortSignal | null = null;
  const forwards = new portForwards.Forwards({
    prepare: given =>
      new Promise((_, reject) => {
        signal = given;
        given.addEventListener("abort", () => reject(Error("ForwardsClosed")));
      }),
    dial: () => {
      throw Error("unreachable");
    },
  });
  const { url } = (await forwards.open(`http://localhost:${there}/`))!;
  const request = fetch(url.replace("localhost", "127.0.0.1"), close).catch(error => error);
  await until(() => signal !== null);
  forwards.close();
  expect(signal!.aborted).toBe(true);
  expect(await request).toBeInstanceOf(Error);
});
