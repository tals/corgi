/** The terminal or the viewer's update helper receives stage and byte progress. */
export class Progress {
  private stage = "";
  private tick = 0;
  constructor(private output: (line: string) => void = line => process.stderr.write(line + "\n")) {}
  show(stage: string): void {
    if (stage === this.stage) return;
    this.stage = stage;
    this.tick = performance.now();
    this.output(stage + "…");
  }
  uploaded(bytes: number): void {
    if (performance.now() - this.tick < 1000) return;
    this.tick = performance.now();
    this.output(`${this.stage}… ${size(bytes)} sent`);
  }
}
export function size(bytes: number): string {
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
