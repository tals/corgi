import { Text, Provider } from "./providers";
import * as claudeDaemon from "./claude_daemon";
import type { Agent } from "./agents";
export class ResumeHint {
  name = new Text();
  touched_at = 0;
  provider: Provider | null = null;
  session = new Text();
  observe(agent: Agent) {
    const provider = agent.provider;
    if (!provider) return;
    if (agent.session.len) {
      if (this.provider !== provider || this.session.text() !== agent.sessionId()) {
        this.name = new Text();
        this.touched_at = 0;
      }
      if (agent.name.len) this.name = new Text(agent.name.text());
      this.touched_at = Math.max(this.touched_at, agent.updated_at, Math.trunc(agent.changed_at / 1e6));
      this.provider = provider;
      this.session = new Text(agent.sessionId());
    } else if (!this.provider) this.provider = provider;
  }
  args(): string[] | null {
    if (!this.provider) return null;
    try {
      return Provider.info(this.provider).resumeArgs({
        id: this.session.text(),
      });
    } catch {
      return null;
    }
  }
  backgroundJob(): Text | null {
    return this.provider === "claude" && this.args() !== null ? claudeDaemon.job(this.session.text()) : null;
  }
  command(): string {
    const job = this.backgroundJob();
    if (job) return claudeDaemon.attachCommand(job);
    const args = this.args();
    return args ? `${args[0]} ${args[1]} '${args[2].replaceAll("'", "'\\''")}'` : "";
  }
  banner(now: number): string {
    let out = "\x1b[0m\r\n\r\n";
    if (this.name.len) out += "# " + this.name.text().replace(/[\x00-\x1f\x7f]/g, " ") + "\r\n";
    if (this.touched_at > 0) {
      const seconds = Math.max(0, now - this.touched_at),
        unit = seconds < 3600 ? 60 : seconds < 86400 ? 3600 : 86400,
        label = unit === 60 ? "minute" : unit === 3600 ? "hour" : "day",
        count = Math.trunc(seconds / unit);
      out +=
        "\x1b[2m# Last active " +
        (seconds < 60 ? "just now" : `${count} ${label}${count === 1 ? "" : "s"} ago`) +
        "\x1b[0m\r\n";
    }
    return out;
  }
  toJSON() {
    return {
      name: this.name.text(),
      touched_at: this.touched_at,
      provider: this.provider,
      session: this.session.text(),
    };
  }
}
