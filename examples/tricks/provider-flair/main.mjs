import { createInterface } from "node:readline";

createInterface({ input: process.stdin }).on("line", line => {
  if (JSON.parse(line).event !== "ready") return;
  for (const [provider, label, color] of [
    ["claude", " ✦", "warm"],
    ["codex", " ◇", "accent"],
    ["pi", " π", "hot"],
  ]) console.log(JSON.stringify({
    op: "ui.set", key: provider,
    view: { kind: "decorate", where: { provider }, color, suffix: [{ text: label, color }] },
  }));
});
