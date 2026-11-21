//! `corgi __chat`: the Corgi prompt as a pane of its own. The same card fills
//! the pane and goes on with the conversation the prompt card handed over,
//! in raw mode with its own frames and keys, talking to the daemon at the
//! pane's CORGI_SOCKET. Its reads claim the session for the pane, so closing
//! the pane stops it.
import { dirname, join } from "node:path";
import { openConversation } from "./cli";
import * as errors from "./errors";
import * as agentLauncher from "./agent_launcher";
import * as agentModels from "./agent_models";
import * as mirror from "./mirror";
import * as modelSuggest from "./model_suggest";
import * as promptModels from "./prompt_models";
import * as hostClipboard from "./host_clipboard";
import * as keyboard from "./keyboard";
import { Parser, type Input } from "./terminal_input";
import * as launcherResume from "./launcher_resume";
import * as os from "./os";
import * as preferences from "./preferences";
import * as rpc from "./rpc";
import * as rpc_http from "./rpc_http";
import type * as protocol from "./protocol";
import { Provider } from "./providers";
import { Memory } from "./prompt_memory";
import { clipboardImage, paneScreen, workspaceDiff } from "./prompt_attach";
import { Prompt, parseChatArgs, readHandoff, type ChatArgs, type Context, type Effect } from "./prompt";
import type { Daemon } from "./prompt_session";
import { Writer } from "./text";
import * as viewerNative from "./viewer_native";

/** Encode a decoded key for the prompt's text fields. */
export function legacy(input: Input): Uint8Array {
  if (input.kind !== "key") return input.bytes;
  const edit = keyboard.editSequence(input.key);
  return edit !== null ? Buffer.from(edit, "latin1") : Buffer.from(viewerNative.encodeKey(null, input.key));
}
/** A clipboard packet for the card, or null to check on a read. A paste
 * event reads its text, else its image, and the read's end pastes the text
 * or attaches the image. Returns what to send the terminal. */
export function clipboardPacket(
  clipboard: hostClipboard.State,
  prompt: Prompt,
  raw: string | null,
  now: number,
): string {
  if (raw !== null) clipboard.packet(raw, now);
  else clipboard.tick(now);
  const listing = clipboard.takeEvent(),
    choice = listing !== null ? hostClipboard.choose(listing, true) : "nothing";
  if (choice !== "nothing" && "refuse" in choice)
    prompt.conversation.note(hostClipboard.Failure.message(choice.refuse), "hot");
  else if (choice !== "nothing" && !clipboard.request(choice.read, now))
    prompt.conversation.note(hostClipboard.Failure.message("busy"), "hot");
  const result = clipboard.takeResult();
  if (result && "text" in result) prompt.paste(result.text);
  else if (result && "path" in result) attach(prompt, result.path);
  else if (result && "failed" in result) prompt.conversation.note(hostClipboard.Failure.message(result.failed), "hot");
  return clipboard.takeOutput();
}
function attach(prompt: Prompt, path: string): void {
  const mime = hostClipboard.imageType(path);
  if (mime) prompt.attachImage(path, mime);
  else prompt.conversation.note(hostClipboard.Failure.message("unsupported_image"), "hot");
}
// Kitty's keyboard reports reach it Ctrl+/ and Shift+Enter, which legacy
// encoding turns into / and Enter; paste events, a pasted image.
const enter = "\x1b[?1049h\x1b[?25l\x1b[?1003h\x1b[?1006h\x1b[?2004h" + hostClipboard.enable + keyboard.enable,
  leave = keyboard.disable + hostClipboard.disable + "\x1b[?2004l\x1b[?1006l\x1b[?1003l\x1b[?25h\x1b[?1049l";

/** A pane keeps reading the same catalogs as the card, including when its
 * handoff preceded the first model list. */
