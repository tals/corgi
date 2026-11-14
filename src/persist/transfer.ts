//! The fixed envelope used between independently evolving daemon builds.
import type { Runtime } from "../runtime";
import * as json from "../json";
import * as subprocess from "../subprocess";
import * as core from "./core";
import * as formats from "./formats";
import * as state_formats from "./state_formats";
import * as migrations from "./migrations";
import type * as checkpoint from "./checkpoint";

export const protocol = 1;
export type Info = { handoff: number; formats: string[] };
export function info(): Info {
  return { handoff: protocol, formats: formats.supported(state_formats.history) };
}
export function compatible(value: unknown): boolean {
  return json.field(value, "handoff") === protocol;
}
export async function discover(executable: string): Promise<Info | null> {
  const result = await subprocess
    .run([executable, "__handoff-info"], {
      env: { ...process.env, CORGI_APP_EXE: executable },
      timeout_ms: 15_000,
      max_output: 128 * 1024,
      stderr: true,
    })
    .catch(() => {
      throw Error("ReloadCandidateFailed");
    });
  if (!result.ok()) {
    if (
      /^corgi: (?:UnknownCommand|unknown command __handoff-info; see corgi --help)\r?$/m.test(result.stderr.toString())
    )
      return null;
    throw Error("ReloadCandidateFailed");
  }
  const value = json.object(json.parse(result.stdout.toString()));
  if (value.handoff !== protocol) throw Error("UnsupportedHandoffProtocol");
  return { handoff: protocol, formats: formats.parse(value.formats) };
}
export type Envelope = {
  transfer: number;
  format: string;
  core: core.Core;
  payload: unknown;
  requester: number;
  request_id: number | null;
  start_lock: number;
  older_updater: boolean;
  handles: number[];
};
/** The caller remaps descriptors before migrating metadata; core never enters a migration. */
export function encode(
  runtime: Runtime,
  manifest: Record<string, any>,
  readable: readonly string[],
  handles: number[],
  history = state_formats.history,
): Envelope {
  const format = formats.select(history, readable);
  let payload: unknown = null;
  if (format !== formats.baseline) {
    const { requester, request_id, start_lock, older_updater, ...saved } = manifest,
      metadata = json.clone(saved);
    // Screens and PTY descriptors belong exclusively to core.
    for (const pane of metadata.runtime.panes) delete pane.screen;
    payload = history.down(metadata, format);
  }
  return {
    transfer: protocol,
    format,
    core: core.capture(runtime, manifest.runtime),
    payload,
    requester: manifest.requester,
    request_id: manifest.request_id,
    start_lock: manifest.start_lock,
    older_updater: manifest.older_updater,
    handles,
  };
}
export function decode(value: unknown, history = state_formats.history) {
  const v = json.object(value);
  if (v.transfer !== protocol) throw Error("UnsupportedHandoffProtocol");
  const essential = core.decode(v.core);
  if (!essential.live) throw Error("InvalidHandoffCore");
  if (typeof v.format !== "string" || !formats.supported(history).includes(v.format))
    throw Error("UnsupportedStateFormat");
  const restored = v.format === formats.baseline ? null : history.up(v.payload, v.format),
    metadata = restored === null ? {} : json.object(restored);
  const fd = (value: unknown) => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < -1 || value > 0x7fffffff)
      throw Error("InvalidHandoffCore");
    return value;
  };
  if (!Array.isArray(v.handles)) throw Error("InvalidHandoffCore");
  const handles = v.handles.map(fd);
  if (new Set(handles).size !== handles.length || handles.some((n: number) => n < 0)) throw Error("InvalidHandoffCore");
  const requester = fd(v.requester),
    start_lock = fd(v.start_lock);
  for (const handle of [requester, start_lock, ...essential.panes.map(p => p.screen.fd)])
    if (handle >= 0 && !handles.includes(handle)) throw Error("InvalidHandoffCore");
  if (v.request_id !== null && (!Number.isSafeInteger(v.request_id) || v.request_id <= 0))
    throw Error("InvalidHandoffCore");
  if (typeof v.older_updater !== "boolean") throw Error("InvalidHandoffCore");
  return {
    ...metadata,
    version: migrations.handoff_version,
    runtime: core.restore(essential, metadata.runtime),
    requester,
    request_id: v.request_id as number | null,
    start_lock,
    older_updater: v.older_updater,
    transferred_handles: handles as number[],
  };
}
/** Keep a legacy checkpoint alongside the core envelope during the baseline rollout. */
export function recovery(runtime: Runtime, saved: ReturnType<typeof checkpoint.capture>) {
  return {
    ...saved,
    transfer: { protocol, format: state_formats.history.current, core: core.capture(runtime, saved) },
  };
}
/** Export the numbered format before the pre-baseline transport adapter runs. */
export function downgrade(runtime: Runtime, value: Record<string, any>, history = state_formats.history) {
  if (history.current === formats.initial) return value;
  return migrateLegacy(value, core.capture(runtime, value.runtime), metadata =>
    history.down(metadata, formats.initial),
  );
}
/** Continue numbered snapshots through later state revisions without exposing their core. */
export function upgrade(value: unknown, history = state_formats.history): Record<string, any> {
  const saved = json.object(value);
  if (history.current === formats.initial) return saved;
  return migrateLegacy(saved, core.fromCheckpoint(saved.runtime), metadata => history.up(metadata, formats.initial));
}
function migrateLegacy(value: Record<string, any>, essential: core.Core, step: formats.Step) {
  const { requester, request_id, start_lock, older_updater, retired, update_abi, terminal_abi, version, ...metadata } =
      json.clone(value),
    transport = { requester, request_id, start_lock, older_updater, retired, update_abi, terminal_abi, version },
    restore = (fields: Record<string, any>) => ({
      ...fields,
      ...transport,
      runtime: core.restore(essential, fields.runtime),
    });
  for (const pane of metadata.runtime.panes) delete pane.screen;
  try {
    const restored = step(metadata);
    return restore(restored === null ? {} : json.object(restored));
  } catch {
    // Numbered readers can also restore a checkpoint containing only core.
  }
  return restore({});
}
export function recover(bytes: string, history = state_formats.history, coreOnly = false) {
  const saved = json.object(json.parse(bytes));
  if (saved.transfer === undefined) {
    const decoded = migrations.decode("checkpoint", bytes);
    return {
      ...decoded,
      value: upgrade({ runtime: decoded.value }, history).runtime,
      migrated: decoded.migrated || history.current !== formats.initial,
    };
  }
  const { transfer, ...payload } = saved,
    envelope = json.object(transfer);
  if (envelope.protocol !== protocol) throw Error("UnsupportedHandoffProtocol");
  const essential = core.decode(envelope.core);
  if (essential.live) throw Error("InvalidHandoffCore");
  if (!formats.id(envelope.format)) throw Error("InvalidStateFormats");
  const known =
      !coreOnly && envelope.format !== formats.baseline && formats.supported(history).includes(envelope.format),
    restored = known ? history.up({ runtime: payload }, envelope.format) : null,
    metadata = restored === null ? {} : json.object(restored);
  return {
    value: core.restore(essential, metadata.runtime),
    from: saved.version,
    migrated: coreOnly || envelope.format !== history.current,
  };
}
