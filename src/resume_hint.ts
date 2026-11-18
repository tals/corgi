import { Text, Provider, validRef, adapter } from "./providers";
import { shellWords } from "./os";
import type { Agent } from "./agents";
import type { Permissions } from "./providers/adapter";
export class ResumeHint {
  name = new Text();
  touched_at = 0;
  provider: Provider | null = null;
  session = new Text();
  account: string | null = null;
  /** Verifies the saved core command; launches still follow current configuration. */
  executable: string | null = null;
  /** The permission checks and model the agent last reported, which it
   * comes back with. */
  permissions: Permissions | null = null;
  model = new Text();
  observe(agent: Agent) {
    const provider = agent.provider;
    if (!provider) return;
    if (agent.session.len) {
      if (this.provider !== provider || this.session.text() !== agent.sessionId()) {
        this.name = new Text();
        this.touched_at = 0;
        this.permissions = null;
        this.model = new Text();
        this.account = null;
        this.executable = null;
      }
      if (agent.name.len) this.name = new Text(agent.name.text());
      if (agent.permissions) this.permissions = agent.permissions;
      if (agent.model.len) this.model = new Text(agent.model.text());
      this.touched_at = Math.max(this.touched_at, agent.updated_at, Math.trunc(agent.changed_at / 1e6));
      this.provider = provider;
      this.session = new Text(agent.sessionId());
    } else if (!this.provider) this.provider = provider;
  }
  /** The arguments that resume its session, after the ones it started with. */
  args(account = this.account ?? ""): string[] | null {
    const session = this.session.text();
    if (!this.provider || !validRef({ id: session })) return null;
    return adapter(this.provider).launch.resume(session, account);
  }
  /** The command that attaches to its session where that already runs in
   * `account`; it runs with the variables that pick the account. */
  attach(account = this.account ?? ""): string | null {
    if (!this.provider || this.args(account) === null) return null;
    const { command, launch } = adapter(this.provider),
      args = launch.attach?.(this.session.text(), account);
    return args ? shellWords([command, ...args]) : null;
  }
  command(account = this.account ?? ""): string {
    const args = this.args(account);
    return this.attach(account) ?? (args && this.provider ? shellWords([this.provider, ...args]) : "");
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
      account: this.account,
      executable: this.executable,
      permissions: this.permissions,
      model: this.model.text(),
    };
  }
}
