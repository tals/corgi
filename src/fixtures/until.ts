/** Waits until `done` holds, checking every millisecond, and fails once `ms` pass without it. */
export async function until(done: () => boolean, ms = 3000): Promise<void> {
  const end = performance.now() + ms;
  while (!done()) {
    if (performance.now() >= end) throw Error("TestTimedOut");
    await Bun.sleep(1);
  }
}
