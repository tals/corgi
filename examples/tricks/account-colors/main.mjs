import { createInterface } from "node:readline";

createInterface({ input: process.stdin }).on("line", line => {
  const event = JSON.parse(line);
  if (event.event !== "ready") return;
  for (const [index, rule] of event.config.rules.entries())
    console.log(JSON.stringify({
      op: "ui.set", key: `account-${index}`,
      view: { kind: "decorate", ...rule },
    }));
});
