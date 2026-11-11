//! Replay recorded terminal snapshots through the production row-patch encoder.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { directory as fixtures, load } from "../frame_sequences/replay";
import * as paths from "../paths";
import { Terminal } from "../../../src/pane/terminal";
import * as surface from "../../../src/pane/surface";
import * as json from "../../../src/json";
import * as protocol from "../../../src/protocol";
import { Frames } from "../../../src/viewer_stream";
import type { View } from "../../../src/viewer_protocol";

if (!process.argv[2]) throw Error("Usage: bun compression_corpus.ts OUTPUT");
const directory = paths.external(process.argv[2]);
const source = process.argv[3];
const names = process.argv.slice(4);
mkdirSync(directory, { recursive: true });
const provenance: Record<string, { fixture: string; fixture_sha256: string; scenario_sha256: string }> = {};
for (const name of names.length ? names : ["claude", "codex", "micro", "shell"]) {
  const sequence = await load(name, source);
  const fixture = join(source ?? fixtures, `${name}.json.gz`);
  const scenario =
    "scenario" in sequence ? sequence.scenario : ["claude", "codex"].includes(name) ? "typescript-checklist-v1" : name;
  provenance[name] = {
    fixture,
    fixture_sha256: new Bun.CryptoHasher("sha256").update(await Bun.file(fixture).bytes()).digest("hex"),
    scenario_sha256: new Bun.CryptoHasher("sha256").update(JSON.stringify(scenario)).digest("hex"),
  };
  const terminal = Terminal.create(sequence.cols, sequence.rows);
  const output = new Frames();
  const hash = new Bun.CryptoHasher("sha256").update(JSON.stringify(sequence)).digest("hex");
  const identity = BigInt("0x" + hash.slice(0, 16));
  const epoch = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
  const messages: string[] = [];
  let previous = "";
  let baseline: surface.View | undefined;
  try {
    for (const recorded of sequence.frames) {
      if (recorded.frame === previous) continue;
      previous = recorded.frame;
      terminal.feed(recorded.frame);
      const pane = surface.captureView(1, terminal);
      pane.stamp.identity = identity;
      pane.input_ack = { epoch, sequence: 1n };
      const view: View = {
        type: "view",
        viewer_protocol: protocol.viewer_version,
        session: null,
        session_hash: identity,
        resources: null,
        resources_hash: identity ^ 0xffffffffffffffffn,
        surfaces: [pane],
        bell_seq: 0n,
        bell_kind: "none",
        controls: [],
        viewer: 1,
        detach: false,
      };
      const frame = output.offer(view);
      if (!frame) throw Error("UnexpectedBackpressure");
      for (const full of frame.view.surfaces) baseline = full;
      for (const patch of frame.view.patches ?? [])
        baseline = surface.apply(baseline, json.parse(json.stringify(patch)));
      if (json.stringify(baseline) !== json.stringify(pane)) {
        // Patch application can reorder object keys; compare normalized values.
        if (!Bun.deepEquals(baseline, pane)) throw Error("ReplayMismatch");
      }
      messages.push(json.stringify({ type: "viewer.frame", sequence: 1, view: frame.view, frame: frame.frame }));
      output.acknowledge(frame.frame);
    }
  } finally {
    terminal.destroy();
  }
  writeFileSync(join(directory, `${name}.jsonl`), messages.join("\n") + "\n");
  console.log(json.stringify({ name, frames: messages.length, sourceFrames: sequence.frames.length }));
}
writeFileSync(join(directory, "sources.json"), JSON.stringify(provenance, null, 2) + "\n");
