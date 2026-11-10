import { Notice as MachineNotice } from "./machine_diagnostics";
import { Menu as ConnectivityMenu } from "./connectivity_menu";
import { Hover as ConnectionHover } from "./connectivity_card";
import * as composition from "./composition";
import { dirname, join } from "node:path";
import { Endpoint, localEndpoint, quiet_ms } from "./machine_connection";
import { Parser, type Input } from "./machine_input";
import * as machines from "./machines";
import * as errors from "./errors";
import { sshEndpoint } from "./ssh_path";
import * as sidebar from "./sidebar";
import { Workspaces } from "./machine_sidebar";
import * as viewer from "./viewer";
import * as keyboard from "./keyboard";
import * as corgiBadge from "./corgi_badge";
import * as rowGlide from "./row_glide";
import * as linkThumbnail from "./link_thumbnail";
import * as hostBackground from "./host_background";
import * as palette from "./palette";
import * as framePacing from "./frame_pacing";
import * as preferences from "./preferences";
import * as discovery from "./discovery";
import * as dockingGrip from "./docking_grip";
import * as corgiAnimation from "./corgi_animation";
import { attach } from "./host";
import { Openers } from "./url_opener";
import { Wake } from "./wake";
import type { Probe } from "./terminal_info";
import type { Differ } from "./frame_diff";
import { Controller } from "./controller";
import type { Focus } from "./machine";
import type { State as SyncNotice } from "./sync_notice";

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
  initial: number[],
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
  const syncNotice = (now: number): SyncNotice | null => {
    const shown = active!;
    if (shown.status === "online" && shown.fresh && !shown.error) {
      behind = null;
      return null;
    }
    if (behind?.endpoint !== shown) behind = { endpoint: shown, since: now, shown: false };
    if (now < behind.since + behind_after_ms) return null;
    behind.shown = true;
    const keys = shown.waiting();
    const status =
      shown.status === "online"
        ? shown.error || `Syncing… ${Math.floor((now - behind.since) / 1000)}s`
        : shown.description();
    const hints = unreachable(shown)
      ? ["Ctrl+R retry", ...(shown.status === "paused" ? [] : ["Ctrl+X pause"]), ...(shown.error ? ["! details"] : [])]
      : [];
    if (!shown.reached) hints.push("Ctrl+C quit");
    return {
      status: `${shown.name}: ${status}${keys ? ` · ${keys} ${keys === 1 ? "key" : "keys"} waiting` : ""}`,
      keys: hints.join(" · "),
    };
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
  const workspaces = new Workspaces(endpoints, view);
  const connectivity = new ConnectivityMenu(endpoints);
  const connection_hover = new ConnectionHover();
  const diagnostic = new MachineNotice();
  view.onConnectivity = () => {
    connectivity.toggle(endpoints.indexOf(active!));
    wake.notify();
  };
  /** Selects locally; the endpoint brings its data up to date independently. */
  const choose = (endpoint: Endpoint, focus: Focus | null) => {
    connection_hover.clear();
    view.connection_card = null;
    // Keys not yet routed came after the switch; they follow it.
    const typed = endpoint === active ? new Uint8Array() : active!.takeInput();
    active!.deactivate();
    active = endpoint;
    view.switchMachine(endpoint.machine);
    if (focus !== null) active.choose(focus, active.instance);
    else active.activate();
    if (typed.length) active.enqueue(typed);
  };
  view.onMachine = (machine, focus) => {
    const endpoint = endpoints.find(e => e.machine === machine);
    if (endpoint) choose(endpoint, focus);
  };
  let differ: Differ | null = null;
  let previous: composition.Output = "";
  const parser = new Parser();
  let paste_owner: { endpoint: Endpoint; epoch: number } | null = null;
  const openers = new Openers();
  const clipboard: { owner: { endpoint: Endpoint; generation: number; epoch: number } | null } = {
    owner: null,
  };
  const show = () => {
    workspaces.show();
    if (workspaces.open) active!.deactivate();
  };
  const close = () => {
    workspaces.open = false;
    active!.activate();
  };
  const filter = () => {
    workspaces.selectFilter();
    active!.activate();
  };
  view.onMachines = show;
  // Something to draw: input, a machine's news, or a task that finished.
  let changed = true;
  const notify = () => {
    changed = true;
    wake.notify();
  };
  view.wake = notify;
  for (const endpoint of endpoints) {
    endpoint.onChange = notify;
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
        } else if (!view.remote_links) {
          try {
            openers.open(effect.open_url);
          } catch {}
        }
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
  }
  const accept = (input: Input) => {
    const value = Buffer.from(input.bytes).toString();
    const key = keyboard.decode(value);
    const codepoint = key?.codepoint ?? (input.bytes.length === 1 ? input.bytes[0] : null);
    const cp = key?.mods.ctrl && codepoint !== null && codepoint >= 64 && codepoint < 128 ? codepoint & 31 : codepoint;
    if (diagnostic.open) {
      if (!input.paste) {
        const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(value);
        if (mouse) {
          if (mouse[4] === "M" && (mouse[1] === "64" || mouse[1] === "65"))
            diagnostic.scroll(mouse[1] === "64" ? -3 : 3);
          else if (mouse[4] === "M" && mouse[1] === "0") diagnostic.close();
        } else diagnostic.key(value, cp);
      }
      return;
    }
    const hover_mouse = !input.paste && /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(value);
    if (hover_mouse && !workspaces.open && !connectivity.open && !view.overlayOpen() && !view.copy_mode) {
      const x = Number(hover_mouse[2]) - 1,
        y = Number(hover_mouse[3]) - 1;
      const header = sidebar.machineHeaderAt(side, x, y);
      if (header && hover_mouse[1] === "0" && hover_mouse[4] === "M") {
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
      const inside = connection_hover.card?.rect.contains(x, y) ?? false;
      if (hover_mouse[1] === "35" && hover_mouse[4] === "M" && !view.ui_mouse_down) {
        const header = sidebar.machineHeaderAt(side, x, y);
        connection_hover.move(header, x, y, performance.now());
        if (header || inside) {
          view.pointer = { x, y };
          view.link_tooltip.cancel();
          return;
        }
      } else {
        connection_hover.clear();
        view.connection_card = null;
        if (inside) return;
      }
    } else {
      connection_hover.clear();
      view.connection_card = null;
    }
    if (connectivity.open) {
      if (!input.paste) {
        const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(value);
        if (mouse) connectivity.mouse(Number(mouse[2]) - 1, Number(mouse[3]) - 1, Number(mouse[1]), mouse[4] === "M");
        else connectivity.key(value, cp);
      }
      return;
    }
    if (!input.paste && cp === 27 && view.cancelWorkspaceDrag()) return;
    if (input.paste) {
      if (value === "\x1b[200~")
        paste_owner = !workspaces.open ? { endpoint: active!, epoch: active!.input_epoch } : null;
      if (
        paste_owner &&
        paste_owner.endpoint === active &&
        paste_owner.epoch === active!.input_epoch &&
        !workspaces.open
      )
        active!.enqueue(input.bytes);
      else paste_owner = null;
      if (value === "\x1b[201~") paste_owner = null;
      return;
    }
    // Ahead of the machine's own keys, so a machine that never answered can't hold it.
    if (endpoints.length > 1 && (value === "\x1d" || (key?.codepoint === 93 && key.mods.ctrl))) {
      if (workspaces.open) close();
      else show();
      return;
    }
    const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(value);
    if (mouse) {
      const button = Number(mouse[1]),
        x = Number(mouse[2]) - 1,
        y = Number(mouse[3]) - 1;
      const pressed = mouse[4] === "M";
      if (navigation_mouse) {
        if (!pressed) navigation_mouse = false;
        return;
      }
      if (workspaces.open) {
        if (pressed) {
          if (button === 64 || button === 65) workspaces.move(button === 64 ? -1 : 1);
          else if (button === 0 || button === 32 || button === 35) {
            const index = workspaces.hit(side, x, y);
            if (index !== null) workspaces.cursor = index;
            if (button === 0) {
              if (index !== null) filter();
              else close();
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
        const endpoint = endpoints[workspaces.cursor - 1];
        if (endpoint) diagnostic.show(endpoint);
        return;
      }
      switch (cp) {
        case 27:
          close();
          return;
        case 3:
          quit = true;
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
      if (!key?.mods.ctrl && !key?.mods.alt && codepoint !== null && codepoint >= 32 && codepoint < 127) {
        const index = endpoints.findIndex(endpoint =>
          endpoint.name.toLowerCase().startsWith(String.fromCodePoint(codepoint).toLowerCase()),
        );
        if (index >= 0) workspaces.cursor = index + 1;
        else if (codepoint === 97) workspaces.cursor = 0;
      }
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
    active!.enqueue(input.bytes);
  };
  const feed = (bytes: Uint8Array) => {
    for (const input of parser.feed(probe.feed(bytes))) accept(input);
    notify();
  };
  probe.clipboard.folder = join(dirname(local), "paste");
  probe.clipboard.start(Date.now());
  // The badge's picture is made in the background; it wakes the loop to upload it.
  probe.badge = new corgiBadge.State(notify);
  viewer.writeAll(corgiBadge.query);
  for (const input of parser.feed(Uint8Array.from(initial))) accept(input);
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
        if (probe.clipboard.takeResult() || !probe.clipboard.reading) clipboard.owner = null;
      }
      for (const input of parser.feed(probe.expire(now))) accept(input);
      for (const input of parser.expire(now)) accept(input);
      openers.reap();
      if (probe.scheme_changed) {
        probe.scheme_changed = false;
        viewer.writeAll(hostBackground.release() + probe.query());
      }
      for (const reply of probe.graphics.splice(0)) view.graphicsReply(reply);
      const { cols, rows: height, pty } = viewer.dimensions();
      const query = probe.size.update(pty, resized);
      resized = false;
      if (query) viewer.writeAll(query);
      const cell = probe.size.pixels(pty);
      const graphics = probe.badge.supports_kitty_graphics && cell !== null;
      const images = probe.badge.upload(now, graphics ? cell : null);
      if (images) viewer.writeAll(images);
      if (host.supports_kitty_graphics && !graphics) viewer.writeAll(rowGlide.hide + linkThumbnail.hide);
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
      if (endpoints[0].fatal) throw endpoints[0].fatal;
      if (endpoints[0].uninstalled) break;
      // This computer's daemon going away ends the viewer, whichever machine is shown.
      if (active.detached || endpoints[0].detached || !view.input_state.attached) break;
      // Idle with nothing new, the screen is as it was; it's drawn only now
      // and then, for what changes with time alone.
      if (
        changed ||
        !idle ||
        view.dirty ||
        workspaces.open ||
        connectivity.open ||
        held ||
        Date.now() >= next_draw ||
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
        if (connection_hover.machine && view.pointer)
          connection_hover.move(
            sidebar.machineHeaderAt(side, view.pointer.x, view.pointer.y),
            view.pointer.x,
            view.pointer.y,
            performance.now(),
          );
        view.connection_card = connection_hover.update(
          endpoints.find(endpoint => endpoint.name === connection_hover.machine) ?? null,
          cols,
          height,
          performance.now(),
        );
        view.sync_notice = syncNotice(Date.now());
        frame = active.render();
        if (workspaces.open) frame = (typeof frame === "string" ? frame : frame.text()) + workspaces.draw(side);
        if (connectivity.open)
          frame = (typeof frame === "string" ? frame : frame.text()) + connectivity.draw(cols, height);
        if (diagnostic.open) frame = (typeof frame === "string" ? frame : frame.text()) + diagnostic.draw(cols, height);
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
        if (!composition.same(frame, previous) && viewer.ready(probe)) {
          differ = viewer.present(differ, frame, cols, height, probe.pacer);
          previous = frame;
        }
        if (!workspaces.open && !connectivity.open && composition.same(frame, previous)) active.presented();
        held = !composition.same(frame, previous);
      }
      // Idle, it sleeps until a machine is due; input and replies wake it.
      const due = Math.min(...endpoints.map(endpoint => endpoint.due())) - performance.now();
      await wake.wait(
        now - active_at < idle_after_ms
          ? 16
          : Math.max(1, Math.min(quiet_ms, due, connection_hover.due() - performance.now(), noticeDue() - Date.now())),
      );
    }
    if (endpoints[0].uninstalled) {
      if (probe.badge.uploaded) viewer.writeAll(corgiBadge.remove);
      viewer.writeAll(view.images.clear() + view.tab_icons.clear());
      const { cols, rows } = viewer.dimensions();
      await farewell(cols, rows);
      throw Error("Uninstalled");
    }
    return active.relaunch;
  } finally {
    process.off("SIGWINCH", onResize);
    view.saveAgentScroll();
    // The last frame's answer would otherwise reach the shell as typing.
    const until = Date.now() + framePacing.settle_ms;
    while (probe.pacer.unanswered() && !stdin.ended && Date.now() < until) await wake.wait(until - Date.now());
    stdin.close();
    await Promise.all(endpoints.map(endpoint => endpoint.close()));
    viewer.writeAll(view.images.clear() + view.tab_icons.clear() + view.signal_bars.clear());
    viewer.close(view);
    differ?.destroy();
    if (probe.badge.uploaded) viewer.writeAll(corgiBadge.remove);
    if (view.thumbnails.sent !== null) viewer.writeAll(linkThumbnail.remove);
    if (host.supports_kitty_graphics) viewer.writeAll(dockingGrip.clear);
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
