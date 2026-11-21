// The compiled CLI is a separate Bun entrypoint so a format probe loads only the registry.
if (process.argv.length === 3 && process.argv[2] === "__handoff-info") {
  const handoff = await import("./persist/handoff_info");
  console.log(JSON.stringify(handoff.info()));
} else {
  const entry = new URL("./main.js", import.meta.url);
  const app: typeof import("./main") = await import(entry.href);
  app.main();
}
