import type { Endpoint } from "./machine_connection";
import * as card from "./connectivity_card";
import * as text from "./text";
import { Rect } from "./layout";

export class Notice {
  private message: string[] | null = null;
  private offset = 0;
  private height = 0;
  private length = 0;
  get open(): boolean {
    return this.message !== null;
  }
  /** Opens `endpoint`'s problem; false when it has none to show. */
  show(endpoint: Endpoint): boolean {
    if (!endpoint.error) return false;
    const command = endpoint.issue === "auth" || endpoint.issue === "host-key" ? "reconnect" : "status";
    this.message = [
      `${endpoint.name} · ${endpoint.issue === "auth" ? "Authentication required" : "Connection problem"}`,
      "",
      endpoint.error.replace(/[\x00-\x1f\x7f]/g, " "),
      "",
      "Run in a terminal:",
      `corgi machine ${command} ${endpoint.name}`,
      ...(endpoint.issue === "host-key" ? ["Verify the host fingerprint before approving its key."] : []),
    ];
    this.offset = 0;
    return true;
  }
  close(): void {
    this.message = null;
  }
  scroll(delta: number): void {
    this.offset = Math.max(0, Math.min(Math.max(0, this.length - this.height), this.offset + delta));
  }
  key(value: string, cp: number | null): void {
    if (cp === 27 || cp === 13 || value === "q") this.close();
    else if (value === "\x1b[A" || cp === 57352) this.scroll(-1);
    else if (value === "\x1b[B" || cp === 57353) this.scroll(1);
    else if (value === "\x1b[5~") this.scroll(-this.height);
    else if (value === "\x1b[6~") this.scroll(this.height);
  }
  draw(cols: number, rows: number): string {
    if (!this.message || cols < 6 || rows < 5) return "";
    const width = Math.min(76, cols);
    const lines = this.message.flatMap(line => (line ? text.wrap(line, width - 4) : [""]));
    this.length = lines.length;
    this.height = Math.min(rows - 4, lines.length);
    this.scroll(0);
    const rect = new Rect(
      Math.floor((cols - width) / 2),
      Math.floor((rows - this.height - 4) / 2),
      width,
      this.height + 4,
    );
    const writer = new text.Writer();
    card.draw(writer, {
      rect,
      lines: [
        ...lines.slice(this.offset, this.offset + this.height).map(line => ({ text: line })),
        { text: "", color: "muted" },
        { text: "Esc close · ↑↓ scroll", color: "muted" },
      ],
    });
    return writer.buffered();
  }
}
