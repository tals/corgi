/** Drives the real viewer through its test-only stdio interface. */
import { EXE, Lines, deadline } from "./support";
export { EXE } from "./support";

export class Viewer {
  events: any[] = [];
  state: any;
  closed = false;
  proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private lines = new Lines();
  private stderr: Promise<string>;
  private reader: Promise<void>;
  private queue = Promise.resolve();
  private constructor(public test: any) {
    const proc = (this.proc = Bun.spawn([EXE, "__viewer-test"], {
      env: test.env,
      cwd: test.temp.name,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }));
    const stderr = (this.stderr = new Response(proc.stderr).text());
    this.reader = (async () => {
      const decoder = new TextDecoder();
      try {
        for await (const chunk of proc.stdout) this.lines.feed(decoder.decode(chunk, { stream: true }));
        this.lines.feed(decoder.decode());
        this.lines.end(new Error(`Viewer exited: ${await stderr}`));
      } catch (error) {
        this.lines.end(error as Error);
      }
    })();
    test.viewers.push(this);
  }
  static async create(test: any, cols = 100, rows = 30) {
    const viewer = new Viewer(test);
    try {
      await viewer.request({ op: "size", cols, rows });
      return viewer;
    } catch (error) {
      await viewer.close();
      throw error;
    }
  }
  request(request: object): Promise<any> {
    const operation = this.queue.then(async () => {
      if (this.closed) throw new Error("Viewer is closed");
      (this.proc.stdin as Bun.FileSink).write(JSON.stringify(request) + "\n");
      await (this.proc.stdin as Bun.FileSink).flush();
      this.state = JSON.parse(await this.lines.next(5000));
      this.events = this.events.filter(event => !event._display);
      for (const effect of this.state.effects)
        if ("write_terminal" in effect) this.events.push({ type: "frame", data: effect.write_terminal });
      if (this.state.rang) this.events.push({ type: "bell", kind: this.state.bell_kind });
      this.events.push({
        type: "frame",
        data: this.state.data,
        _display: true,
      });
      if (this.state.detached) this.events.push({ type: "detach" });
      this.events = this.events.slice(-256);
      return this.state;
    });
    this.queue = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }
  input(data: string) {
    return this.request({ op: "input", data });
  }
  action(name: string, value = "") {
    return this.request({ op: "action", name, value });
  }
  poll() {
    return this.request({ op: "poll" });
  }
  /** Lets `seconds` pass on the viewer's clock (hover cards, debounce), then renders. */
  advance(seconds: number) {
    return this.request({ op: "advance", ms: Math.round(seconds * 1000) });
  }
  focus(pane: number) {
    return this.request({ op: "focus", pane });
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.proc.exitCode === null) this.proc.kill();
    try {
      await deadline(this.proc.exited, 3000);
    } catch {
      this.proc.kill("SIGKILL");
      await this.proc.exited;
    }
    (this.proc.stdin as Bun.FileSink).end();
    await this.reader;
  }
}
export async function pump(runtime: any) {
  if (runtime.client && !runtime.client.closed && !runtime.client.state.detached) await runtime.client.poll();
}
