export async function register(on, corgi) {
  let count = await corgi.get("count", 0);
  const draw = () => corgi.draw("jar", {
    kind: "overlay", anchor: "bottom-right",
    lines: [[{ text: `${"✦".repeat(Math.min(count, 10))} ${count} tasks finished`, color: corgi.palette.accent }]],
  });
  draw();
  on("agent.changed", async ({ agent, previous }) => {
    if (!previous || agent.session !== previous.session || BigInt(agent.completed) <= BigInt(previous.completed)) return;
    await corgi.set("count", ++count);
    draw();
  });
}
