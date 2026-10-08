import path from "node:path";
import { Worker as TranscriptWorker } from "./transcript";
import { Worker as CodexWorker } from "./codex_observer";
import { Worker as UsageWorker } from "./usage/worker";
import { Worker as SummaryWorker } from "./activity/worker";
import { Backend } from "./providers";
import { Text, Path } from "./agents";
import { Counts } from "./usage/tokens";
import * as setup from "./inference/setup";
import * as detection from "./detection";
import * as clock from "./clock";
import { stringify } from "./json";
import { Store } from "./workspace";
import { Model } from "./providers/model";

type Workers = {
  transcripts: TranscriptWorker;
  codex: CodexWorker;
  usage: UsageWorker;
  summaries: SummaryWorker;
  detected: number;
  settling: number;
};
const services = new WeakMap<object, Workers>();
export function start(server: any) {
  if (services.has(server)) return services.get(server)!;
  const workers = {
    transcripts: TranscriptWorker.start(),
    codex: CodexWorker.start(),
    usage: UsageWorker.start(),
    summaries:
      server.summaries ??
      SummaryWorker.start(setup.initial(setup.load(setup.path(server.socket)))),
    detected: 0,
    settling: 0,
  };
  server.summaries = workers.summaries;
  services.set(server, workers);
  publishInference(server, workers);
  return workers;
}
function publishInference(server: any, workers: Workers) {
  const status = workers.summaries.status();
  if (stringify(status) !== stringify(server.runtime.inference)) {
    server.runtime.inference = status;
    server.runtime.system_model = Model.resolve(status.model);
    changed(server);
  }
}
function paneWatched(server: any, pane: number) {
  return server.clients.some(
    (client: any) =>
      !client.dead &&
      client.viewer &&
      client.watched &&
      client.view_focus === pane &&
      Date.now() - client.touched < 1000,
  );
}
function actorWatched(server: any, id: number) {
  return server.runtime.panes.some(
    (pane: any) =>
      !pane.terminal.exited &&
      pane.attachment.actor?.id === id &&
      paneWatched(server, pane.id),
  );
}
function workspaceWatched(server: any, id: number) {
  return server.clients.some(
    (client: any) =>
      !client.dead &&
      client.viewer &&
      client.watched &&
      client.view_workspace === id &&
      Date.now() - client.touched < 1000,
  );
}
function changed(server: any) {
  server.dirty = true;
  server.runtime.changed();
}
function attention(server: any, ding: boolean, state: string) {
  server.attention(ding, state);
}

