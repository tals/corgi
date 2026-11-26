/**
 * Talks to ghostty-host, the windowless libghostty terminal a capture runs
 * in, over HTTP on its socket: the mouse goes in as Ghostty's own input, and
 * frames, the screen settling and the pointer's shape come out.
 */

/** One of the host's mouse actions, in frame pixels. */
export type MouseAction =
  | { action: "move"; x: number; y: number }
  | { action: "press" | "release"; button: "left" | "right" | "middle" }
  | { action: "scroll"; dy: number };

/** A pointer Ghostty asked for: a CSS cursor name, from t (ms since the epoch). */
export interface ShapeChange {
  seq: number;
  shape: string;
  t: number;
}

export interface Shapes {
  seq: number;
  shape: string;
  changes: ShapeChange[];
}

/** The surface's geometry, in frame pixels. */
export interface Size {
  width: number;
  height: number;
  scale: number;
  cell_width: number;
  cell_height: number;
  columns: number;
  rows: number;
  padding: { top: number; bottom: number; left: number; right: number };
}

/** A frame in the host's stream: GCF1's 64-byte header, then its pixels. */
export const FRAME_HEADER = 64;

/**
 * Times here are ms since the epoch and counters plain numbers, as Date.now()
 * gives: the host's 64-bit nanoseconds become ms where they're read.
 */
export interface FrameHeader {
  width: number;
  height: number;
  stride: number;
  seq: number;
  /** When it was drawn, in ms since the epoch. */
  time: number;
  bytes: number;
}

/** Reads a GCF1 header; null when it isn't one. */
export function frameHeader(bytes: Uint8Array): FrameHeader | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, FRAME_HEADER);
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== "GCF1" || view.getUint32(4, true) !== FRAME_HEADER) return null;
  return {
    width: view.getUint32(8, true),
    height: view.getUint32(12, true),
    stride: view.getUint32(16, true),
    seq: Number(view.getBigUint64(24, true)),
    time: Number(view.getBigInt64(32, true) / 1000n) / 1000,
    bytes: Number(view.getBigUint64(56, true)),
  };
}

export class Host {
  constructor(readonly socket: string) {}

  request(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    return fetch(`http://host${path}`, {
      method,
      unix: this.socket,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeout: false,
      signal,
    });
  }

  private async json<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const response = await this.request(method, path, body);
    const reply = (await response.json()) as T & { ok?: boolean; error?: string };
    if (!response.ok || reply.ok === false) throw Error(`ghostty-host ${path}: ${reply.error ?? response.status}`);
    return reply;
  }

  async size(): Promise<Size> {
    return (await this.json<{ size: Size }>("GET", "/status")).size;
  }

  /** Returns once Ghostty has handled the events. */
  async mouse(events: MouseAction | MouseAction[]): Promise<void> {
    await this.json("POST", "/mouse", events);
  }

  /** The pointer's shape, with the changes after seq; waits up to ms for one. */
  async shapes(after: number, ms: number): Promise<Shapes> {
    type Wire = { seq: number; shape: string; changes: { seq: number; shape: string; time_unix_ns: number }[] };
    const reply = await this.json<Wire>("GET", `/shape?after=${after}&timeout_ms=${ms}`);
    return {
      seq: reply.seq,
      shape: reply.shape,
      // JSON carries the nanoseconds as a double; ms keep all the precision it has.
      changes: reply.changes.map(c => ({ seq: c.seq, shape: c.shape, t: c.time_unix_ns / 1e6 })),
    };
  }

  /** Shows text over the bottom row, right-aligned, for ms; Ghostty draws it. */
  async toast(text: string, ms = 2500): Promise<void> {
    await this.json("POST", "/toast", { text, ms });
  }

  /** Whether nothing was drawn for quietMs, within timeoutMs. */
  async settle(quietMs: number, timeoutMs: number): Promise<boolean> {
    const response = await this.request("GET", `/settle?quiet_ms=${quietMs}&timeout_ms=${timeoutMs}`);
    return response.ok && ((await response.json()) as { settled?: boolean }).settled === true;
  }

  /** The latest frame as a PNG. */
  async png(): Promise<Uint8Array> {
    const response = await this.request("GET", "/frame?format=png");
    if (!response.ok) throw Error(`ghostty-host /frame: ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
}
