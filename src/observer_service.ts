import { Worker as TranscriptWorker } from "./transcript";
import { Worker as UsageWorker } from "./usage/worker";
import { Worker as SummaryWorker } from "./activity/worker";
import { Provider, adapter } from "./providers";
import { Path, type Presence } from "./agents";
import { ResumeHint } from "./resume_hint";
import { Counts } from "./usage/tokens";
import * as setup from "./inference/setup";
import * as detection from "./detection";
import * as clock from "./clock";
import { stringify } from "./json";
import type { Server } from "./server";
import { Launch, type Runtime, type Pane } from "./runtime";
import type { Text } from "./providers";
import type { Known, Observer, Watcher } from "./providers/adapter";
import type { Snapshot, Request as ObserverRequest } from "./providers/snapshot";
import type { Request } from "./protocol";
import { Model } from "./providers/model";
import * as accounts from "./accounts";
import * as integration from "./integration";

type Workers = {
  transcripts: TranscriptWorker;
  /** Each account's observer, by provider and account. */
  observers: Map<string, { provider: Provider; account: string; observer: Observer }>;
  /** Each provider's watcher, by provider and account. */
  watchers: Map<string, Watcher>;
  usage: UsageWorker;
  summaries: SummaryWorker;
  detected: number;
  settling: number;
};
const services = new WeakMap<Server, Workers>();
export function start(server: Server) {
  if (services.has(server)) return services.get(server)!;
  const workers = {
    transcripts: TranscriptWorker.start(),
    observers: new Map(
      Provider.all.flatMap(p => {
        const observer = adapter(p).observer?.("");
        return observer ? [[`${p}\0`, { provider: p, account: "", observer }] as const] : [];
      }),
    ),
    watchers: new Map<string, Watcher>(),
    usage: server.usage ?? UsageWorker.start(),
    summaries:
      server.summaries ??
      SummaryWorker.start(
        setup.initial(setup.load(setup.path(server.socket))),
        setup.loadUses(setup.path(server.socket)),
      ),
    detected: 0,
    settling: 0,
  };
  if (!server.summaries) workers.summaries.selected = setup.loadSelection(setup.path(server.socket));
  server.summaries = workers.summaries;
  server.usage = workers.usage;
  services.set(server, workers);
  publishInference(server, workers);
  return workers;
}
/** The watcher for `provider`'s `account`, "" for the default one. */
function watcher(workers: Workers, provider: Provider, account = "") {
  const key = `${provider}\0${account}`;
  let found = workers.watchers.get(key);
  if (!found) workers.watchers.set(key, (found = adapter(provider).watch(account)));
  return found;
}
/** Starts an observer for each other account a live pane runs its agent in,
 * and stops those no pane needs. */
function observeAccounts(workers: Workers, runtime: Runtime) {
  const wanted = new Set<string>();
  for (const pane of runtime.panes) {
    const provider = pane.agent().provider;
    if (pane.terminal.exited || !provider) continue;
    const account = pane.account(),
      key = `${provider}\0${account}`;
    wanted.add(key);
    if (!account || workers.observers.has(key)) continue;
    const observer = adapter(provider).observer?.(account);
    if (observer) workers.observers.set(key, { provider, account, observer });
  }
  for (const [key, { account, observer }] of workers.observers)
    if (account && !wanted.has(key)) {
      observer.stop();
      workers.observers.delete(key);
    }
}
function publishInference(server: Server, workers: Workers) {
  const status = workers.summaries.status();
  if (stringify(status) !== stringify(server.runtime.inference)) {
    server.runtime.inference = status;
    server.runtime.system_model = Model.resolve(status.model);
    changed(server);
  }
}
function paneWatched(server: Server, pane: number) {
  return server.clients.some(
    client =>
      !client.dead &&
      client.viewer &&
      client.watched &&
      client.view_focus === pane &&
      Date.now() - client.touched < 1000,
  );
}
function actorWatched(server: Server, id: number) {
  return server.runtime.panes.some(
    pane => !pane.terminal.exited && pane.attachment.actor?.id === id && paneWatched(server, pane.id),
  );
}
function workspaceWatched(server: Server, id: number) {
  return server.clients.some(
    client =>
      !client.dead &&
      client.viewer &&
      client.watched &&
      client.view_workspace === id &&
      Date.now() - client.touched < 1000,
  );
}
function changed(server: Server) {
  server.dirty = true;
  server.runtime.changed();
}
function attention(server: Server, ding: boolean, state: string) {
  server.attention(ding, state);
}

