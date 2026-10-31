export function register(on, corgi) {
  on("snapshot", ({ agents }) => {
    const waiting = agents.filter(a => a.state === "blocked" || a.attention === "needs_input");
    if (!waiting.length) return corgi.clear("radar");
    const clean = text => text.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/gu, " ").slice(0, 100);
    corgi.draw("radar", {
      kind: "overlay", anchor: "top-right", lines: [
        [{ text: `${waiting.length} waiting for you`, color: corgi.palette.warm }],
        ...waiting.slice(0, 4).map(a => [corgi.brand.of(a.provider).icon, { text: ` ${clean(a.name || a.provider)}` }]),
      ],
    });
  });
}
