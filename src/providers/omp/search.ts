//! omp's conversations as corgi grep reads them: Pi's records, and its own tool starts.
import * as search from "../search";
import * as tools from "../search_tools";
import { records } from "../pi/search";
import { accounts } from "./accounts";
import { configDir } from "./integration";
import { sessionRoots } from "./locations";

export const conversations = search.transcripts({
  version: 1,
  home: configDir,
  env: accounts.env,
  folders: root => sessionRoots(root),
  ...records,
  tools(value, ref) {
    const v = tools.object(value);
    if (v.type !== "custom" || v.customType !== "tool_execution_start") return records.tools(value, ref);
    const data = tools.object(v.data);
    return [
      tools.record(
        tools.call(data.toolName, data.args),
        data.startedAt ?? v.timestamp,
        ref,
        tools.info("call", data.toolName, data.toolCallId),
      ),
    ];
  },
});