/** The pane, when it still shows the title session `request` asked about. */
function titled(runtime: Runtime, provider: Provider, request: ObserverRequest) {
  const pane = runtime.pane(request.pane);
  const prefix = pane ? (adapter(provider).titleSession?.(pane.terminal.title) ?? null) : null;
  if (
    !pane ||
    !prefix ||
    pane.terminal.exited ||
    pane.detection.missing ||
    pane.detection.pid !== request.pid ||
    pane.terminal.title_pid !== request.pid ||
    pane.terminal.title_revision !== request.title_revision ||
    pane.attachment.generation !== request.generation ||
    prefix.text() !== request.prefix.text()
  )
    return null;
  return pane;
}
/** The conversation an observer's snapshot is of, shown in the pane whose title named it. */
export function snapshotActor(server: Server, provider: Provider, snapshot: Snapshot) {
  const runtime = server.runtime;
  if (snapshot.request.actor) return runtime.conversations.byId(snapshot.request.actor);
  const pane = titled(runtime, provider, snapshot.request);
  if (!pane) return null;
  // A side conversation leaves the pane on the conversation it forked.
  if (snapshot.ephemeral) {
    if (pane.attachment.actor) pane.attachment.side = true;
    return null;
  }
  const actor = runtime.conversations.get(provider, snapshot.session);
  pane.attachment.select(actor);
  if (!actor.workspace || !runtime.workspaces.get(actor.workspace))
    actor.workspace = runtime.workspaces.owner(pane.id)?.id ?? actor.workspace;
  return actor;
}
/** The observer can't see the thread the title moved to, so the pane no
 * longer shows a conversation it knows. */
export function missed(server: Server, provider: Provider, request: ObserverRequest) {
  const pane = titled(server.runtime, provider, request),
    actor = pane?.attachment.actor;
  if (!pane || !actor || pane.attachment.side || actor.state.sessionId().startsWith(request.prefix.text())) return;
  pane.attachment.deselect();
  changed(server);
}
/** The one known conversation whose session the title names. */
function titleActor(runtime: Runtime, provider: Provider, prefix: Text) {
  const matches = runtime.conversations.items.filter(
    actor => actor.provider() === provider && actor.state.sessionId().startsWith(prefix.text()),
  );
  return matches.length === 1 ? matches[0] : null;
}
/** The title named the session `prefix`. Another session than the one
 * shown may be a side conversation of it, which the observer tells, so the
 * pane keeps its conversation unless the title names a known one. */
