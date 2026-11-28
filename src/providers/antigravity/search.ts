import { statSync } from "node:fs";
import * as search from "../search";
import * as tools from "../search_tools";
import { field, str } from "../common";
import { directory, home } from "./config";
import { entries } from "./history";
import { message, path } from "./transcript";

export const conversations: search.Search = {
  version: 1,
  home: env => directory(home(env)),
  async discover(root, context) {
    const sessions = entries(root, "", () => false),
      found: search.Found[] = [];
    context.checking(sessions.length);
    for (const e of sessions) {
      const reporting = context.checked();
      if (reporting) await reporting;
      const source = path(root, e.session),
        s = statSync(source, { throwIfNoEntry: false });
      if (!s?.isFile() || !context.claim(search.fileId(s))) continue;
      const stamp = [s.ino, s.size, s.mtimeMs, e.updated_at, e.title].join(":");
      found.push({
        session: e.session,
        cwd: e.cwd,
        source,
        stamp,
        bytes: s.size,
        updated_at: e.updated_at * 1000,
        title: e.title,
      });
    }
    return found;
  },
  ...search.transcriptMessages({
    messages(v, ref) {
      const m = message(v);
      return m ? search.prose(m.role, m.text, v.created_at, ref) : [];
    },
    tools(v, ref) {
      const calls = field(v, "tool_calls");
      if (Array.isArray(calls))
        return calls.map(c =>
          tools.record(
            tools.call(str(c, "name"), field(c, "args")),
            v.created_at,
            ref,
            tools.info("call", str(c, "name"), str(c, "id")),
          ),
        );
      if (str(v, "source") !== "MODEL" || message(v) || !str(v, "content")) return [];
      return [
        tools.record(
          str(v, "content"),
          v.created_at,
          ref,
          tools.info("result", str(v, "type"), "", {
            status: v.status === "ERROR" ? "error" : v.status === "DONE" ? "success" : null,
            exit_code: null,
          }),
        ),
      ];
    },
  }),
};
