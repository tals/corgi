import * as composition from "./composition";
import { dirname, join } from "node:path";
import { Endpoint, quiet_ms } from "./machine_connection";
import { Parser, type Input } from "./machine_input";
import * as machines from "./machines";
import * as sidebar from "./sidebar";
import * as render from "./render";
import { Workspaces } from "./machine_sidebar";
import * as viewer from "./viewer";
import * as keyboard from "./keyboard";
import * as palette from "./palette";
import * as text from "./text";
import * as corgiBadge from "./corgi_badge";
import * as rowGlide from "./row_glide";
import * as linkThumbnail from "./link_thumbnail";
import * as hostBackground from "./host_background";
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

/** A gap between frames this long means the computer slept. */
const slept_ms = 5000;
/** With no input or change on screen this long, the viewer idles. */
const idle_after_ms = 1000;
const scroll_save_ms = 1000;
/** How long the first frame waits for the machine's screen before the
 * sidebar shows alone. */
const first_frame_ms = 1000;
export interface Options {
  folder?: string | null;
  /** Starts the local daemon, when the viewer opens on another machine. */
  start_local?: () => Promise<void>;
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
  const endpoints = [
    new Endpoint(null, local, probe, host, options.start_local),
    ...(options.machines === false ? [] : machines.read()).map(profile => new Endpoint(profile, local, probe, host)),
  ];
  let active = endpoints.find(e => e.name === selected);
  if (!active) throw Error("UnknownMachine");
  // Typing before the first screen goes to the machine the viewer opens on,
  // once that screen is up, as typing ahead into a shell does. Typing
  // after a stall or a switch never does.
  const first = active;
  let early: number[] | null = [];
  const typeahead = () => {
    if (early && active === first && first.ready) first.enqueue(Uint8Array.from(early));
    if (!early || active !== first || first.ready || first.status === "offline" || first.status === "incompatible")
      early = null;
  };
  active.folder = options.folder ?? null;
  endpoints[0].onboarding = options.onboarding ?? false;
  // Machines keep their place in the list, local first, whichever is shown.
  const view = new Controller(endpoints[0].machine, host);
  view.loadPreferences();
  for (const endpoint of endpoints) {
    view.adopt(endpoint.machine);
    endpoint.controller = view;
  }
  view.switchMachine(active.machine);
  let quit = false;
  let navigation_mouse = false;
  const size = viewer.dimensions();
  let side = sidebar.View.init(size.cols, size.rows, true, 0, 0, host.prefs.sidebar_split).withWidth(
    host.prefs.sidebar_width,
  );
  side.resources = host.prefs.resources;
  const workspaces = new Workspaces(endpoints, view);
  /** Shows `endpoint`'s machine, on `focus` once it can. */
  const choose = (endpoint: Endpoint, focus: Focus | null) => {
    active!.deactivate();
    active = endpoint;
    view.switchMachine(endpoint.machine);
    if (focus !== null) active.choose(focus, active.instance);
    else active.activate();
  };
  const chooseRow = (key: number) => {
    const row = view.rowOf(key),
      endpoint = endpoints.find(e => e.machine === row?.machine);
    if (row && endpoint) choose(endpoint, row.id ? { workspace: row.id } : null);
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
    view.workspace_offset = 0;
    const endpoint = workspaces.filter;
    if (endpoint && endpoint !== active) {
      const first = view.workspaceRows()[0];
      if (first) chooseRow(first.id);
    } else active!.activate();
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
        if ("write_terminal" in effect) viewer.writeAll(effect.write_terminal);
        else if (!view.remote_links) {
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
    if (!input.paste && cp === 27 && view.cancelWorkspaceDrag()) return;
    if (input.paste) {
      if (value === "\x1b[200~")
        paste_owner = !workspaces.open && active!.ready ? { endpoint: active!, epoch: active!.input_epoch } : null;
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
      const hit = !active!.ready || view.workspaceNavigation() ? side.hit(x, y) : { tag: "none" as const };
      if (hit.tag === "workspace_scope" && button === 0 && pressed) {
        show();
        navigation_mouse = true;
        return;
      }
      if (hit.tag === "workspace" && (button === 0 || button === 2) && pressed) {
        const row = view.workspaceRows()[hit.workspace];
        if (row && (row.external || !active!.ready)) {
          chooseRow(row.id);
          navigation_mouse = true;
          return;
        }
      }
      if (!active!.ready && pressed && (button === 64 || button === 65) && x < side.width && y < side.middle()) {
        const offset = Math.max(
          0,
          Math.min(side.workspaceMaxOffset(), side.workspace_offset + (button === 64 ? -1 : 1)),
        );
        view.workspace_offset = offset;
        return;
      }
    }
    if (workspaces.open) {
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
    typeahead();
    if (!active!.ready) {
      if (cp === 18) active!.retry();
      else if (cp === 24) active!.pause();
      else if (cp === 3) quit = true;
      else if (early && !mouse && early.length + input.bytes.length <= 64 * 1024) early.push(...input.bytes);
      return;
    }
    active!.enqueue(input.bytes);
  };
  const feed = (bytes: Uint8Array) => {
    for (const input of parser.feed(probe.feed(bytes))) accept(input);
    notify();
  };
  probe.clipboard.folder = join(dirname(local), "paste");
  probe.clipboard.start(Date.now());
  probe.badge = new corgiBadge.State();
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
  const started = Date.now();
  let next_draw = 0;
  // A frame the host wasn't ready for, drawn once it is.
  let held = false;
  try {
    while (!quit && !stdin.ended) {
      const now = Date.now();
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
      if (active.detached) break;
      // Idle with nothing new, the screen is as it was; it's drawn only now
      // and then, for what changes with time alone.
      if (changed || !idle || view.dirty || workspaces.open || held || Date.now() >= next_draw) {
        changed = false;
        next_draw = Date.now() + quiet_ms;
        let frame: composition.Output;
        if (active.can_render) {
          view.width = cols;
          view.height = height;
          side = view.sidebarView([]);
          frame = active.render();
        } else {
          // Until the machine shows its screen, the frame has only the sidebar.
          const u = render.ui({
            message: "",
            copy_mode: false,
            prefs: host.prefs,
            iterm2_pointer: host.iterm2_pointer,
            corgi_badge: host.corgi_badge,
            supports_kitty_graphics: host.supports_kitty_graphics,
            workspaces: view.workspaceRows(),
            workspace_offset: view.workspace_offset,
            workspace_scope: view.machineScope(),
          });
          palette.use(host.prefs.theme, host.colors);
          side = render.sidebarView(u, cols, height);
          frame = render.frame(null, [], cols, height, u);
        }
        if (!active.fresh || active.error) {
          const status =
            active.status === "online" && !active.fresh
              ? active.error || "Loading a fresh screen…"
              : active.description();
          frame =
            (typeof frame === "string" ? frame : frame.text()) +
            line(Math.max(1, height - 1), ` ${active.name}: ${status} · Input paused`, cols, "warm");
          const machines = endpoints.length > 1 ? " · Ctrl+] machines" : "";
          frame += line(height, ` Ctrl+R retry now · Ctrl+X pause${machines} · Ctrl+C detach`, cols, "strong");
        }
        if (workspaces.open) frame = (typeof frame === "string" ? frame : frame.text()) + workspaces.draw(side);
        if (view.dirty || !composition.same(frame, previous) || view.overlayOpen() || workspaces.open)
          active_at = Date.now();
        // A daemon that answers at once opens on its screen, not the sidebar alone.
        const opening = !active.can_render && previous === "" && now - started < first_frame_ms;
        if (!composition.same(frame, previous) && viewer.ready(probe) && !opening) {
          differ = viewer.present(differ, frame, cols, height, probe.pacer);
          previous = frame;
        }
        if (!workspaces.open && composition.same(frame, previous)) active.presented();
        held = !composition.same(frame, previous);
      }
      typeahead();
      // Idle, it sleeps until a machine is due; input and replies wake it.
      const due = Math.min(...endpoints.map(endpoint => endpoint.due())) - performance.now();
      await wake.wait(now - active_at < idle_after_ms ? 16 : Math.max(1, Math.min(quiet_ms, due)));
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
    viewer.writeAll(view.images.clear() + view.tab_icons.clear());
    viewer.close(view);
    differ?.destroy();
    if (probe.badge.uploaded) viewer.writeAll(corgiBadge.remove);
    if (view.thumbnails.sent !== null) viewer.writeAll(linkThumbnail.remove);
    if (host.supports_kitty_graphics) viewer.writeAll(dockingGrip.clear);
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
function fit(value: string, width: number): string {
  const clean = value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
  const clipped = text.ellipsis(clean, width);
  return clipped + " ".repeat(Math.max(0, width - text.displayWidth(clipped)));
}
function line(row: number, value: string, width: number, color: palette.Token): string {
  return `\x1b[${row};1H` + palette.bg("bg") + palette.fg(color) + fit(value, width) + "\x1b[0m\x1b[?25l";
}