export class Models {
  private runtime = new mirror.Runtime();
  private cache: agentModels.Cache;
  private preview: agentLauncher.Preview | null = null;
  private reading = false;
  private read_at = -Infinity;
  private closed = false;
  constructor(
    private connection: mirror.Transport,
    private prompt: Prompt,
    private context: Context,
    read = agentModels.read,
  ) {
    // A pane has no Find agents button; it reads its lists again on a timer.
    this.cache = new agentModels.Cache(() => this.feed(), read, Date.now, agentModels.Cache.background_ms);
  }
  poll(now: number): void {
    if (this.closed || this.reading || now - this.read_at < (this.preview?.pending === false ? 5000 : 1000)) return;
    this.reading = true;
    this.read_at = now;
    void this.refresh()
      .catch(() => {})
      .finally(() => {
        this.reading = false;
      });
  }
  private async refresh(): Promise<void> {
    const snapshot = await mirror.call(this.connection, "session.list", {});
    if (this.closed) return;
    this.runtime.receive(this.connection, snapshot.result);
    const workspace = this.context.workspace_id ?? this.runtime.workspaces.items[0]?.id;
    if (!workspace) return;
    const reply = await mirror.call(this.connection, "agent.preview", { workspace, cwd: this.context.cwd });
    if (this.closed) return;
    this.preview = agentLauncher.preview(reply.preview);
    this.feed();
  }
  private feed(): void {
    if (this.closed || !this.preview) return;
    const { entries, briefs, pending } = promptModels.catalog(
        this.cache,
        promptModels.places(this.runtime, this.preview, this.prompt.choice),
        Date.now() / 1000,
        this.context.cwd,
      ),
      usage = promptModels.usage(this.runtime, this.prompt.choice);
    if (pending && !entries.length && this.prompt.current()) return;
    this.prompt.catalog(
      entries,
      modelSuggest.suggest(usage, entries),
      briefs,
      modelSuggest.auto(usage, entries),
      pending,
    );
    this.prompt.conversation.changed();
  }
  close(): void {
    this.closed = true;
    this.cache.close();
    this.runtime.destroy();
  }
}

