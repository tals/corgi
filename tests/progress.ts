/** Live test counts, final JUnit results, and updates to the existing Actions job. */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export type Result = { file: string; tests: number; failures: number; skipped: number; seconds: number };
type Element = { name: string; attributes: Record<string, string>; children: (Element | string)[] };
type Conclusion = "success" | "failure" | "cancelled";
const variable = "CORGI_TEST_PROGRESS_DIR";

// The same module is imported by the parent and preloaded into Bun's workers.
if (process.env[variable]) {
  const { beforeEach, afterEach } = await import("bun:test");
  const path = join(process.env[variable]!, `${process.pid}.events`);
  beforeEach(() => appendFileSync(path, "+"));
  afterEach(() => appendFileSync(path, "-"));
}

export function counts(directory: string) {
  let started = 0,
    finished = 0;
  for (const file of readdirSync(directory)) {
    if (!file.endsWith(".events")) continue;
    for (const event of readFileSync(join(directory, file), "utf8")) {
      if (event === "+") started++;
      if (event === "-") finished++;
    }
  }
  return { finished, running: Math.max(0, started - finished) };
}

export function results(xml: string, root: string): Result[] {
  const document = Bun.XML.parse(xml, { compact: false }) as Element;
  if (document.name !== "testsuites") throw Error("Invalid Bun JUnit report");
  return document.children
    .filter((node): node is Element => typeof node !== "string" && node.name === "testsuite")
    .map(node => {
      const attributes = node.attributes;
      const number = (key: string) => {
        const value = Number(attributes[key] ?? 0);
        if (!Number.isFinite(value) || value < 0) throw Error(`Invalid JUnit ${key}`);
        return value;
      };
      if (!attributes.file) throw Error("JUnit suite is missing its file");
      return {
        file: resolve(root, attributes.file),
        tests: number("tests"),
        failures: number("failures") + number("errors"),
        skipped: number("skipped"),
        seconds: number("time"),
      };
    });
}

/** Estimate total runtime with the selected files spread over the available workers. */
export function duration(files: string[], timings: string[], root: string, jobs: number): number | null {
  const history = new Map<string, number>();
  for (const path of timings) {
    try {
      const saved = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown; files?: unknown };
      if (saved.version !== 1 || !saved.files || typeof saved.files !== "object") continue;
      for (const [file, milliseconds] of Object.entries(saved.files))
        if (typeof milliseconds === "number" && Number.isFinite(milliseconds) && milliseconds >= 0)
          history.set(resolve(root, file), milliseconds);
    } catch {}
  }
  if (!files.length || files.some(file => !history.has(file))) return null;
  const workers = Array<number>(Math.min(jobs, files.length)).fill(0);
  const durations = files.map(file => history.get(file)!).sort((a, b) => b - a);
  for (const duration of durations) workers[workers.indexOf(Math.min(...workers))] += duration;
  return Math.max(...workers) || null;
}

export function eta(milliseconds: number) {
  if (milliseconds <= 0) return "past estimate";
  if (milliseconds < 60_000) return "<1m left";
  return `~${Math.ceil(milliseconds / 60_000)}m left`;
}

function summary(results: Result[], flaky: string[]) {
  const total = results.reduce(
    (sum, result) => ({
      tests: sum.tests + result.tests,
      failures: sum.failures + result.failures,
      skipped: sum.skipped + result.skipped,
    }),
    { tests: 0, failures: 0, skipped: 0 },
  );
  const title = `${total.tests - total.failures - total.skipped} passed · ${total.failures} failed · ${total.skipped} skipped`;
  const rows = results.map(
    result =>
      `| ${result.failures ? "FAIL" : flaky.includes(result.file) ? "FLAKY" : "PASS"} | ${result.file.split("/").at(-1)} | ${result.tests} | ${result.seconds.toFixed(1)}s |`,
  );
  return {
    tests: total.tests,
    title,
    text: `${title}\n\n| Result | Suite | Tests | Time |\n| --- | --- | ---: | ---: |\n${rows.join("\n")}\n`,
  };
}

