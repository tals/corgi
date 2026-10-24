import type { Transcript } from "../adapter";
import { str, Text } from "../common";
import { Counts } from "../../usage/tokens";
import { Model } from "../model";
import { transcript as pi } from "../pi/transcript";
/** Pi's session records, after a title slot omp rewrites in place. omp names
 * its sessions itself, so Corgi doesn't. */
export const transcript: Transcript = {
  verify(head, session) {
    // The title slot comes before the header, and says nothing of the session.
    if (str(head, "type") === "title") return;
    pi.verify!(head, session);
  },
  completion: pi.completion,
  fallback: pi.fallback,
  reader(accounts) {
    const reader = pi.reader(accounts);
    return {
      open: reader.open,
      record(t, req, v, appended, stamp) {
        switch (str(v, "type")) {
          case "title":
          case "title_change": {
            const title = str(v, "title");
            if (title) t.name = new Text(title.slice(0, 160));
            return new Counts();
          }
          case "model_change": {
            const model = str(v, "model");
            if (model) t.model = Model.resolve(model.slice(model.indexOf("/") + 1));
            return new Counts();
          }
          default:
            return reader.record(t, req, v, appended, stamp);
        }
      },
    };
  },
};
