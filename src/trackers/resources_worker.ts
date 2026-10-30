import { Tracker, restoreBatch, restoreSnapshot, type SampleRequest, type SampleResult } from "./resources";
import * as gpu from "./gpu";
import * as nvidia from "./gpu_nvidia";
import * as telemetry from "../telemetry";

// Outlives each request: it keeps the driver open and remembers what it read.
const graphics = new gpu.Sampler(nvidia.open);

// Only immutable scan inputs cross the boundary; the daemon validates ownership
// again before publishing a completed sample.
self.onmessage = (event: MessageEvent<SampleRequest | { release: true } | { telemetry: true }>) => {
  if ("telemetry" in event.data) return telemetry.flush();
  if ("release" in event.data) return graphics.close();
  try {
    const request = event.data;
    const tracker = new Tracker();
    Object.assign(tracker, request, {
      gpu: graphics,
      batch: restoreBatch(request.batch),
      current: restoreSnapshot(request.current),
    });
    tracker.sample(request.at);
    self.postMessage({ pending: tracker.pending, origins: tracker.origins } satisfies SampleResult);
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
