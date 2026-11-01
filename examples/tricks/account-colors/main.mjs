export function register(on, corgi) {
  const accountColor = corgi.palette.map("accounts");
  on("ui:agent.sidebar", async ({ agent, ui }) => {
    ui.marker(await accountColor([agent.provider, agent.account]));
  });
}
