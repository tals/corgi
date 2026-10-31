export function setup(corgi) {
  corgi.subscribe("agent.changed", { provider: "claude" });
}

export function loop(corgi, { agent }) {
  corgi.paint(agent, { marker: agent.account ? "#83b6ef" : "accent" });
}
