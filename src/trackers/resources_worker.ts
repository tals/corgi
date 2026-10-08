import { Tracker, restoreBatch, restoreSnapshot, type SampleRequest, type SampleResult } from "./resources";

// Only immutable scan inputs cross the boundary; the daemon validates ownership
// again before publishing a completed sample.
self.onmessage = (event: MessageEvent<SampleRequest>) => {
  try {
    const request = event.data;
    const tracker = new Tracker();
    Object.assign(tracker, request, {
      batch: restoreBatch(request.batch), current: restoreSnapshot(request.current),
    });
    tracker.sample(request.at);
    self.postMessage({ pending:tracker.pending, origins:tracker.origins } satisfies SampleResult);
  } catch (error) {
    self.postMessage({ error:error instanceof Error ? error.message : String(error) });
  }
};
