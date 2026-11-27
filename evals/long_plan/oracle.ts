#!/usr/bin/env bun
// A ceiling for the judge: a strong model writes the plan once, with the whole session in view.
import * as fs from "node:fs";
import * as path from "node:path";
import type { History } from "./history";
import type { Node, State } from "./plan";
import { bumpKinds } from "./plan";
import { digest } from "./judge";

const instructions = `You write a "long-term plan" for a finished coding-agent session: a small tree a developer glances at for ten seconds to learn what the agent did, where the effort went and what went wrong. You get DIGEST, a condensed transcript with numbered events.

The tree has two levels: episodes, and steps inside them. An episode is something the user asked for, or a subproblem of it a human would name. A step is a meaningful activity, not a tool call or a retry. Keep it short enough to skim: usually 2-6 episodes, 3-6 steps per episode. Titles are 2-7 words. Subtitles are one line under 100 characters carrying the finding, constraint or result. States are planned, active, done, failed, blocked, skipped and must match how the session ended. Give a step a problem only when something cost real time or changed the course of the work: category is one of ${bumpKinds.join(", ")}, state is open or resolved, detail is one line. Every step lists from/to, the inclusive event range it mostly covers.

Return only JSON: {"nodes":[{"id":"e1","parent":null,"kind":"episode","title":"","subtitle":"","state":""},{"id":"s1","parent":"e1","kind":"step","title":"","subtitle":"","state":"","from":1,"to":9,"problem":{"category":"","state":"","detail":""}}]}`;

const args = process.argv.slice(2),
  at = args.indexOf("--model"),
  model = at < 0 ? "claude-sonnet-5-5" : args.splice(at, 2)[1],
  [source, out] = args;
if (!source || !out) throw Error("Usage: oracle.ts [--model MODEL] RUN_DIRECTORY OUTPUT_DIRECTORY");
fs.mkdirSync(out, { recursive: true });
await Promise.all(
  fs
    .readdirSync(source)
    .filter(f => f.endsWith(".history.json"))
    .map(async file => {
      const id = file.slice(0, -".history.json".length),
        data: History = JSON.parse(fs.readFileSync(path.join(source, file), "utf8"));
      const child = Bun.spawn(
        [
          "claude",
          "--print",
          "--output-format",
          "json",
          "--safe-mode",
          "--strict-mcp-config",
          "--mcp-config",
          '{"mcpServers":{}}',
          "--tools",
          "",
          "--no-session-persistence",
          "--system-prompt",
          instructions,
          "--model",
          model,
        ],
        { stdin: new Blob([`DIGEST (${data.events.length} events)\n${digest(data)}`]), stdout: "pipe", stderr: "pipe" },
      );
      const text = String(JSON.parse(await new Response(child.stdout).text()).result),
        raw = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
      const last = data.events.length;
      const nodes: Node[] = raw.nodes.map((n: any) => ({
        id: String(n.id),
        parent: n.parent ?? null,
        kind: n.kind,
        title: String(n.title).slice(0, 64),
        subtitle: String(n.subtitle).slice(0, 120),
        state: n.state,
        evidence: [],
        ...(n.problem && n.kind === "step"
          ? {
              bump: {
                kind: n.problem.category,
                state: n.problem.state,
                detail: String(n.problem.detail).slice(0, 120),
                evidence: [],
              },
            }
          : {}),
      }));
      // Visits must not overlap: each range starts after the one before it ends.
      let end = 0;
      const spans = raw.nodes
        .filter((n: any) => n.kind === "step" && Number.isInteger(n.from) && Number.isInteger(n.to))
        .sort((a: { from: number }, b: { from: number }) => a.from - b.from)
        .flatMap((n: any) => {
          const from = Math.max(end + 1, n.from),
            to = Math.min(last, n.to);
          if (to < from) return [];
          end = to;
          return [{ from, to, node: String(n.id) }];
        });
      // The reducer wants each row to cite an event; use where its work starts.
      const start = (id: string): number =>
        spans.find((sp: { node: string }) => sp.node === id)?.from ??
        Math.min(last, ...nodes.filter(n => n.parent === id).map(n => start(n.id)));
      for (const n of nodes) {
        n.evidence = [start(n.id)];
        if (n.bump) n.bump.evidence = [start(n.id)];
      }
      const state: State = { nodes, spans, through: last };
      fs.writeFileSync(path.join(out, file), JSON.stringify(data));
      fs.writeFileSync(path.join(out, `${id}.calls.json`), JSON.stringify([{ through: last, state, raw: text }]));
      console.log(`${id}: ${nodes.length} nodes`);
    }),
);
