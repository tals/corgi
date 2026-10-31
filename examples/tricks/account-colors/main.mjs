export function register(on, corgi) {
  on("ui:agent.sidebar", ({ agent, ui }) => {
    if (agent.provider !== "claude") return;
    ui.marker(agent.account ? "#83b6ef" : corgi.palette.accent);
  });
}
