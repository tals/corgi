let count = 0;

function draw(corgi) {
  corgi.draw("jar", {
    kind: "overlay", anchor: "bottom-right",
    lines: [[{ text: `${"✦".repeat(Math.min(count, 10))} ${count} tasks finished`, color: "accent" }]],
  });
}

export async function setup(corgi) {
  count = await corgi.get("count", 0);
  corgi.subscribe("agent.changed");
  draw(corgi);
}

export async function loop(corgi, { agent, previous }) {
  if (!previous || agent.session !== previous.session || BigInt(agent.completed) <= BigInt(previous.completed)) return;
  await corgi.set("count", ++count);
  draw(corgi);
}