export function codexActor(server: any, snapshot: any) {
  const runtime = server.runtime;
  if (snapshot.request.actor)
    return runtime.conversations.byId(snapshot.request.actor);
  const pane = runtime.pane(snapshot.request.pane);
  const prefix = pane
    ? Backend.init("codex").titleSession(pane.terminal.title)
    : null;
  if (
    !pane ||
    !prefix ||
    pane.terminal.exited ||
    pane.detection.missing ||
    pane.detection.pid !== snapshot.request.pid ||
    pane.terminal.title_pid !== snapshot.request.pid ||
    pane.terminal.title_revision !== snapshot.request.title_revision ||
    pane.attachment.generation !== snapshot.request.generation ||
    prefix.text() !== snapshot.request.prefix.text()
  )
    return null;
  const actor = runtime.conversations.get("codex", snapshot.session);
  pane.attachment.select(actor);
  if (!actor.workspace || !runtime.workspaces.get(actor.workspace))
    actor.workspace = runtime.workspaces.owner(pane.id)?.id ?? actor.workspace;
  return actor;
}
export function reattachFromTitle(
  server: any,
  pane: any,
  provider: any,
  pid: number,
) {
  if (
    pane.attachment.actor ||
    pane.terminal.exited ||
    pid <= 0 ||
    pane.terminal.title_pid !== pid
  )
    return;
  const prefix = Backend.init(provider).titleSession(pane.terminal.title);
  if (!prefix) return;
  const matches = server.runtime.conversations.items.filter(
    (actor: any) =>
      actor.provider() === provider &&
      actor.state.session.len === 36 &&
      actor.state.sessionId().startsWith(prefix.text()),
  );
  if (matches.length !== 1) return;
  const actor = matches[0];
  pane.attachment.select(actor);
  if (!actor.workspace || !server.runtime.workspaces.get(actor.workspace))
    actor.workspace =
      server.runtime.workspaces.owner(pane.id)?.id ?? actor.workspace;
}
export function detectPane(
  server: any,
  pane: any,
  observedJob?: detection.Job | null,
) {
  const runtime = server.runtime,
    worker = start(server).summaries;
  const before = stringify(pane.agent());
  const job =
    observedJob === undefined
      ? detection.foreground(pane.terminal.fd)
      : observedJob;
  const previous = pane.detection.pid;
  const generation = pane.attachment.generation;
  pane.resume_hint.observe(pane.agent());
  if (job) {
    if (
      (previous && previous !== job.pid) ||
      (pane.attachment.actor && pane.agent().provider !== job.provider)
    )
      pane.attachment.detach();
    if (job.provider === "codex") {
      const prefix = Backend.init(job.provider).titleSession(
        pane.terminal.title,
      );
      const hash = prefix ? Bun.hash.wyhash(prefix.text(), 0n) : 0n;
      if (hash !== pane.attachment.selection_hash) {
        if (
          pane.attachment.actor &&
          (!prefix || !pane.agent().sessionId().startsWith(prefix.text()))
        )
          pane.attachment.deselect();
        pane.attachment.generation++;
        pane.attachment.selection_hash = hash;
      }
      reattachFromTitle(server, pane, job.provider, job.pid);
    }
  }
  const now = clock.microTimestamp(),
    actor = pane.attachment.actor;
  const authoritative = actor?.authoritative(now) ?? false;
  pane.attachment.provisional.last_seq = authoritative ? 1 : 0;
  const needsScreen =
    !authoritative ||
    !!actor?.state.permission_review ||
    (actor?.provider() === "claude" &&
      ["working", "blocked"].includes(actor.state.state)) ||
    actor?.state.state === "working";
  const text = job && needsScreen ? pane.terminal.liveText() : "";
  let ding = pane.detection.update(
    pane.attachment.provisional,
    job,
    pane.terminal.title,
    text,
    paneWatched(server, pane.id),
  );
  if (job && job.pid !== previous) worker.observeLaunch(job.provider);
  if (previous && !pane.detection.pid) pane.attachment.detach();
  if (actor) {
    actor.screen(pane.attachment.provisional, ding, now);
    if (actor.state.state === "working")
      actor.observeCompactionScreen(detection.screenCompacting(text), now);
    const settling =
      authoritative &&
      actor.provider() === "claude" &&
      actor.state.state === "working" &&
      !actor.state.observation.pending_stop;
    if (!settling) pane.detection.idle_since = 0;
    else if (pane.detection.interrupted(pane.terminal.title, text, now)) {
      actor.state.abandonTurn(now);
      pane.detection.idle_since = 0;
      pane.detection.interrupt_key_at = 0;
    }
    const next = actor.prompt_watch.answered(
      authoritative &&
        actor.provider() === "claude" &&
        actor.state.state === "blocked",
      text,
    );
    if (next) actor.state.observeAnswer(next, now);
    if (actor.state.permission_review)
      ding =
        actor.state.observePermissionPrompt(
          detection.screenState("codex", pane.terminal.title, text) ===
            "blocked",
          paneWatched(server, pane.id),
          now,
        ) || ding;
  }
  pane.resume_hint.observe(pane.agent());
  if (
    generation !== pane.attachment.generation ||
    before !== stringify(pane.agent())
  )
    changed(server);
  attention(server, ding, pane.agent().state);
}
export function hook(server: any, query: any) {
  const workers = start(server),
    runtime = server.runtime;
  const event = Backend.init(query.provider).hook(query.event);
  if (!event) return;
  const now = clock.microTimestamp(),
    seq = query.seq ?? now;
  let actor;
  if (query.background)
    actor = runtime.conversations.find(query.provider, event.session);
  else {
    const pane = runtime.pane(query.pane);
    if (!pane) throw Error("NoPane");
    detectPane(server, pane);
    if (seq <= pane.attachment.hook_seq) return;
    actor = runtime.conversations.routeHook(
      pane.attachment,
      query.provider,
      event,
    );
    if (!actor) return;
    pane.attachment.hook_seq = seq;
    if (event.kind === "session_start")
      runtime.rememberAgent(pane.id, query.provider);
    if (!actor.workspace || !runtime.workspaces.get(actor.workspace))
      actor.workspace = runtime.workspaces.owner(pane.id)?.id ?? 0;
  }
  if (!actor) return;
  if (query.pid > 0) actor.pid = query.pid;
  attention(
    server,
    runtime.conversations.observeHook(
      actor,
      event,
      seq,
      actorWatched(server, actor.id),
      now,
    ),
    actor.state.state,
  );
  workers.summaries.reconcile(runtime.conversations.items);
  changed(server);
}
export async function tick(server: any) {
  const workers = start(server),
    runtime = server.runtime,
    now = clock.milliTimestamp();
  if (workers.settling || now - workers.detected >= 250) {
    workers.detected = now;
    const panes = runtime.panes.filter(
      (pane: any) =>
        !pane.terminal.exited && (workers.settling || pane.detectionDue(now)),
    );
    const jobs = detection.foregroundJobs(
      panes.map((pane: any) => ({ fd: pane.terminal.fd, pid: pane.terminal.pid })),
    );
    for (const pane of panes) {
      detectPane(server, pane, jobs.get(pane.terminal.fd) ?? null);
      pane.detected = { output: pane.terminal.surface_revision, at: now };
    }
    for (const actor of runtime.conversations.items) actor.checkPause();
    workers.codex.reconcile(runtime);
    for (const snapshot of workers.codex.take()) {
      const actor = codexActor(server, snapshot);
      if (!actor) continue;
      attention(
        server,
        actor.observeSnapshot(
          snapshot,
          actorWatched(server, actor.id),
          clock.microTimestamp(),
        ),
        actor.state.state,
      );
      runtime.conversations.observeChildren(
        actor,
        snapshot,
        clock.microTimestamp(),
      );
      workers.summaries.submit(actor, snapshot.evidence, null, runtime.panes);
      changed(server);
    }
    workers.summaries.reconcile(runtime.conversations.items);
    if (server.clients.some((client: any) => client.viewer && !client.dead))
      workers.summaries.observe(now);
    workers.summaries.remember(runtime.last_agent);
    publishInference(server, workers);
    for (const result of workers.summaries.take()) {
      const actor = runtime.conversations.byId(result.request.actor);
      if (actor && result.apply(actor)) changed(server);
    }
    const systemWorking = workers.summaries.implementation.pool.working;
    if (runtime.system_working !== systemWorking) {
      runtime.system_working = systemWorking;
      changed(server);
    }
    const systemUsage = workers.summaries.systemUsage(now);
    if (stringify(runtime.system_usage) !== stringify(systemUsage)) {
      runtime.system_usage = systemUsage;
      changed(server);
    }
    if (runtime.link_labels.reconcile(runtime, workers.summaries, now))
      changed(server);
    for (const result of workers.summaries.takeLinks())
      if (result && runtime.link_labels.apply(result, now)) changed(server);
    workers.usage.reconcile(runtime);
    for (const result of workers.usage.take()) {
      const actor = runtime.conversations.byId(result.actor);
      if (!actor) continue;
      if (!actor.model_from_hook && result.model.id.len)
        actor.model = result.model;
      if (!actor.native_usage) actor.live_usage = result.live;
      actor.context = result.context;
      runtime.conversations.compaction_points.learn(
        result.context.model.id.text(),
        result.context.auto_compaction,
      );
      if (
        result.continued.len &&
        actor.provider() === "claude" &&
        result.continued.text() !== actor.state.sessionId()
      ) {
        const next = runtime.conversations.get(
          "claude",
          result.continued.text(),
        );
        next.workspace ||= actor.workspace;
        if (!next.state.last_seq) {
          next.state.state =
            actor.state.state === "done" ? "idle" : actor.state.state;
          next.state.cwd = actor.state.cwd;
          next.state.transcript = Path.initTruncated(
            path.join(
              path.dirname(actor.state.transcriptPath()),
              result.continued.text() + ".jsonl",
            ),
          );
        }
        let followed = false;
        for (const pane of runtime.panes)
          if (pane.attachment.actor === actor) {
            pane.attachment.select(next);
            followed = true;
          }
        if (followed) {
          actor.state.state = "done";
          actor.state.tool_active = false;
          actor.state.paused = false;
        }
      }
      actor.observeTranscriptTurn(result.spoke_at);
      actor.observeTaskEnds(result.ended);
      if (result.progress) actor.observeTools(result.progress);
      if (result.fallback(actor.state, clock.microTimestamp()))
        workers.summaries.submit(
          actor,
          result.progress!.commentary,
          result.progress,
          runtime.panes,
        );
      else if (result.progress)
        workers.summaries.tools(actor.id, actor.state, result.progress);
      if (!actor.native_usage && !workspaceWatched(server, result.workspace))
        runtime.workspaces
          .get(result.workspace)
          ?.away.record(result.since, result.delta);
      changed(server);
    }
    workers.transcripts.reconcile(runtime.conversations.items);
    for (const result of workers.transcripts.take()) {
      const actor = runtime.conversations.byId(result.actor);
      if (!actor) continue;
      attention(
        server,
        actor.confirmStop(result.seq, result.outcome, clock.microTimestamp()) &&
          !actorWatched(server, actor.id),
        actor.state.state,
      );
      changed(server);
    }
  }
  for (const session of runtime.sessions) {
    const seq = session.next_seq;
    attention(server, session.poll(runtime.conversations), session.status());
    if (!workspaceWatched(server, session.workspace_id))
      runtime.workspaces
        .get(session.workspace_id)
        ?.away.record(
          runtime.workspaces.get(session.workspace_id).away.since,
          session.usage_pending,
        );
    session.usage_pending = new Counts();
    if (session.next_seq !== seq || session.reap()) changed(server);
  }
}
export async function settle(server: any) {
  const workers = start(server);
  workers.settling++;
  try {
    await tick(server);
    await Promise.all(
      [workers.transcripts, workers.usage, workers.codex].map(
        async (worker) => {
          while (worker.running && !worker.stopping) await Bun.sleep(1);
          await worker.run();
        },
      ),
    );
    await tick(server);
    void workers.summaries.run();
  } finally {
    workers.settling--;
  }
}

export function stop(server: any) {
  const workers = services.get(server);
  if (!workers) return;
  workers.transcripts.stop();
  workers.codex.stop();
  workers.usage.stop();
  workers.summaries.stop();
  services.delete(server);
}

export function poke(server: any) {
  void start(server).summaries.run();
}
