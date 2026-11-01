export async function register(on, corgi) {
  const colors = await corgi.get("colors", {});
  const key = agent => JSON.stringify([agent.provider, agent.account]);
  const p = corgi.palette.syntax;

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
        ui.button("Blue", () => choose(p.string)),
        ui.button("Purple", () => choose(p.keyword)),
        ui.button("Cyan", () => choose(p.type)),
      ),
      ui.row(
        ui.button("Pink", () => choose(p.number)),
        ui.button("Slate", () => choose(p.property)),
        ui.button("Default", () => choose(null)),
      ),
    ));
  });
}
