export function register(on, corgi) {
  const ui = corgi.ui;
  on("snapshot", ({ agents }) => {
    const waiting = agents.filter(a => a.state === "blocked" || a.attention === "needs_input");
    if (!waiting.length) return corgi.clear("radar");
    corgi.draw("radar", {
      kind: "overlay", anchor: "top-right",
      content: ui.column(
        ui.text(`**${waiting.length} waiting for you**`, corgi.palette.warm),
        ...waiting.slice(0, 4).map(a => ui.row(
          ui.icon(corgi.brand.of(a.provider).icon),
          ui.button(corgi.escape((a.name || a.provider).slice(0, 32)), () => corgi.focus(a)),
        )),
      ),
    });
  });
}
