import { expect, spyOn, test } from "bun:test";
import { Sessions, lease_ms } from "./signin_service";
import { Signin } from "./signin";
import { Signin as Client } from "./signin_client";
import { Terminal } from "./pane/terminal";
import * as protocol from "./protocol";
import { transport } from "./fixtures/transport";

const opening = () => ({
  id: crypto.randomUUID(),
  provider: "claude" as const,
  account: "",
  add: true,
  cwd: "/remote",
  cols: 80,
  rows: 24,
});
const sync = (id: string, fields: object = {}) =>
  protocol.decode("account.signin.sync", { id, cols: 80, rows: 24, ...fields });

test("sign-in survives a lost reply, deduplicates input, and cleans up an expired viewer", async () => {
  let now = 0;
  const sessions = new Sessions(
      () => {},
      () => now,
    ),
    q = opening();
  let flow!: Signin;
  const open = spyOn(Signin.prototype, "open").mockImplementation(async function (this: Signin, cols, rows) {
    flow = this;
    this.resize(cols, rows);
    this.child = new Terminal(cols - 2, rows - 5);
    this.child.feed("Remote login https://example.com/auth");
  });
  const input = spyOn(Signin.prototype, "input").mockResolvedValue();
  try {
    sessions.open(q);
    sessions.open(q);
    expect(open).toHaveBeenCalledTimes(1);
    const initial = await sessions.sync(sync(q.id));
    expect(initial?.drawn.frame).toContain("Remote login");
    expect(initial?.child?.surface.cols).toBe(78);
    const typed = sync(q.id, { input_seq: 1, input: Buffer.from("code\r").toString("base64") });
    await sessions.sync(typed);
    await sessions.sync(typed);
    expect(input).toHaveBeenCalledTimes(1);
    expect(input.mock.calls[0][0]).toEqual(Buffer.from("code\r"));
    now = lease_ms - 1;
    sessions.expire();
    expect(sessions.busy).toBe(true);
    await sessions.sync(sync(q.id));
    now += lease_ms;
    sessions.expire();
    expect(flow.over).toBe(true);
    expect(sessions.busy).toBe(false);
    await expect(sessions.sync(sync(q.id))).rejects.toThrow("SigninExpired");
  } finally {
    flow?.child?.destroy();
    sessions.destroy();
    open.mockRestore();
    input.mockRestore();
  }
});

test("the viewer retries the same input sequence after losing its acknowledgement", async () => {
  const sessions = new Sessions(() => {});
  let flow!: Signin,
    drop = true;
  const open = spyOn(Signin.prototype, "open").mockImplementation(async function (this: Signin) {
    flow = this;
  });
  const input = spyOn(Signin.prototype, "input").mockResolvedValue();
  const conn = transport(async (op, fields) => {
    switch (op) {
      case "account.signin.open":
        sessions.open(protocol.decode(op, fields));
        return { ok: true };
      case "account.signin.sync": {
        const q = protocol.decode(op, fields),
          state = await sessions.sync(q);
        if (q.input_seq === 1 && drop) {
          drop = false;
          throw Error("ReplyLost");
        }
        return { ok: true, state };
      }
      case "account.signin.close":
        sessions.close(protocol.decode(op, fields).id);
        return { ok: true };
      default:
        throw Error("UnexpectedRequest");
    }
  });
  const done: unknown[] = [];
  const client = new Client(() => conn, true, "claude", "", {
    changed() {},
    done: (...args) => {
      done.push(args);
    },
  });
  client.cwd = "/remote";
  try {
    await client.open(80, 24);
    await client.input("hello");
    await Bun.sleep(250);
    expect(input).toHaveBeenCalledTimes(1);
    flow.account = "/remote/account";
    flow.close(0, true, "Account added");
    await Bun.sleep(150);
    expect(done).toEqual([[0, true, "Account added"]]);
    expect(client.account).toBe("/remote/account");
    expect(client.over).toBe(true);
  } finally {
    client.abandon();
    sessions.destroy();
    open.mockRestore();
    input.mockRestore();
  }
});

test("closing during provider discovery cannot stage an account after the viewer leaves", async () => {
  const discovery = await import("./discovery"),
    accounts = await import("./accounts");
  const resolved = Promise.withResolvers<string>();
  const resolve = spyOn(discovery, "resolve").mockReturnValue(resolved.promise);
  const stage = spyOn(accounts, "stage").mockImplementation(() => {
    throw Error("UnexpectedStage");
  });
  const s = new Signin(true, false, { changed() {}, done() {} });
  s.provider = "claude";
  try {
    const pending = s.open(80, 24);
    s.abandon();
    resolved.resolve("/fake/claude");
    await pending;
    expect(stage).not.toHaveBeenCalled();
    expect(s.child).toBeNull();
  } finally {
    s.abandon();
    resolve.mockRestore();
    stage.mockRestore();
  }
});

test.each(["complete", "close", "expire", "close-error"])(
  "a new account stays locked until integration setup settles: %s",
  async end => {
    const accounts = await import("./accounts"),
      discovery = await import("./discovery"),
      integration = await import("./integration"),
      lock = await import("./account_lock");
    const staged = {
      provider: "claude" as const,
      name: "work",
      dir: "/isolated/new-account",
      temp: "/isolated/staged",
    };
    const gate = Promise.withResolvers<void>();
    let flow!: Signin;
    const resolve = spyOn(discovery, "resolve").mockResolvedValue("/fake/claude"),
      stage = spyOn(accounts, "stage").mockReturnValue(staged),
      adopt = spyOn(accounts, "adopt").mockReturnValue({
        provider: "claude",
        name: "work",
        dir: staged.dir,
        managed: true,
      }),
      prepare = spyOn(integration, "prepare").mockReturnValue(gate.promise),
      start = spyOn(Signin.prototype, "start").mockImplementation(async function (this: Signin) {
        flow = this;
        this.name = "work";
      });
    let now = 0;
    const sessions = new Sessions(
        () => {},
        () => now,
      ),
      q = opening();
    try {
      sessions.open(q);
      await Bun.sleep(0);
      expect(() => lock.check("claude", staged.dir)).toThrow("AccountInUse");
      const finishing = flow.finish();
      for (let i = 0; i < 100 && !prepare.mock.calls.length; i++) await Bun.sleep(1);
      expect(adopt).toHaveBeenCalledTimes(1);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(() => lock.check("claude", staged.dir)).toThrow("AccountInUse");
      if (end !== "complete") {
        if (end === "expire") {
          now = lease_ms;
          sessions.expire();
        } else sessions.close(q.id);
        expect(flow.over).toBe(true);
        await expect(sessions.sync(sync(q.id))).rejects.toThrow("SigninExpired");
        expect(() => lock.check("claude", staged.dir)).toThrow("AccountInUse");
      }
      expect(sessions.busy).toBe(true);
      if (end === "close-error") {
        gate.reject(Error("SetupFailed"));
        await expect(finishing).rejects.toThrow("SetupFailed");
      } else {
        gate.resolve();
        await finishing;
      }
      expect(sessions.busy).toBe(false);
      expect(() => lock.check("claude", staged.dir)).not.toThrow();
    } finally {
      gate.resolve();
      sessions.destroy();
      for (const mock of [resolve, stage, adopt, prepare, start]) mock.mockRestore();
    }
  },
);
