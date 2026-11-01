export function register(on, corgi) {
  on("ui:agent.sidebar", ({ agent, ui }) => {
    const brand = corgi.brand.of(agent.provider);
    ui.color(brand.color);
    ui.append(`!(${brand.icon})`);
  });
  on("ui:agent.popover", ({ agent, ui }) => {
    const brand = corgi.brand.of(agent.provider);
    const account = agent.account?.name ?? "Unresolved account";
    ui.color(brand.color);
    ui.append(`!(${brand.icon}) **${brand.name}** · ${corgi.escape(account)}`);
  });
  on("ui:agent.pane", ({ agent, ui }) => {
    if (agent.state !== "blocked" && agent.attention !== "needs_input") return;
    ui.color(corgi.palette.warm);
    ui.append("**Waiting for you**");
  });
}
