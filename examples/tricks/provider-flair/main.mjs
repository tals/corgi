export function register(on, corgi) {
  on("ui:agent.sidebar", ({ agent, ui }) => {
    const brand = corgi.brand.of(agent.provider);
    ui.color(brand.color);
    ui.append(`!(${brand.icon})`);
  });
  on("ui:agent.popover", ({ agent, ui }) => {
    const brand = corgi.brand.of(agent.provider);
    const account = agent.account;
    const label = [account?.email ?? account?.name ?? "Unresolved account", account?.plan ?? account?.type]
      .filter(Boolean)
      .map(corgi.escape)
      .join(" · ");
    ui.color(brand.color);
    ui.append(`!(${brand.icon}) **${brand.name}** · ${label}`);
    const usage = account?.usage;
    if (usage?.fetched_at && typeof usage.limits === "object") {
      const windows = usage.limits.windows.filter(Boolean);
      if (windows.length) ui.append("Last reported usage: " + windows.map(w => `${w.used}%`).join(" / "));
    }
  });
  on("ui:agent.pane", ({ agent, ui }) => {
    if (agent.state !== "blocked" && agent.attention !== "needs_input") return;
    ui.color(corgi.palette.warm);
    ui.append("**Waiting for you**");
  });
}
