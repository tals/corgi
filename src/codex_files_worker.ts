import { Index } from "./codex_files";

const index = new Index();
self.onmessage = (event: MessageEvent<{ path: string }>) => {
  const before = index.stamp;
  index.refreshFile(event.data.path);
  const changed = index.stamp !== before;
  self.postMessage({
    changed,
    stamp: index.stamp,
    entries: changed ? [...index.names].map(([id, name]) => [id, name.text()]) : [],
  });
};
