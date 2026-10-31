import { createInterface } from "node:readline";

createInterface({ input: process.stdin }).on("line", line => {
  const event = JSON.parse(line);
  if (event.event !== "snapshot") return;
  const waiting = event.agents.filter(a => a.state === "blocked" || a.attention === "needs_input");
  const clean = text => text.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/gu, " ").slice(0, 100);
  console.log(JSON.stringify(waiting.length ? {
    op: "ui.set", key: "radar",
    view: { kind: "overlay", anchor: "top-right", lines: [
      [{ text: `${waiting.length} waiting for you`, color: "warm" }],
      ...waiting.slice(0, 4).map(a => [{ text: `• ${clean(a.name || a.provider)}` }]),
    ] },
  } : { op: "ui.remove", key: "radar" }));
});
