export async function register(on, corgi) {
  const colors = await corgi.get("colors", {});
  const key = agent => JSON.stringify([agent.provider, agent.account]);

  on("ui:agent.sidebar", ({ agent, ui }) => {
    const color = colors[key(agent)];
    if (color) ui.marker(color);
  });

  on("ui:agent.popover", ({ agent, ui }) => {
    const choose = async color => {
      const saved = { ...colors, [key(agent)]: color };
      await corgi.set("colors", saved);
      Object.assign(colors, saved);
    };
    ui.append(ui.column(
      "**Color this account**",
      ui.row(
        ui.button("Accent", () => choose(corgi.palette.accent)),
        ui.button("Warm", () => choose(corgi.palette.warm)),
        ui.button("Brand", () => choose(corgi.brand.of(agent.provider).color)),
        ui.button("Default", () => choose(null)),
      ),
    ));
  });
}
