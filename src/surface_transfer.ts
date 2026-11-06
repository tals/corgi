import * as flow from "./flow";
import * as json from "./json";
import * as text from "./text";
import * as surface from "./pane/surface";

export interface Chunk {
  data: string;
  end: boolean;
  next: string;
}

/** Captures one pane at a time; a captured revision stays whole during transfer. */
export class Transfer {
  private token = crypto.randomUUID();
  private page = 0;
  private data = "";
  private offset = 0;
  private touched = Date.now();
  constructor(private views: Iterator<surface.View>) {}
  expired(now: number): boolean {
    return now - this.touched >= 30_000;
  }
  read(cursor: string | null): Chunk | null {
    if (cursor !== (this.page ? `${this.token}:${this.page}` : null) || this.expired(Date.now()))
      throw Error("SurfaceExpired");
    this.touched = Date.now();
    if (!this.data) {
      const view = this.views.next();
      if (view.done) return null;
      this.data = json.stringify(view.value);
      if (text.byteLength(this.data) > flow.surface_bytes) {
        this.data = "";
        throw Error("MessageTooLarge");
      }
      this.offset = 0;
    }
    const data = this.data.slice(this.offset, this.offset + flow.surface_chunk_chars);
    this.offset += data.length;
    const end = this.offset === this.data.length;
    if (end) this.data = "";
    return { data, end, next: `${this.token}:${++this.page}` };
  }
}

/** No receipt reaches the mirror until the entire pane has arrived. */
export class Assembly {
  private parts: string[] = [];
  private bytes = 0;
  readonly views: surface.View[] = [];
  add(chunk: Chunk): void {
    this.bytes += text.byteLength(chunk.data);
    if (this.bytes > flow.surface_bytes) throw Error("MessageTooLarge");
    this.parts.push(chunk.data);
    if (!chunk.end) return;
    if (this.views.length >= 64) throw Error("TooManyPanes");
    this.views.push(surface.view(json.parse(this.parts.join(""))));
    this.parts = [];
    this.bytes = 0;
  }
  finish(): surface.View[] {
    if (this.parts.length) throw Error("IncompleteSurface");
    return this.views;
  }
}
