//! The daemon's side of voice mode: at most one attached voice, its shared
//! mute state, and where dictated text goes.

export type VoiceState = "listening" | "muted";
type ViewerInfo = { viewer_id: number; active_seq: bigint | number; view_focus: number | null };
type VoicePresence = {
  voice_id: string;
  client: unknown;
  muted: boolean;
  available: boolean;
  pane: number | null;
  lease_until: number;
  /** Whether a viewer was attached, and the pane text would go to, as the voice last heard. */
  viewer: boolean;
  focus: string | null;
};

/** How long a voice stays attached without a `voice.set`, in ms. */
const lease_ms = 3000;

export class Presence {
  private current: VoicePresence | null = null;
  /** Called when a viewer changes the mute state, so the voice hears of it. */
  onMuted: (muted: boolean) => void = () => {};
  get client(): unknown {
    return this.current?.client ?? null;
  }
  watch(
    client: unknown,
    req: { pane?: number | null; muted: boolean; available: boolean },
    now: number,
    seen: { viewer: boolean; focus: string | null } = { viewer: true, focus: null },
  ): { voice_id: string; muted: boolean; viewer: boolean; focus: string | null } {
    if (this.current) throw Error("VoiceAttached");
    this.current = {
      voice_id: "v-" + crypto.randomUUID(),
      client,
      muted: req.muted,
      available: req.available,
      pane: req.pane ?? null,
      lease_until: now + lease_ms,
      ...seen,
    };
    return { voice_id: this.current.voice_id, muted: this.current.muted, ...seen };
  }
  /** The attached voice, if `voice_id` names it. */
  require(voice_id: string): VoicePresence {
    if (this.current?.voice_id !== voice_id) throw Error("VoiceGone");
    return this.current;
  }
  set(req: { voice_id: string; muted?: boolean | null; available?: boolean | null }, now: number): { muted: boolean } {
    const voice = this.require(req.voice_id);
    voice.lease_until = now + lease_ms;
    if (req.muted != null) voice.muted = req.muted;
    if (req.available != null) voice.available = req.available;
    return { muted: voice.muted };
  }
  /** Notes whether a viewer is attached and what its focused pane is called;
   * true when the voice should hear of a change, since without a viewer it has
   * nowhere to type. */
  see(seen: { viewer: boolean; focus: string | null }): boolean {
    const voice = this.current;
    if (!voice || (voice.viewer === seen.viewer && voice.focus === seen.focus)) return false;
    Object.assign(voice, seen);
    return true;
  }
  /** Flips mute for a viewer. A voice that cannot listen stays muted. */
  toggle(): { muted: boolean } {
    const voice = this.current;
    if (!voice) throw Error("NoVoice");
    if (!voice.available) return { muted: true };
    voice.muted = !voice.muted;
    this.onMuted(voice.muted);
    return { muted: voice.muted };
  }
  /** Drops a voice whose lease ran out; true when one was dropped. `heard`
   * is when its connection last sent anything, which a daemon busy with other
   * work has read but not yet handled. */
  expire(now: number, heard = 0): boolean {
    if (!this.current || now <= Math.max(this.current.lease_until, heard + lease_ms)) return false;
    this.current = null;
    return true;
  }
  drop(client: unknown): boolean {
    if (!this.current || this.current.client !== client) return false;
    this.current = null;
    return true;
  }
  /** The viewer used last. */
  viewer<V extends ViewerInfo>(viewers: readonly V[]): V {
    let last: V | null = null;
    for (const v of viewers) if (!last || v.active_seq > last.active_seq) last = v;
    if (!last) throw Error("NoViewer");
    return last;
  }
  /** The focused pane of the viewer used last. */
  target(viewers: readonly ViewerInfo[], panes: ReadonlySet<number>): { viewer: number; pane: number } {
    const last = this.viewer(viewers),
      pane = last.view_focus;
    if (pane === null || !panes.has(pane)) throw Error("NoFocusedPane");
    if (pane === this.current?.pane) throw Error("VoicePane");
    return { viewer: last.viewer_id, pane };
  }
  projection(): { state: VoiceState } | undefined {
    const voice = this.current;
    if (!voice) return undefined;
    return { state: voice.muted || !voice.available ? "muted" : "listening" };
  }
}