async function request(env: NodeJS.ProcessEnv, id: string, title: string, summary: string) {
  const response = await fetch(
    `${env.GITHUB_API_URL ?? "https://api.github.com"}/repos/${env.GITHUB_REPOSITORY}/check-runs/${id}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        output: { title, summary },
      }),
      signal: AbortSignal.timeout(5000),
    },
  );
  if (!response.ok) throw Error(`GitHub progress update: HTTP ${response.status}`);
}

export class Reporter {
  readonly directory = mkdtempSync(join(tmpdir(), "corgi-progress-"));
  private current = this.directory;
  private phase = "Starting";
  private total: number | null = null;
  private testing = false;
  private deadline: number | null = null;
  private checkId: string | null = null;
  private pending: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private last = "";
  private warnings = new Set<string>();
  private attempt = 0;
  private constructor(private env: NodeJS.ProcessEnv) {}

  static async start(env: NodeJS.ProcessEnv = process.env) {
    const reporter = new Reporter(env);
    if (
      env.GITHUB_ACTIONS &&
      env.GITHUB_TOKEN &&
      env.GITHUB_REPOSITORY &&
      /^[1-9]\d*$/.test(env.CORGI_TEST_CHECK_ID ?? "")
    ) {
      reporter.checkId = env.CORGI_TEST_CHECK_ID!;
      await reporter.publish("Starting", "Discovering integration tests.");
    }
    reporter.timer = setInterval(() => {
      void reporter.update();
    }, 10_000);
    return reporter;
  }

  begin(phase: string, total: number | null = null, duration: number | null = null) {
    this.phase = phase;
    this.total = total;
    this.testing = true;
    this.deadline = duration === null ? null : Date.now() + duration;
    this.current = join(this.directory, String(++this.attempt));
    mkdirSync(this.current);
    return { [variable]: this.current };
  }

  async update(phase?: string) {
    if (phase) {
      this.phase = phase;
      this.testing = false;
      this.deadline = null;
    }
    const count = counts(this.current);
    const percent =
      this.total && count.finished <= this.total ? `${Math.floor((100 * count.finished) / this.total)}%` : null;
    const finished =
      percent === null ? `${count.finished} finished` : `${percent} · ${count.finished}/${this.total} finished`;
    const remaining = this.deadline === null ? null : eta(this.deadline - Date.now());
    const detail = `${this.phase} · ${finished} · ${count.running} running${remaining ? ` · ${remaining}` : ""}`;
    const title = this.testing
      ? [
          this.attempt > 1 ? "Retry" : null,
          percent === null ? `${count.finished} finished` : `${count.finished}/${this.total}`,
          percent,
          remaining,
        ]
          .filter(Boolean)
          .join(" · ")
      : this.phase;
    if (detail === this.last) return this.pending;
    this.last = detail;
    console.log(detail);
    this.pending = this.pending.then(() => this.publish(title, detail));
    return this.pending;
  }

  async finish(conclusion: Conclusion, results: Result[], flaky: string[]) {
    if (this.timer) clearInterval(this.timer);
    await this.pending;
    const report = summary(results, flaky);
    const text = `Integration ${conclusion}. ${report.text}`;
    try {
      if (this.env.GITHUB_STEP_SUMMARY) appendFileSync(this.env.GITHUB_STEP_SUMMARY, text);
      await this.publish(
        conclusion === "success"
          ? `${report.tests}/${report.tests} · 100%`
          : conclusion === "cancelled"
            ? "Cancelled"
            : report.title,
        text,
      );
    } finally {
      rmSync(this.directory, { recursive: true, force: true });
    }
  }

  private async publish(title: string, summary: string) {
    if (!this.checkId) return;
    try {
      // Actions owns completion, cancellation, and failures in later job steps.
      await request(this.env, this.checkId, title, summary);
    } catch (error) {
      this.warn(error);
    }
  }

  private warn(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (this.warnings.has(message)) return;
    this.warnings.add(message);
    console.error(`${message}; test execution continues without this progress update.`);
  }
}
