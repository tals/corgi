import { Notice as MachineNotice } from "./machine_diagnostics";
import { Menu as ConnectivityMenu } from "./connectivity_menu";
import * as connectivityCard from "./connectivity_card";
import * as composition from "./composition";
import { basename, dirname, join } from "node:path";
import { Endpoint, localEndpoint, quiet_ms } from "./machine_connection";
import * as terminalInput from "./terminal_input";
import * as keys from "./keys";
import type * as keyboard from "./keyboard";
import type { Parser, Input } from "./terminal_input";
import * as machines from "./machines";
import * as errors from "./errors";
import { sshEndpoint } from "./ssh_path";
import * as sidebar from "./sidebar";
import { Workspaces } from "./machine_sidebar";
import * as machineAdd from "./machine_add";
import * as viewer from "./viewer";
import * as corgiBadge from "./corgi_badge";
import * as hostBackground from "./host_background";
import * as palette from "./palette";
import * as framePacing from "./frame_pacing";
import * as preferences from "./preferences";
import * as discovery from "./discovery";
import * as corgiAnimation from "./corgi_animation";
import { attach } from "./host";
import { Openers } from "./url_opener";
import * as imageCopy from "./image_copy";
import * as portForwards from "./port_forwards";
import { sshViewer } from "./trackers/ports";
import { Wake } from "./wake";
import type { Probe } from "./terminal_info";
import type { Differ } from "./frame_diff";
import { Controller, type Effect } from "./controller";
import type { Focus } from "./machine";
import type { State as SyncNotice } from "./sync_notice";
import * as i18n from "./i18n";

/** A gap between frames this long means the computer slept. */
const slept_ms = 5000;
/** With no input or change on screen this long, the viewer idles. */
const idle_after_ms = 1000;
/** A machine this long behind says so over the focused pane. */
const behind_after_ms = 1000;
const scroll_save_ms = 1000;
export interface Options {
  folder?: string | null;
  /** Starts the local daemon: when the viewer opens on another machine, and
   * whenever it's gone. */
  start_local?: () => Promise<void>;
  /** The local daemon is already running, so `start_local` waits until it's gone. */
  local_running?: boolean;
  /** Opens on onboarding's welcome. */
  onboarding?: boolean;
  /** Shows the saved machines beside the local one. */
  machines?: boolean;
}
/** One view shows every machine. Each machine's connection runs on its own,
 * and choosing a workspace on another machine switches the view to it.
 * Returns the executable a replaced local daemon asked the viewer to run. */
