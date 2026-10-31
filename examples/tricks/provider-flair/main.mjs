export function register(on, corgi) {
  on("agent.changed", ({ agent }) => {
    const brand = corgi.brand.of(agent.provider);
    corgi.paint(agent, { color: brand.color, suffix: [{ text: " " }, brand.icon] });
  });
}
