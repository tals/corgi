import { test, expect } from "bun:test";
import { Job } from "./onboarding";
import { workspace, pane } from "./catalog";
test("a copy's plan outlives the request that brought it", () => {
  const plan: any = {
    operation: 5,
    source: "herdr",
    selected: ["w"],
    workspaces: [
      workspace({
        id: "w",
        name: "w",
        tabs: [{ id: "t", name: "t", panes: [pane({ id: "p", name: "p" })], nodes: [] }],
      }),
    ],
    herdr_session: {
      socket: "/s",
      name: "n",
      live_handoff: false,
      workspaces: [
        {
          id: "w",
          name: "w",
          cwd: "/",
          tabs: [
            { id: "t", name: "t", panes: [{ id: "p", name: "p", cwd: "/" }], root: { type: "pane", terminal_id: "p" } },
          ],
        },
      ],
    },
  };
  const job = new Job();
  job.start(plan);
  plan.herdr_session.workspaces[0].tabs[0].root.type = "destroyed";
  expect(job.plan!.herdr_session!.workspaces[0].tabs[0].root.type).toBe("pane");
  job.stop();
});
