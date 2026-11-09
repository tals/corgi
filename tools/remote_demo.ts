/** A quiet, live link for each sandbox machine. */
const name = process.argv[2];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () =>
    new Response(`<html><title>${name} · remote lab</title><h1>${name}</h1><p>The demo server is ready.</p></html>`, {
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
});
console.log(`${name} demo: http://localhost:${server.port}`);
