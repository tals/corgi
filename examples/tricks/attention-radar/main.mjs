export function register(on, corgi) {
  on("snapshot", ({ agents }) => {
    const waiting = agents.filter(a => a.state === "blocked" || a.attention === "needs_input");
    if (!waiting.length) return corgi.clear("radar");
    corgi.draw("radar", {
      kind: "overlay", anchor: "top-right", color: corgi.palette.warm,
      text: [`**${waiting.length} waiting for you**`,
        ...waiting.slice(0, 4).map(a => `!(${corgi.brand.of(a.provider).icon}) ${corgi.escape((a.name || a.provider).slice(0, 100))}`),
      ].join("\n"),
    });
  });
}
