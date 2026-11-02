export async function register(on, corgi) {
  const ui = corgi.ui;
  let count = await corgi.get("count", 0);
  const draw = () => corgi.draw("jar", {
    kind: "overlay", anchor: "bottom-right",
    content: ui.row(
      ui.text(`${"✦".repeat(Math.min(count, 10))} ${count} tasks finished`, corgi.palette.accent),
      ui.button("Reset", async () => {
        await corgi.set("count", 0);
        count = 0;
        draw();
      }),
    ),
  });
  draw();
  on("agent.changed", async ({ agent, previous }) => {
    if (!previous || agent.session !== previous.session || BigInt(agent.completed) <= BigInt(previous.completed)) return;
    await corgi.set("count", ++count);
    draw();
  });
}
