import { BoundedText } from "../bounded_text";
const Text = BoundedText(160);
export class Model {
  id = new Text();
  name = new Text();
  window = 0n;
  constructor(fields: Partial<Model> = {}) {
    Object.assign(this, fields);
  }
  label() {
    return this.name.len ? this.name.text() : this.id.text();
  }
  static resolve(reported: string): Model {
    let id = reported;
    const million = id.endsWith("[1m]");
    if (million) id = id.slice(0, -4);
    const aliases: Record<string, string> = {
      opus: "Opus",
      sonnet: "Sonnet",
      haiku: "Haiku",
      fable: "Fable",
      opusplan: "Opus Plan Mode",
    };
    if (aliases[id])
      return new Model({
        id: Text.ascii(reported),
        name: new Text(aliases[id] + (million ? " (1M context)" : "")),
      });
    id = id.slice(id.lastIndexOf("/") + 1);
    id = id.replace(/^(?:[a-z-]+\.)?anthropic\.(?=claude-)/, "");
    if (id.startsWith("claude-")) {
      const tokens = id
        .slice(7)
        .match(/^([a-z]+)-(\d{1,2})(?:-(\d{1,2})(?!\d))?|^(\d{1,2})(?:-(\d{1,2})(?!\d))?-([a-z]+)/);
      if (tokens) {
        const legacy = !!tokens[4],
          family = tokens[1] ?? tokens[6],
          major = Number(tokens[2] ?? tokens[4]),
          minor = tokens[3] ?? tokens[5];
        let rest = id.slice(7 + tokens[0].length);
        rest = rest.replace(/^-(fast|latest)/, "");
        let date = "";
        const vertex = rest.match(/^-v\d{1,3}@(\d{8})/),
          normal = rest.match(/^[-@](\d{8})/);
        const dated = vertex ?? normal;
        if (dated) {
          date = dated[1];
          rest = rest.slice(dated[0].length);
        }
        rest = rest.replace(/^-v\d{1,3}(?::\d{1,3})?/, "");
        if (!rest) {
          const native =
            (family === "opus" && (major > 4 || (major === 4 && Number(minor ?? 0) >= 7))) ||
            (family === "sonnet" && major >= 5) ||
            (family === "haiku" && major >= 5) ||
            ["fable", "mythos"].includes(family);
          const canonical =
            (legacy ? `claude-${major}` : `claude-${family}-${major}`) +
            (minor === undefined ? "" : `-${Number(minor)}`) +
            (legacy ? `-${family}` : "") +
            (date ? `-${date}` : "");
          return new Model({
            id: Text.ascii(canonical),
            name: new Text(
              family[0].toUpperCase() +
                family.slice(1) +
                ` ${major}` +
                (Number(minor ?? 0) ? `.${Number(minor)}` : "") +
                (million && !native ? " (1M context)" : ""),
            ),
            window: million || native ? 1000000n : 200000n,
          });
        }
      }
    }
    if (/^[a-z0-9.-]+$/.test(reported)) {
      const words = reported.split("-");
      const first = words.shift();
      let name = "";
      if (first === "gpt" && words[0] && /^\d/.test(words[0])) name = "GPT-" + words.shift();
      else if (first === "codex") name = "Codex";
      if (name && words.every(Boolean))
        return new Model({
          id: Text.ascii(reported),
          name: new Text(name + words.map(w => " " + w[0].toUpperCase() + w.slice(1)).join("")),
        });
    }
    return new Model({ id: Text.ascii(reported) });
  }
}