export async function run(
  local: string,
  selected: string,
  probe: Probe,
  parser: Parser,
  initial: Input[],
  stdin: viewer.Stdin,
  options: Options = {},
): Promise<string | null> {
  const wake = new Wake();
  const host = attach(preferences.load(), probe);
  // Sign-in asks which agents are there; mise answers for its shims meanwhile.
  void discovery.ready();
  // A catalog that can't be read leaves this machine's work usable.
  let saved: machines.Profile[] = [],
    unreadable: unknown = null;
  if (options.machines !== false)
    try {
      saved = machines.read();
    } catch (error) {
      if (selected !== "local") throw error;
      unreadable = error;
    }
  const endpoints = [
    localEndpoint(local, probe, host, options.start_local, options.local_running),
    ...saved.map(profile => sshEndpoint(profile, probe, host)),
  ];
  let active = endpoints.find(e => e.name === selected);
  if (!active) throw Error("UnknownMachine");
  // Typing waits in the panes it's meant for until their machine catches
  // up; one still behind after a moment says so.
  let behind = null as { endpoint: Endpoint; since: number; shown: boolean } | null;
  const noticeDue = () => (behind && !behind.shown ? behind.since + behind_after_ms : Infinity);
  /** When the shown machine fell behind, if it has; tracked whenever asked. */
  const behindSince = (now: number): number | null => {
    const shown = active!;
    if (shown.status === "online" && shown.fresh && !shown.error) behind = null;
    else if (behind?.endpoint !== shown) behind = { endpoint: shown, since: now, shown: false };
    return behind?.since ?? null;
  };
  // While the notice says the machine isn't online, input is dropped as it
  // comes: none of it reaches a pane, then or later.
  const drops = (now = Date.now()): boolean => {
    const since = behindSince(now);
    return since !== null && now >= since + behind_after_ms && active!.status !== "online";
  };
  const syncNotice = (now: number): SyncNotice | null => {
    const since = behindSince(now);
    if (since === null || now < since + behind_after_ms) return null;
    const shown = active!;
    behind!.shown = true;
    const status =
      shown.status === "online" ? shown.error || `Syncing… ${Math.floor((now - since) / 1000)}s` : shown.description();
    const hints = unreachable(shown)
      ? ["Ctrl+R retry", ...(shown.status === "paused" ? [] : ["Ctrl+X pause"]), ...(shown.error ? ["! details"] : [])]
      : [];
    if (!shown.reached) hints.push("Ctrl+C quit");
    return { status: `${shown.name}: ${status}`, keys: hints.join(" · ") };
  };
  active.folder = options.folder ?? null;
  endpoints[0].onboarding = options.onboarding ?? false;
  // Machines keep their place in the list, local first, whichever is shown.
  const view = new Controller(endpoints[0].machine, host);
  view.loadPreferences();
  view.input_state.attached = true;
  for (const endpoint of endpoints) {
    view.adopt(endpoint.machine);
    endpoint.controller = view;
  }
  view.switchMachine(active.machine);
  if (unreadable)
    view.notice(`Saved machines not loaded (${errors.name(unreadable) ?? "error"}); see corgi machine list`);
  let quit = false;
  let navigation_mouse = false;
  const size = viewer.dimensions();
  let side = sidebar.View.init(size.cols, size.rows, true, 0, 0, host.prefs.sidebar_split).withWidth(
    host.prefs.sidebar_width,
  );
  side.resources = host.prefs.resources;
  // The SSH config's other hosts show under the machines wherever they're listed.
  const adds = (view.machine_adds = new machineAdd.Adds());
  const workspaces = new Workspaces(endpoints, view, adds);
  const connectivity = new ConnectivityMenu(endpoints);
  const connection_hover = new connectivityCard.Hover();
  const diagnostic = new MachineNotice();
  view.onConnectivity = () => {
    connectivity.toggle(endpoints.indexOf(active!));
    wake.notify();
  };
  /** Selects locally; the endpoint brings its data up to date independently. */
  const choose = (endpoint: Endpoint, focus: Focus | null) => {
    connection_hover.clear();
    view.connection_card = null;
    // Unrouted keys follow the switch only up to a cancelled paste.
    const typed = endpoint === active ? [] : active!.takeInput();
    active!.deactivate();
    active = endpoint;
    // The notice was the last machine's.
    view.sync_notice = null;
    view.switchMachine(endpoint.machine);
    if (focus !== null) active.choose(focus, active.instance);
    else active.activate();
    for (const input of typed) active.enqueue(input, input.dropped || drops());
  };
  view.onMachine = (machine, focus) => {
    const endpoint = endpoints.find(e => e.machine === machine);
    if (endpoint) choose(endpoint, focus);
  };
  let differ: Differ | null = null;
  let previous: composition.Output = "";
  let paste_owner: { endpoint: Endpoint; epoch: number; dropped: boolean } | null = null;
  const openers = new Openers();
  const copies = new imageCopy.Copies();
  /** Opens a link in this computer's browser. One to another machine's own
   * loopback opens through a forward of its port. */
  const openLink = (url: string, from: Endpoint | null) => {
    // Over SSH itself, the viewer has no browser to open.
    if (sshViewer()) return;
    const forwards = from?.machine.forwards ?? null;
    // Another machine's localhost isn't this computer's: with no forward to it, it stays shut.
    const there = portForwards.target(url);
    if (from?.remote && !forwards && there) {
      view.notice(` No browser here to forward ${from.name}:${there.port} to`);
      return notify();
    }
    if (!forwards || !there) {
      try {
        openers.open(url);
      } catch {}
      return;
    }
    void forwards
      .open(url)
      .then(
        opened => {
          if (!opened) return;
          try {
            openers.open(opened);
          } catch (error) {
            view.notice(` Couldn't open the link: ${forwardError(error)}`);
          }
        },
        error => view.notice(` Couldn't forward from ${from!.name}: ${forwardError(error)}`),
      )
      .finally(notify);
  };
  /** The machine card's ports: the forwards of the machine it's for. */
  const cardPorts = (endpoint: Endpoint | null): connectivityCard.Port[] | null =>
    endpoint?.machine.forwards?.list.map(forward => ({
      forward,
      name: serverName(endpoint.machine.runtime.ports, forward.port),
    })) ?? null;
  const closeCard = () => {
    connection_hover.clear();
    view.connection_card = null;
  };
  /** The held machine card's buttons, by key or click, on its selected port. */
  const cardAct = (button: connectivityCard.Button) => {
    const endpoint = endpoints.find(e => e.name === connection_hover.machine),
      forward = connection_hover.selected;
    const forwards = endpoint?.machine.forwards;
    if (!forwards || !forward) return;
    if (button === "stop") {
      forwards.stop(forward);
      connection_hover.notice = `Stopped forwarding ${endpoint!.name}:${forward.port}`;
      return;
    }
    try {
      openers.open(forward.url);
      connection_hover.notice = `Opened ${forward.url}`;
    } catch (error) {
      connection_hover.notice = forwardError(error);
    }
  };
  /** The key `value`, decoded as `key` with control letters as `cp`, by the names `keys.ts` gives them. */
  const keyName = (value: string, key: keyboard.Key | null, cp: number | null): string | null => {
    const legacy = keys.parse(value);
    if (legacy) return legacy;
    for (const name of ["up", "down", "delete", "enter", "esc"])
      if (key?.codepoint === keys.logicalKey(name).codepoint) return name;
    return cp === 13 ? "enter" : cp === 27 ? "esc" : cp === 16 ? "up" : cp === 14 ? "down" : value === "x" ? "x" : null;
  };
  const cardKey = (name: string | null) => {
    switch (name) {
      case "esc":
        return closeCard();
      case "up":
      case "down":
        return connection_hover.step(name === "up" ? -1 : 1);
      case "enter":
        return cardAct("open");
      case "x":
      case "delete":
        return cardAct("stop");
    }
  };
  /** An image's path here: its own, or a copy of another computer's. */
  const imageHere = async ({ open_image: path, machine }: Extract<Effect, { open_image: string }>) => {
    if (machine === undefined) return path;
    const from = endpoints.find(e => e.machine.id === machine);
    if (!from) throw Error("UnknownMachine");
    return copies.fetch(view.filesOn(from.machine).files, path);
  };
  const openDesktop = (effect: Exclude<Effect, { write_terminal: string }>) => {
    if ("open_url" in effect) {
      openLink(effect.open_url, endpoints.find(e => e.machine.id === effect.machine) ?? null);
      return;
    }
    const failed = (error: unknown) => {
      const name = basename(effect.open_image),
        reason = errors.name(error) ?? i18n.t`unknown error`;
      view.notice(i18n.t` Couldn't open ${name}: ${reason}`);
      notify();
    };
    if (host.opens_desktop)
      void imageHere(effect)
        .then(path => openers.openImage(path))
        // A copy that finishes after the viewer has gone opens nothing.
        .catch(error => errors.is(error, "Closed") || failed(error));
    else failed(Error("NoDesktop"));
  };
  /** Opens desktop effects without waiting for the shown machine's turn. */
  const openDesktopEffects = () => {
    const effects = view.effects;
    view.clearEffects();
    for (const effect of effects) {
      if ("write_terminal" in effect) view.effects.push(effect);
      else openDesktop(effect);
    }
  };
  const clipboard: { owner: { endpoint: Endpoint; generation: number; epoch: number } | null } = {
    owner: null,
  };
  const show = () => {
    workspaces.show();
    if (workspaces.open) active!.deactivate();
  };
  const close = () => {
    workspaces.hide();
    active!.activate();
  };
  const filter = () => {
    if (workspaces.selectFilter()) active!.activate();
  };
  // With no SSH machine there's no dropdown: the controller says how to add one.
  view.onMachines = workspaces.visible ? show : null;
  // Something to draw: input, a machine's news, or a task that finished.
  let changed = true;
  const notify = () => {
    changed = true;
    wake.notify();
  };
  view.wake = notify;
  /** Hooks a machine's connection to this viewer's screen, links and clipboard. */
  const wire = (endpoint: Endpoint) => {
    endpoint.onChange = notify;
    const forwards = endpoint.machine.forwards;
    if (forwards) {
      forwards.onChange = notify;
      // A Cmd+click reaches only the forward, by the request it brings.
      forwards.onRealized = forward =>
        view.notice(` Forwarded ${endpoint.name}:${forward.port} to localhost:${forward.local}`);
    }
    endpoint.onEffects = view => {
      for (const effect of view.effects) {
        if ("write_terminal" in effect) {
          viewer.writeAll(effect.write_terminal);
          // Graphics commands move the host's images under the differ: draw it all again.
          if (effect.write_terminal.includes("\x1b_G")) {
            differ?.invalidateImages();
            previous = "";
            view.dirty = true;
            notify();
          }
        } else openDesktop(effect);
      }
      view.clearEffects();
    };
    endpoint.onClipboard = async view => {
      if (!clipboard.owner && endpoint === active && !workspaces.open && endpoint.ready) {
        const listing = probe.clipboard.takeEvent();
        if (listing !== null) {
          clipboard.owner = { endpoint, generation: endpoint.generation, epoch: endpoint.input_epoch };
          await view.pasteEvent(listing);
          if (!probe.clipboard.reading) clipboard.owner = null;
        }
      }
      if (
        clipboard.owner?.endpoint === endpoint &&
        clipboard.owner.generation === endpoint.generation &&
        clipboard.owner.epoch === endpoint.input_epoch
      ) {
        const result = probe.clipboard.takeResult();
        if (result) {
          // The upload runs as one of the view's tasks, which reports its
          // failure. Ownership lasts until it's done, unless a disconnect or
          // selection cancels it first.
          const owner = clipboard.owner;
          void view.pasteResult(result).finally(() => {
            if (clipboard.owner === owner) clipboard.owner = null;
            wake.notify();
          });
        }
      }
      const output = probe.clipboard.takeOutput();
      if (output) viewer.writeAll(output);
    };
  };
  for (const endpoint of endpoints) wire(endpoint);
  // An added machine joins the others; the lists' highlights keep to their rows.
  adds.changed = notify;
  adds.added = profile => {
    const endpoint = sshEndpoint(profile, probe, host);
    endpoints.push(endpoint);
    view.adopt(endpoint.machine);
    endpoint.controller = view;
    wire(endpoint);
    view.dirty = true;
  };
  const accept = (input: Input) => {
    const value = Buffer.from(input.bytes).toString();
    const key = input.kind === "key" ? input.key : null;
    const mouse = input.kind === "mouse" ? input.mouse : null;
    const paste = terminalInput.pasting(input);
    const codepoint = key?.codepoint ?? (input.bytes.length === 1 ? input.bytes[0] : null);
    const cp = key?.mods.ctrl && codepoint !== null && codepoint >= 64 && codepoint < 128 ? codepoint & 31 : codepoint;
    if (paste) {
      // A host pasted into the machine dropdown's search, unless a card covers it.
      if (workspaces.open && !paste_owner) {
        if (input.kind === "paste" && !diagnostic.open && !connectivity.open)
          workspaces.list.type(Buffer.from(input.bytes).toString());
        return;
      }
      if (input.kind === "paste_start")
        paste_owner =
          !workspaces.open && !diagnostic.open && !connectivity.open
            ? { endpoint: active!, epoch: active!.input_epoch, dropped: drops() }
            : null;
      if (paste_owner) {
        if (paste_owner.endpoint === active && paste_owner.epoch === active!.input_epoch)
          active!.enqueue(input, paste_owner.dropped);
        else {
          view.cancelPaste();
          paste_owner = null;
        }
      }
      if (input.kind === "paste_end") paste_owner = null;
      return;
    }
    if (diagnostic.open) {
      if (mouse) {
        if (!mouse.release && (mouse.button === 64 || mouse.button === 65))
          diagnostic.scroll(mouse.button === 64 ? -3 : 3);
        else if (!mouse.release && mouse.button === 0) diagnostic.close();
      } else diagnostic.key(value, cp);
      return;
    }
    // The machine card, held open, takes the keyboard and its own presses;
    // a press elsewhere lets it go, and goes on.
    const card = connection_hover.card,
      name = mouse ? null : keyName(value, key, cp);
    // A focus report is the terminal's, not a key: the view takes it.
    const focus = name === "focus_in" || name === "focus_out";
    if (connection_hover.pinned && card && card.shown !== false && !focus) {
      if (!mouse) {
        cardKey(name);
        return;
      }
      const { x, y, button } = mouse,
        pressed = !mouse.release;
      if (card.rect.contains(x, y)) {
        const forward = connectivityCard.portAt(card, x, y);
        if (button === 35 && forward) {
          if (forward !== connection_hover.selected) connection_hover.notice = "";
          connection_hover.selected = forward;
        } else if (pressed && (button === 64 || button === 65)) connection_hover.step(button === 64 ? -1 : 1);
        else if (pressed && button === 0) {
          const act = connectivityCard.buttonAt(card, x, y);
          if (act) cardAct(act);
          else if (forward) connection_hover.pin(forward);
          navigation_mouse = true;
        } else if (!pressed) navigation_mouse = false;
        view.pointer = { x, y };
        view.link_tooltip.cancel();
        return;
      }
      if (pressed && (button === 0 || button === 2)) closeCard();
    } else if (!mouse && card?.shown && card.ports?.list.length) {
      // An arrow or Enter over the card holds it; with a port hovered, the key acts on it too.
      if (name === "up" || name === "down" || name === "enter") {
        const hovered = connection_hover.chosen();
        connection_hover.pin();
        if (hovered) cardKey(name);
        return;
      }
    }
    const hover_mouse = mouse;
    if (
      hover_mouse &&
      !connection_hover.pinned &&
      !workspaces.open &&
      !connectivity.open &&
      !view.overlayOpen() &&
      !view.copy_mode
    ) {
      const x = hover_mouse.x,
        y = hover_mouse.y;
      const header = sidebar.machineHeaderAt(side, x, y);
      if (header && hover_mouse.button === 0 && !hover_mouse.release) {
        const endpoint = endpoints.find(e => e.name === header.machine);
        if (endpoint) {
          if (sidebar.machineDiagnosticAt(side, view.workspaceRows(), x, y)) diagnostic.show(endpoint);
          else view.toggleMachine(endpoint.machine);
          connection_hover.clear();
          view.connection_card = null;
          navigation_mouse = true;
          return;
        }
      }
      // A card an overlay hides takes no presses either.
      const inside = (connection_hover.card?.shown !== false && connection_hover.card?.rect.contains(x, y)) ?? false;
      if (inside && hover_mouse.button === 0 && !hover_mouse.release) {
        // A click on a port holds the card open with it selected.
        const forward = connectivityCard.portAt(connection_hover.card!, x, y);
        if (forward) connection_hover.pin(forward);
        navigation_mouse = true;
        return;
      }
      if (hover_mouse.button === 35 && !hover_mouse.release && !view.ui_mouse_down) {
        const header = sidebar.machineHeaderAt(side, x, y);
        connection_hover.move(header, x, y, performance.now());
        if (header || inside) {
          view.pointer = { x, y };
          view.link_tooltip.cancel();
          return;
        }
      } else {
        // The release of a press on the card leaves it.
        if (!inside || !hover_mouse.release) {
          connection_hover.clear();
          view.connection_card = null;
        }
        if (inside) {
          if (hover_mouse.release) navigation_mouse = false;
          return;
        }
      }
    } else if (!connection_hover.pinned) {
      connection_hover.clear();
      view.connection_card = null;
    }
    if (connectivity.open) {
      if (mouse) connectivity.mouse(mouse.x, mouse.y, mouse.button, !mouse.release);
      else connectivity.key(value, cp);
      return;
    }
    if (cp === 27 && view.cancelWorkspaceDrag()) return;
    // Ahead of the machine's own keys, so a machine that never answered can't hold it.
    if (endpoints.length > 1 && (value === "\x1d" || (key?.codepoint === 93 && key.mods.ctrl))) {
      if (workspaces.open) close();
      else show();
      return;
    }
    if (mouse) {
      const button = mouse.button,
        x = mouse.x,
        y = mouse.y;
      const pressed = !mouse.release;
      if (navigation_mouse) {
        if (!pressed) navigation_mouse = false;
        return;
      }
      if (workspaces.open) {
        if (pressed) {
          if (button === 64 || button === 65) workspaces.move(button === 64 ? -1 : 1);
          else if (button === 0 || button === 32 || button === 35) {
            const index = workspaces.hit(side, x, y);
            if (typeof index === "number") workspaces.cursor = index;
            if (button === 0) {
              if (typeof index === "number") filter();
              else if (index === null) close();
              navigation_mouse = true;
            }
          }
        }
        return;
      }
      if (!workspaces.open && view.workspaceDragInput(x, y, button, !pressed)) return;
    }
    if (workspaces.open) {
      if (value === "!") {
        const endpoint = workspaces.endpoint();
        if (endpoint) diagnostic.show(endpoint);
        return;
      }
      switch (cp) {
        // A search goes first, then the dropdown.
        case 27:
          if (!workspaces.list.leave()) close();
          return;
        // As in a pane: it leaves only before anything has come up.
        case 3:
          if (active!.reached) close();
          else quit = true;
          return;
        case 13:
          filter();
          return;
        case 57352:
        case 16:
          workspaces.move(-1);
          return;
        case 57353:
        case 14:
          workspaces.move(1);
          return;
        case 6:
          workspaces.collapse();
          return;
        case 18:
          workspaces.retry();
          return;
        case 24:
          workspaces.pause();
          return;
      }
      // Typing searches; ⌫, ^U and ^W edit it.
      if (cp === 8 || cp === 21 || cp === 23 || cp === 127) workspaces.list.key(cp);
      else if (!key?.mods.ctrl && !key?.mods.alt && codepoint !== null && codepoint >= 32 && codepoint < 127)
        workspaces.list.key(codepoint);
      // Typing can come several characters at a time.
      else if (input.kind === "text") workspaces.list.type(value);
      return;
    }
    // With nothing on screen yet, Ctrl+C leaves; after that it's the agent's.
    if (cp === 3 && !active!.reached) {
      quit = true;
      return;
    }
    // The notice's keys are Corgi's only while keys can't reach a pane at all.
    if (behind?.shown && behind.endpoint === active && !mouse && unreachable(active!)) {
      if (value === "!" && diagnostic.show(active!)) return;
      if (cp === 18) {
        active!.retry();
        return;
      }
      if (cp === 24) {
        active!.pause();
        return;
      }
    }
    active!.enqueue(input, drops());
  };
  const route = (input: Input, now = Date.now()) => {
    const waiting = probe.clipboard.event.phase === "ready";
    if (!probe.accept(input, now)) accept(input);
    if (!waiting && probe.clipboard.event.phase === "ready" && drops(now)) probe.clipboard.takeEvent();
  };
  const feed = (bytes: Uint8Array) => {
    for (const input of parser.feed(bytes)) route(input);
    notify();
  };
  probe.clipboard.folder = join(dirname(local), "paste");
  probe.clipboard.start(Date.now());
  // The badge's picture is made in the background; it wakes the loop to upload it.
  probe.badge = new corgiBadge.State(notify);
  viewer.writeAll(corgiBadge.query);
  for (const input of initial) accept(input);
  stdin.listen(feed);
  const probed_at = Date.now();
  viewer.writeAll(probe.size.update(size.pty) + probe.measure(size.rows, probed_at));
  let resized = false;
  const onResize = () => {
    resized = true;
    notify();
  };
  process.on("SIGWINCH", onResize);
  const terminal_sent = new Map<Endpoint, number>();
  // The loop wakes every frame; a far longer gap means the computer slept.
  let ticked = Date.now();
  let active_at = Date.now();
  let scroll_saved = 0;
  let next_draw = 0;
  // A frame the host wasn't ready for, drawn once it is.
  let held = false;
  try {
    while (!quit && !stdin.ended) {
      const now = Date.now();
      connectivity.tick();
      if (now - scroll_saved >= scroll_save_ms) {
        view.saveAgentScroll();
        scroll_saved = now;
      }
      if (now - ticked > slept_ms) for (const endpoint of endpoints) endpoint.woke();
      ticked = now;
      probe.clipboard.tick(now);
      if (
        clipboard.owner &&
        (clipboard.owner.generation !== clipboard.owner.endpoint.generation ||
          clipboard.owner.epoch !== clipboard.owner.endpoint.input_epoch)
      ) {
        if (probe.clipboard.takeResult() || !probe.clipboard.reading) {
          clipboard.owner = null;
          view.pasteDropped();
        }
      }
      probe.tick(now);
      for (const input of parser.expire()) route(input, now);
      openers.reap();
      if (probe.scheme_changed) {
        probe.scheme_changed = false;
        viewer.writeAll(hostBackground.release() + probe.query());
      }
      for (const reply of probe.graphics.splice(0)) {
        // An error about one of the host's pictures has it sent again.
        const refused = /^\x1b_G(?:[^;]*,)?i=(\d+)[^;]*;(?!OK)/.exec(reply);
        if (refused && host.images.refused(Number(refused[1]))) view.dirty = true;
        else view.graphicsReply(reply);
      }
      const { cols, rows: height, pty } = viewer.dimensions();
      const query = probe.size.update(pty, resized);
      resized = false;
      if (query) viewer.writeAll(query);
      const cell = probe.size.pixels(pty);
      const graphics = probe.badge.supports_kitty_graphics && cell !== null;
      const images = probe.badge.upload(now, graphics ? cell : null);
      if (images) viewer.writeAll(images);
      if (host.cell_pixels?.width !== cell?.width || host.cell_pixels?.height !== cell?.height) view.dirty = true;
      if (
        active.ready &&
        terminal_sent.get(active) !== active.generation &&
        probe.info.status === "done" &&
        (probe.badge.mode() === "image" || now - probed_at > 3000)
      ) {
        terminal_sent.set(active, active.generation);
        void viewer.publishTerminal(view, view.connection, probe).catch(() => {});
      }
      const recolored = probe.changed;
      if (recolored) {
        probe.changed = false;
        host.recolor(probe);
        for (const endpoint of endpoints) endpoint.theme(probe.theme);
      }
      if (host.observe(probe, cell) || recolored) view.dirty = true;
      workspaces.watchResources();
      const idle = now - active_at >= idle_after_ms;
      for (const endpoint of endpoints) endpoint.pump(endpoint === active, idle);
      if (view.effects.some(effect => !("write_terminal" in effect))) openDesktopEffects();
      if (endpoints[0].fatal) throw endpoints[0].fatal;
      if (endpoints[0].uninstalled) break;
      // This computer's daemon going away ends the viewer, whichever machine is shown.
      if (active.detached || endpoints[0].detached || !view.input_state.attached) break;
      // Idle with nothing new, the screen is as it was; it's drawn now and
      // then for its clocks, and when an animation on it takes its next step.
      if (
        changed ||
        !idle ||
        view.dirty ||
        workspaces.open ||
        connectivity.open ||
        held ||
        Date.now() >= next_draw ||
        Date.now() >= view.nextFrame() ||
        Date.now() >= noticeDue() ||
        performance.now() >= connection_hover.due()
      ) {
        changed = false;
        next_draw = Date.now() + quiet_ms;
        let frame: composition.Output;
        view.hide_connection_signals = workspaces.open || connectivity.open;
        view.width = cols;
        view.height = height;
        side = view.sidebarView([]);
        if (workspaces.open || connectivity.open || view.overlayOpen() || view.copy_mode || view.ui_mouse_down)
          connection_hover.clear();
        if (connection_hover.expire(performance.now())) view.connection_card = null;
        if (connection_hover.machine && view.pointer)
          connection_hover.move(
            sidebar.machineHeaderAt(side, view.pointer.x, view.pointer.y),
            view.pointer.x,
            view.pointer.y,
            performance.now(),
          );
        const card_endpoint = endpoints.find(endpoint => endpoint.name === connection_hover.machine) ?? null;
        view.connection_card = connection_hover.update(
          card_endpoint,
          cols,
          height,
          performance.now(),
          cardPorts(card_endpoint),
        );
        view.sync_notice = syncNotice(Date.now());
        frame = active.render();
        if (workspaces.open) frame = (typeof frame === "string" ? frame : frame.text()) + workspaces.draw(side);
        // A card hides the pictures under it, the dropdown's reception too.
        if (connectivity.open) {
          frame = (typeof frame === "string" ? frame : frame.text()) + connectivity.draw(cols, height);
          view.framePictures()?.coverAll(connectivity.box);
        }
        if (diagnostic.open) {
          frame = (typeof frame === "string" ? frame : frame.text()) + diagnostic.draw(cols, height);
          if (diagnostic.box) view.framePictures()?.coverAll(diagnostic.box);
        }
        // A card over the dropdown has the keys, and no cursor shows.
        if (workspaces.open && (connectivity.open || diagnostic.open))
          frame = (typeof frame === "string" ? frame : frame.text()) + "\x1b[?25l";
        // Unreachable, the screen changes only with the notice's countdown:
        // that's no reason to draw at full rate.
        const moved = !composition.same(frame, previous) && active.status === "online";
        if (view.dirty || moved || view.overlayOpen() || workspaces.open) active_at = Date.now();
        view.dirty = false;
        if (viewer.ready(probe)) {
          // A painted theme colors the terminal's margins too.
          const backdrop = hostBackground.follow(palette.painted());
          if (backdrop) viewer.writeAll(backdrop);
        }
        if ((!composition.same(frame, previous) || host.images.changed) && viewer.ready(probe)) {
          // Images the frame shows go ahead of it, and those it dropped are
          // freed after; where they sit changes with the frame's text.
          const pictures = host.images.present();
          if (pictures.send) viewer.writeAll(pictures.send);
          differ = viewer.present(differ, frame, cols, height, probe.pacer, pictures);
          if (pictures.free) viewer.writeAll(pictures.free);
          previous = frame;
        }
        if (!workspaces.open && !connectivity.open && composition.same(frame, previous)) active.presented();
        held = !composition.same(frame, previous) || host.images.changed;
      }
      // Idle, it sleeps until a machine is due; input and replies wake it.
      const due = Math.min(parser.due(), ...endpoints.map(endpoint => endpoint.due())) - performance.now();
      await wake.wait(
        now - active_at < idle_after_ms
          ? Math.max(1, Math.min(16, due))
          : Math.max(
              1,
              Math.min(
                quiet_ms,
                due,
                connection_hover.due() - performance.now(),
                noticeDue() - Date.now(),
                view.nextFrame() - Date.now(),
              ),
            ),
      );
    }
    if (endpoints[0].uninstalled) {
      if (probe.badge.uploaded) viewer.writeAll(corgiBadge.remove);
      viewer.writeAll(host.images.close());
      const { cols, rows } = viewer.dimensions();
      await farewell(cols, rows);
      throw Error("Uninstalled");
    }
    return active.relaunch;
  } finally {
    process.off("SIGWINCH", onResize);
    copies.close();
    view.saveAgentScroll();
    // The last frame's answer would otherwise reach the shell as typing.
    const until = Date.now() + framePacing.settle_ms;
    while (probe.pacer.unanswered() && !stdin.ended && Date.now() < until) await wake.wait(until - Date.now());
    stdin.close();
    adds.close();
    await Promise.all(endpoints.map(endpoint => endpoint.close()));
    viewer.writeAll(host.images.close());
    viewer.close(view);
    differ?.destroy();
    if (probe.badge.uploaded) viewer.writeAll(corgiBadge.remove);
  }
}
/** What serves `port` on the machine, as its port tracker names it. */
function serverName(
  snapshot: { workspaces?: { endpoints?: { port: number; label?: string; name?: string }[] }[] },
  port: number,
): string {
  for (const work of snapshot.workspaces ?? [])
    for (const endpoint of work.endpoints ?? [])
      if (endpoint.port === port) return endpoint.label || endpoint.name || "";
  return "";
}
function forwardError(error: unknown): string {
  switch (errors.name(error)) {
    case "TooManyOpenRequests":
      return "too many links opening";
    default:
      return (error as Error).message || "error";
  }
}
/** Whether `endpoint`'s daemon can't be reached at all, as opposed to being
 * behind or coming back after a reload: keys can't reach its panes then. */
export function unreachable(endpoint: Pick<Endpoint, "status" | "failing">): boolean {
  switch (endpoint.status) {
    case "offline":
    case "paused":
    case "attention":
    case "incompatible":
      return true;
    case "connecting":
      // Trying again after failing, it still can't be reached.
      return endpoint.failing;
    default:
      return false;
  }
}
/** The corgi walking off to The Farm once the installation it ran from is gone. */
async function farewell(width: number, height: number): Promise<void> {
  const scene = new corgiAnimation.Farewell(width, height);
  viewer.writeAll("\x1b[0m\x1b[2J\x1b[?25l");
  for (let step = 0; step < scene.ticks; step++) {
    viewer.writeAll(
      scene
        .rows(step)
        .map((row, i) => `\x1b[${scene.top + i};1H${row}`)
        .join("") + "\x1b[0m",
    );
    await Bun.sleep(corgiAnimation.farewell_tick_ms);
  }
}
