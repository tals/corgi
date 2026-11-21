export function register(on, corgi) {
  const accountColor = corgi.palette.map("accounts");
  on("ui:agent.sidebar", async ({ agent, ui }) => {
    if (agent.account) ui.marker(await accountColor(agent.account.id));
  });
}
