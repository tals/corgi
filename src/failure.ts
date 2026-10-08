export class Failure {
  private previous: string | null = null;
  changed(error: unknown): boolean { const name = error instanceof Error ? error.message : String(error); const changed = this.previous !== name; this.previous = name; return changed; }
  clear(): boolean { const had = this.previous !== null; this.previous = null; return had; }
}