export function retitled(runtime: Runtime, pane: Pane, provider: Provider, prefix: Text | null) {
  const hash = prefix ? Bun.hash.wyhash(prefix.text(), 0n) : 0n,
    binding = pane.attachment,
    actor = binding.actor;
  if (hash === binding.selection_hash) return;
  if (
    actor &&
    (!prefix || (!actor.state.sessionId().startsWith(prefix.text()) && titleActor(runtime, provider, prefix)))
  )
    binding.deselect();
  binding.side = false;
  binding.generation++;
  binding.selection_hash = hash;
}
export function reattachFromTitle(server: Server, pane: Pane, provider: Provider, pid: number) {
  if (
    pane.detection.claim ||
    pane.attachment.actor ||
    pane.terminal.exited ||
    pid <= 0 ||
    pane.terminal.title_pid !== pid
  )
    return;
  const prefix = adapter(provider).titleSession?.(pane.terminal.title);
  const actor = prefix && titleActor(server.runtime, provider, prefix);
  if (!actor) return;
  pane.attachment.select(actor);
  if (!actor.workspace || !server.runtime.workspaces.get(actor.workspace))
    actor.workspace = server.runtime.workspaces.owner(pane.id)?.id ?? actor.workspace;
}
/** Claims are provisional screen identity, never a local conversation or resume command. */
export function claimPane(server: Server, query: Request<"pane.agent">) {
  const pane = server.runtime.pane(query.pane);
  if (!pane) throw Error("NoPane");
  if (pane.terminal.exited) throw Error("PaneExited");
  if (query.owner <= 1) throw Error("InvalidOwner");
  const previous = pane.detection.claim;
  if (previous && detection.claimAlive(previous) && previous.owner !== query.owner) throw Error("AgentClaimed");
  if (query.provider === null && !previous) return;
  const claim = query.provider === null ? null : detection.claim(query.provider, query.owner);
  if (claim && previous && detection.claimAlive(previous) && claim.provider === previous.provider) return;
  pane.releaseDetection();
  pane.detection.claim = claim;
  pane.resume_hint = new ResumeHint();
  if (pane.launch?.agent) pane.launch = null;
  detectPane(server, pane);
  changed(server);
}
export function detectPane(server: Server, pane: Pane, observedJob?: detection.Job | null) {
  const runtime = server.runtime,
    workers = start(server),
    worker = workers.summaries;
  const before = stringify(pane.agent());
  const generation = pane.attachment.generation;
  if (pane.detection.claim && (pane.terminal.exited || !detection.claimAlive(pane.detection.claim))) {
    pane.releaseDetection();
  }
  const claim = pane.detection.claim;
  const job = claim
    ? null
    : observedJob === undefined
      ? (detection.foreground(pane.terminal.fd)?.job ?? null)
      : observedJob;
  const previous = pane.detection.pid;
  if (!claim) pane.resume_hint.observe(pane.agent());
  if (job) {
    if ((previous && previous !== job.pid) || (pane.attachment.actor && pane.agent().provider !== job.provider))
      pane.releaseDetection();
    // An agent someone typed into the pane's shell comes back as they typed it.
    if (job.pid !== previous && (!pane.launch || pane.launch.agent?.observed))
      pane.launch = Launch.observed(job.provider, job.pid);
    // A saved command's own variables may be spelled past reading; its agent's say.
    if (job.pid !== previous && pane.launch?.command)
      pane.running_account = Launch.observed(job.provider, job.pid).account() || null;
    // An agent in an account Corgi hadn't seen gets its hooks from the next start on.
    const account = job.pid !== previous ? pane.account() : "";
    if (account && !accounts.forgotten(account)) {
      accounts.remember(job.provider, account);
      void integration.prepare(job.provider, account);
    }
    const shown = adapter(job.provider);
    if (shown.titleSession) {
      retitled(runtime, pane, job.provider, shown.titleSession(pane.terminal.title));
      reattachFromTitle(server, pane, job.provider, job.pid);
    }
  }
  const now = clock.microTimestamp(),
    actor = pane.attachment.actor,
    watched = paneWatched(server, pane.id);
  const authoritative = actor?.authoritative(now) ?? false;
  pane.attachment.provisional.last_seq = authoritative ? 1n : 0n;
  let speaks: boolean;
  if (claim) {
    const agent = pane.attachment.provisional;
    if (agent.provider !== claim.provider) {
      agent.reset();
      agent.provider = claim.provider;
      agent.state = "initializing";
    }
    speaks = true;
  } else speaks = pane.detection.update(pane.attachment.provisional, job);
  if (actor?.state.last_seq) pane.detection.followStructured();
  if (job && job.pid !== previous) worker.observeLaunch(job.provider);
  if (previous && !pane.detection.pid) pane.releaseDetection();
  // The provider judges its own screen; without one running, the pane shows nothing.
  const judge = claim?.provider ?? job?.provider ?? actor?.provider();
  let ding = false;
  if (judge) {
    let text: string | null = null;
    const view = {
        id: pane.id,
        title: claim || job ? pane.terminal.title : "",
        text: () => (text ??= claim || job ? pane.terminal.liveText() : ""),
      },
      known: Known | null = actor && {
        state: actor.state.state,
        authoritative,
        pending_stop: actor.state.observation.pending_stop,
        permission_review: !!actor.state.permission_review,
        prompt: actor.prompt_watch,
      },
      seen = watcher(workers, judge, pane.account()).read(view, pane.detection, known, now);
    const target = actor && pane.detection.screen_only ? actor.state : pane.attachment.provisional;
    if (seen.shown && speaks && (claim || job)) ding = pane.detection.show(target, seen.shown, watched);
    if (actor) {
      if (target !== actor.state) actor.screen(pane.attachment.provisional, ding, now);
      if (actor.state.state === "working") actor.observeCompactionScreen(seen.compacting, now);
      if (seen.interrupted) actor.state.abandonTurn(now);
      if (seen.answered) actor.state.observeAnswer(seen.answered, now);
      if (actor.state.permission_review)
        ding = actor.state.observePermissionPrompt(seen.prompt === true, watched, now) || ding;
    }
  }
  if (!claim) pane.resume_hint.observe(pane.agent());
  if (generation !== pane.attachment.generation || before !== stringify(pane.agent())) changed(server);
  attention(server, ding, pane.agent().state);
}
/** The live pane that shows `provider`'s `session`, if one does. */
function showing(runtime: Runtime, provider: Provider, session: string) {
  const actor = runtime.conversations.find(provider, session);
  return (actor && runtime.panes.find(pane => !pane.terminal.exited && pane.attachment.actor === actor)?.id) ?? null;
}
export function hook(server: Server, query: Request<"hook">) {
  const workers = start(server),
    runtime = server.runtime;
  const event = adapter(query.provider).hook(query.event);
  if (!event) return;
  const now = clock.microTimestamp(),
    seq = query.seq ?? BigInt(now);
  const child = event.independent_child;
  const known = runtime.conversations.find(query.provider, event.session),
    presence: Presence =
      known && runtime.attachments(known) > 0 ? "attached" : query.background ? "detached" : "attaching";
  let actor;
  if (query.background) actor = known;
  else {
    const from = runtime.pane(query.pane);
    if (from?.detection.claim) return;
    const route = watcher(workers, query.provider, from?.account() ?? "").route(event, query.pane, session =>
        showing(runtime, query.provider, session),
      ),
      pane = route && runtime.pane(route.pane);
    if (!pane) throw Error("NoPane");
    if (pane.detection.claim) return;
    detectPane(server, pane);
    if (!child && seq <= pane.attachment.hook_seq) return;
    actor = runtime.conversations.routeHook(pane.attachment, query.provider, event, route.binds);
    if (!actor) return;
    if (!child) pane.attachment.hook_seq = seq;
    if (event.kind === "session_start") runtime.rememberAgent(pane.id, query.provider);
    if (!actor.workspace || !runtime.workspaces.get(actor.workspace))
      actor.workspace = runtime.workspaces.owner(pane.id)?.id ?? 0;
  }
  if (!actor) return;
  if (query.pid > 0) actor.pid = query.pid;
  attention(
    server,
    runtime.conversations.observeHook(actor, event, seq, actorWatched(server, actor.id), now, presence),
    actor.state.state,
  );
  workers.summaries.reconcile(runtime.conversations.items, runtime.panes);
  if (event.initial_request) workers.summaries.names.offer(actor, event.initial_request);
  changed(server);
}
export async function tick(server: Server) {
  const workers = start(server),
    runtime = server.runtime,
    now = clock.milliTimestamp();
  if (workers.settling || now - workers.detected >= 250) {
    workers.detected = now;
    const panes = runtime.panes.filter(pane => !pane.terminal.exited && (workers.settling || pane.detectionDue(now)));
    const fronts = detection.foregrounds(
      panes.filter(pane => !pane.detection.claim).map(pane => ({ fd: pane.terminal.fd, pid: pane.terminal.pid })),
    );
    for (const pane of panes) {
      const front = fronts.get(pane.terminal.fd);
      detectPane(server, pane, front && front.job);
      if (front !== undefined && pane.observeFront(front)) {
        server.dirty = true;
        runtime.refreshed();
      }
      pane.detected = { output: pane.terminal.surface_revision, at: now };
    }
    for (const actor of runtime.conversations.items) actor.checkPause();
    observeAccounts(workers, runtime);
    for (const { provider, observer } of workers.observers.values()) {
      observer.reconcile(runtime);
      for (const request of observer.takeMissed()) missed(server, provider, request);
      for (const snapshot of observer.take()) {
        const actor = snapshotActor(server, provider, snapshot);
        if (!actor) continue;
        attention(
          server,
          actor.observeSnapshot(snapshot, actorWatched(server, actor.id), clock.microTimestamp()),
          actor.state.state,
        );
        runtime.conversations.observeChildren(actor, snapshot, clock.microTimestamp());
        workers.summaries.submit(actor, snapshot.evidence, null, runtime.panes);
        changed(server);
      }
    }
    const at = clock.microTimestamp();
    for (const actor of runtime.conversations.items) if (actor.state.trackWorking(at)) changed(server);
    workers.summaries.reconcile(runtime.conversations.items, runtime.panes);
    if (server.clients.some(client => client.viewer && !client.dead)) workers.summaries.observe(now);
    workers.summaries.remember(runtime.last_agent);
    publishInference(server, workers);
    for (const result of workers.summaries.take()) {
      const actor = runtime.conversations.byId(result.request.actor);
      if (actor && result.apply(actor)) changed(server);
    }
    for (const result of workers.summaries.names.take()) {
      const actor = runtime.conversations.byId(result.request.actor);
      if (!workers.summaries.naming() || !actor || !result.name || !result.matches(actor)) continue;
      const pane = runtime.panes.find(p => p.attachment.actor === actor && !p.terminal.exited);
      if (!pane || [...runtime.renames, ...runtime.wanted_names].some(r => r.pane === pane.id)) continue;
      // The provider checks for a name set while inference was in flight.
      try {
        const status = await adapter(actor.provider()).rename?.suggest?.(
          actor.state.sessionId(),
          result.name.text(),
          pane.account(),
        );
        if (status === "exists") continue;
      } catch {
        // Keep a local name if the provider's channel is gone.
      }
      if (
        runtime.panes.includes(pane) &&
        !pane.terminal.exited &&
        pane.attachment.actor === actor &&
        result.apply(actor)
      )
        changed(server);
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
    if (runtime.link_labels.reconcile(runtime, workers.summaries, now)) changed(server);
    for (const result of workers.summaries.takeLinks())
      if (result && runtime.link_labels.apply(result, now)) changed(server);
    workers.usage.reconcile(runtime);
    for (const result of workers.usage.take()) {
      const actor = runtime.conversations.byId(result.actor);
      if (!actor) continue;
      if (result.checklist) actor.observeChecklist(result.checklist);
      if (!actor.model_from_hook && result.model.id.len) actor.model = result.model;
      if (!actor.headless_usage) actor.live_usage = result.live;
      actor.context = result.context;
      runtime.conversations.compaction_points.learn(result.context.model.id.text(), result.context.auto_compaction);
      const continuation = adapter(actor.provider()).transcript?.continuation;
      if (result.continued.len && continuation && result.continued.text() !== actor.state.sessionId()) {
        const next = runtime.conversations.get(actor.provider(), result.continued.text());
        next.workspace ||= actor.workspace;
        if (!next.state.last_seq) {
          next.state.state = actor.state.state === "done" ? "idle" : actor.state.state;
          next.state.cwd = actor.state.cwd;
          next.state.transcript = Path.initTruncated(
            continuation(actor.state.transcriptPath(), result.continued.text()),
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
      const now = clock.microTimestamp();
      if (result.fallback(actor.state, now)) {
        if (adapter(actor.provider()).caps.native_activity) actor.checkpointActivity(false, now);
        else workers.summaries.submit(actor, result.progress!.commentary, result.progress, runtime.panes);
      } else if (result.progress) workers.summaries.tools(actor.id, actor.state, result.progress);
      if (!actor.headless_usage && !workspaceWatched(server, result.workspace))
        runtime.workspaces.get(result.workspace)?.away.record(result.since, result.delta);
      changed(server);
    }
    workers.transcripts.reconcile(runtime.conversations.items);
    for (const result of workers.transcripts.take()) {
      const actor = runtime.conversations.byId(result.actor);
      if (!actor) continue;
      attention(
        server,
        actor.confirmStop(result.seq, result.outcome, clock.microTimestamp()) && !actorWatched(server, actor.id),
        actor.state.state,
      );
      changed(server);
    }
    if (runtime.pruneConversations()) changed(server);
  }
  for (const session of runtime.sessions) {
    const seq = session.next_seq;
    attention(server, session.poll(runtime.conversations), session.status());
    const workspace = runtime.workspaces.get(session.workspace_id);
    if (workspace && !workspaceWatched(server, session.workspace_id))
      workspace.away.record(workspace.away.since, session.usage_pending);
    session.usage_pending = new Counts();
    if (session.next_seq !== seq || session.reap()) changed(server);
  }
}
export async function settle(server: Server) {
  const workers = start(server);
  workers.settling++;
  try {
    await tick(server);
    await Promise.all(
      [workers.transcripts, workers.usage, ...[...workers.observers.values()].map(o => o.observer)].map(
        async worker => {
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

export function stop(server: Server) {
  const workers = services.get(server);
  if (!workers) return;
  workers.transcripts.stop();
  for (const { observer } of workers.observers.values()) observer.stop();
  workers.usage.stop();
  workers.summaries.stop();
  services.delete(server);
}

export function poke(server: Server) {
  void start(server).summaries.run();
}
