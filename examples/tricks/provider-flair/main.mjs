export function setup(corgi) {
  corgi.subscribe("agent.changed");
}

export function loop(corgi, { agent }) {
  const flair = { claude: ["✦", "warm"], codex: ["◇", "accent"], pi: ["π", "hot"] }[agent.provider];
  if (!flair) return corgi.paint(agent, null);
  const [glyph, color] = flair;
  corgi.paint(agent, { color, suffix: [{ text: ` ${glyph}`, color }] });
}
