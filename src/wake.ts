/** A single consumer sleeps until work arrives or its next timed task is due. */
export class Wake {
  private pending = false;
  private finish: (() => void) | null = null;
  notify(): void {
    if (this.finish) this.finish();
    else this.pending = true;
  }
  async wait(ms: number): Promise<void> {
    if (this.pending) {
      this.pending = false;
      return;
    }
    await new Promise<void>(resolve => {
      const done = () => {
        clearTimeout(timer);
        this.finish = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.finish = done;
    });
  }
}
