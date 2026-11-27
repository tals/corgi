import { join } from "node:path";
import { table, type World } from "../sandbox";
import { world as workspaces } from "./workspaces";

export const world: World = {
  ...workspaces,
  configure(s) {
    s.settings({ sidebar_position: "top" });
  },
  seed(s) {
    workspaces.seed(s);
    // "web" has two commits to push, so its row offers the push card.
    const web = join(s.dir, "projects/web"),
      origin = join(s.dir, "origins/web.git");
    s.run(["git", "init", "-q", "--bare", "-b", "main", origin]);
    s.git(web, "init", "-q", "-b", "main");
    s.git(web, "remote", "add", "origin", origin);
    s.dated(60 * 26);
    s.commit(web, "docs: start the readme");
    s.git(web, "push", "-q", "-u", "origin", "main");
    s.dated(95);
    s.write(join(web, "src/login.ts"), "export const redirect = (to: string) => `/login?next=${to}`;\n");
    s.commit(web, "login: keep the page to return to");
    s.dated(25);
    s.write(join(web, "src/search.ts"), "export const filters = ['owner', 'status'];\n");
    s.commit(web, "search: filter by owner and status");
    s.dated(null);
  },
  intro(s) {
    return [
      "The sidebar runs along the top: workspaces on the left, agents beside them, panes below.",
      ...table([
        ["drag", "the rule under the band for its height, the divider for the workspace column"],
        [`${s.prefixName} ↑ ↓`, "into the band from the panes, and back"],
        [`${s.prefixName} ← →`, "between the workspace and agent lists"],
        ["setup", "UI Style → Sidebar: Left, Top, or Auto (top on a portrait window)"],
      ]),
    ];
  },
};
