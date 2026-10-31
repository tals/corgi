export function register(on, corgi) {
  on("agent.changed", ({ agent }) => {
    if (agent.provider !== "claude") return corgi.paint(agent, null);
    corgi.paint(agent, { marker: agent.account ? "#83b6ef" : corgi.palette.accent });
  });
}