/** Runs the Corgi chat in this pane until it closes. */
export async function run(argv: string[]): Promise<void> {
  let args: ChatArgs;
  try {
    args = parseChatArgs(argv);
  } catch {
    process.stderr.write("usage: corgi __chat [HANDOFF] --provider NAME [--session ID] [options]\n");
    process.exitCode = 2;
    return;
  }
  const socket = process.env.CORGI_SOCKET || os.socketPath(),
    // Starts go over HTTP: one may outlast the connection.
    http = new rpc_http.Client(socket),
    pane = Number(process.env.CORGI_PANE) || null,
    handed = readHandoff(args.handoff);
  let conn = new rpc.Connection(socket);
  const call = async (op: string, payload: object): Promise<any> => {
    try {
      return await conn.call(op as protocol.Op, payload as never);
    } catch (error) {
      // A daemon that reloaded hangs up: the next call dials again.
      if (
        ["ConnectionClosed", "ServerReloading", "ServerShutdown", "EPIPE", "ECONNRESET"].includes(
          errors.name(error) ?? "",
        )
      ) {
        conn.close();
        conn = new rpc.Connection(socket);
      }
      throw error;
    }
  };
  const daemon: Daemon = {
    call,
    start: async payload => {
      const reply: any = await http.call("headless.start", payload as never),
        provider = Provider.parse(reply.provider);
      if (!provider || typeof reply.session !== "string") throw Error("InvalidReply");
      return { provider, session: reply.session };
    },
    review: call,
  };
  // What `@` offers here is what the daemon can read: panes and the diff.
  const context: Context = handed?.context
    ? { ...handed.context, mentions: handed.context.mentions.filter(m => m.kind !== "selection") }
    : {
        cwd: args.cwd,
        workspace: "",
        workspace_id: args.workspace,
        branch: "",
        focus: null,
        herd: [],
        mentions: args.cwd ? [{ kind: "diff", cwd: args.cwd }] : [],
      };
  // The conversations the reply's lists show, read again while they show.
  let known: launcherResume.Context | null = null,
    reading = false,
    read_at = 0;
  const readConversations = async () => {
    reading = true;
    try {
      const [{ history }, snapshot] = await Promise.all([
          call("agent.history", { follow: false }),
          call("session.list", {}),
        ]),
        open: launcherResume.Open[] = (snapshot.result?.panes ?? []).flatMap((p: any) => {
          const provider = Provider.parse(p.agent?.provider);
          return provider && p.agent?.session ? [{ provider, session: p.agent.session, pane: p.id }] : [];
        });
      known = new launcherResume.Context(
        {
          pending: history.pending === true,
          entries: (history.entries ?? [])
            .filter((e: any) => Provider.parse(e?.provider))
            .map(launcherResume.historyEntry),
        },
        "",
        "",
        open,
        Math.floor(Date.now() / 1000),
      );
      dirty = true;
    } catch {
    } finally {
      reading = false;
      read_at = Date.now();
    }
  };
  const prompt = new Prompt(
    {
      daemon,
      memory_root: Memory.root(),
      mode: "pane",
      pane,
      conversations: () => known,
      resolve: async m => {
        switch (m.kind) {
          case "agent":
            return paneScreen(call, m.pane);
          case "diff":
            return workspaceDiff(m.cwd);
          case "selection":
          case "workspace":
          case "image":
            return "";
        }
      },
    },
    handed?.choice ??
      (args.model
        ? { provider: args.provider, account: args.account, model: args.model, name: "", effort: args.effort }
        : null),
  );
  if (handed) prompt.adopt(handed);
  else {
    // Restored without its handoff: follow the session, or start anew with its settings once it's gone.
    prompt.incognito = args.incognito;
    prompt.conversation.memory_writes = !args.incognito;
    if (args.session)
      prompt.conversation.attach(
        {
          provider: args.provider,
          account: args.account,
          model: args.model,
          effort: args.effort,
          cwd: args.cwd,
          workspace: args.workspace,
          instructions: "",
          persist: !args.incognito,
        },
        args.session,
        true,
      );
  }
  prompt.show(context);
  const models = new Models({ request: (op, ...args) => call(op, args[0] ?? {}) }, prompt, context);

  const out = process.stdout;
  const parser = new Parser();
  let dirty = true,
    title = "",
    esc: ReturnType<typeof setTimeout> | null = null,
    done = false;
  prompt.changed = () => {
    dirty = true;
  };
  // Pasted images save where the viewer's go.
  const clipboard = new hostClipboard.State();
  clipboard.folder = join(dirname(socket), "paste");
  const pasted = (raw: string | null) => {
    out.write(clipboardPacket(clipboard, prompt, raw, Date.now()));
    dirty = true;
  };
  // Ctrl+V, and the paste key a terminal without paste events passes on:
  // the image on this machine's clipboard.
  const clipboardKey = async () => {
    const path = await clipboardImage(clipboard.folder, Date.now());
    if (path) attach(prompt, path);
    else prompt.conversation.note("No image on the clipboard.", "faint");
    dirty = true;
  };
  const draw = () => {
    const cols = out.columns || 80,
      rows = out.rows || 24,
      w = new Writer();
    w.write("\x1b[?2026h");
    if (cols < 36 || rows < 10) w.write("\x1b[2J");
    prompt.draw(w, cols, rows, null, Date.now());
    w.write("\x1b[?2026l");
    const next = prompt.title();
    if (next !== title) w.write(`\x1b]2;${(title = next)}\x07`);
    out.write(w.s);
  };
  const finish = async () => {
    if (done) return;
    done = true;
    clearInterval(loop);
    models.close();
    try {
      await prompt.conversation.stop();
    } catch {}
    out.write(leave);
    process.stdin.setRawMode?.(false);
    conn.close();
    process.exit(0);
  };
  const apply = async (effect: Effect | null) => {
    dirty = true;
    switch (effect?.kind) {
      case "close":
        return finish();
      case "pick":
        try {
          preferences.update({ prompt_model: effect.choice ?? "auto" });
        } catch {}
        return;
      case "copy":
        // Corgi passes a program's copy on to the host clipboard.
        out.write(`\x1b]52;c;${Buffer.from(effect.text).toString("base64")}\x07`);
        return;
      case "open":
        // In the viewer showing this pane's workspace.
        try {
          const snapshot = await call("session.list", {}),
            workspace = context.workspace_id ?? (await call("session.locate", { pane })).result.workspace,
            viewer = (snapshot.viewers ?? []).find((v: any) => v.workspace === workspace)?.id ?? null;
          await openConversation(
            { call: (op: string, payload?: object) => call(op, payload ?? {}) } as never,
            { provider: effect.entry.provider, session: effect.entry.session, workspace: null, viewer },
            null,
          );
        } catch (error) {
          prompt.conversation.note(`Couldn't open it: ${errors.name(error) ?? "unknown error"}.`, "hot");
        }
        return;
      case "pane":
        // /memory opens its editor in a tab beside this one.
        try {
          const workspace = context.workspace_id ?? (await call("session.locate", { pane })).result.workspace;
          await call("session.command", {
            command: {
              "pane.create": { workspace, from: pane, cwd: effect.cwd, command: os.shellWords(effect.argv), title: "" },
            },
          });
        } catch (error) {
          prompt.conversation.note(`Couldn't open a pane: ${errors.name(error) ?? "unknown error"}.`, "hot");
        }
        return;
    }
  };
  const take = async (input: Input) => {
    switch (input.kind) {
      case "paste_start":
        prompt.pasteStart();
        return;
      case "paste":
        for (const byte of input.bytes) prompt.pasteByte(byte);
        return;
      case "paste_end":
        prompt.pasteEnd();
        dirty = true;
        return;
      case "mouse": {
        const { button, x, y, release } = input.mouse;
        if ((button & 64) !== 0) prompt.scroll((button & 1) !== 0, x, y);
        else if ((button & 32) !== 0) {
          if ((button & 3) === 0 ? prompt.drag(x, y) : prompt.hover(x, y)) dirty = true;
          return;
        } else if ((button & 3) === 0) return apply(release ? prompt.release() : prompt.click(x, y));
        dirty = true;
        return;
      }
      case "sequence": {
        const text = Buffer.from(input.bytes).toString("latin1");
        if (text.startsWith(hostClipboard.packet_prefix))
          return pasted(text.slice(hostClipboard.packet_prefix.length, text.endsWith("\x07") ? -1 : -2));
        return apply(prompt.sequence(text));
      }
      case "key":
        if (hostClipboard.pasteKey(input.key)) return clipboardKey();
        break;
    }
    const bytes = legacy(input);
    if (bytes.length > 1 && bytes[0] === 27) return apply(prompt.sequence(Buffer.from(bytes).toString("latin1")));
    for (const byte of bytes) {
      if (byte === 22) await clipboardKey();
      else await apply(prompt.key(byte));
    }
  };
  // Frame at arrival; asynchronous actions cannot extend an Escape's deadline.
  let input = Promise.resolve();
  let discard_paste = false;
  const queue = (events: Input[]) => {
    input = input.then(async () => {
      for (const event of events) {
        if (discard_paste) {
          if (event.kind === "paste_end") discard_paste = false;
          continue;
        }
        try {
          await take(event);
        } catch {
          discard_paste = event.kind === "paste_start" || event.kind === "paste";
          if (discard_paste) prompt.pasteAbort();
          else break;
        }
      }
    });
  };
  const schedule = () => {
    if (esc) clearTimeout(esc);
    esc = null;
    const due = parser.due();
    if (due !== Infinity)
      esc = setTimeout(
        () => {
          queue(parser.expire());
          schedule();
        },
        Math.max(1, due - performance.now()),
      );
  };
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.on("data", (chunk: Buffer) => {
    queue(parser.feed(chunk));
    schedule();
  });
  out.on("resize", () => {
    out.write("\x1b[2J");
    dirty = true;
  });
  for (const signal of ["SIGHUP", "SIGTERM"] as const)
    process.on(signal, () => {
      // The pane is closing: the daemon stops the session it held.
      out.write(leave);
      process.exit(0);
    });
  out.write(enter);
  const loop = setInterval(() => {
    models.poll(Date.now());
    if (prompt.poll(Date.now())) dirty = true;
    // A read that stalls gives up.
    if (clipboard.reading) pasted(null);
    if (prompt.listed() && !reading && Date.now() - read_at >= (known && !known.history.pending ? 20_000 : 1000))
      void readConversations();
    if (!dirty) return;
    dirty = false;
    draw();
  }, 33);
}
