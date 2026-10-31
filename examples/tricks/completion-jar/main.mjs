import { createInterface } from "node:readline";

let count = 0;
const send = value => console.log(JSON.stringify(value));
const draw = count => send({ op: "ui.set", key: "jar", view: {
  kind: "overlay", anchor: "bottom-right",
  lines: [[{ text: `${"✦".repeat(Math.min(count, 10))} ${count} tasks finished`, color: "accent" }]],
} });
createInterface({ input: process.stdin }).on("line", line => {
  const event = JSON.parse(line);
  if (event.event === "ready") {
    count = Number.isSafeInteger(event.kv.count) ? event.kv.count : 0;
    draw(count);
  } else if (event.event === "agent.changed" && event.previous &&
    event.agent.session === event.previous.session &&
    BigInt(event.agent.completed) > BigInt(event.previous.completed)) {
    send({ id: ++count, op: "kv.set", key: "count", value: count });
  } else if (event.ok && typeof event.id === "number") draw(event.id);
});
