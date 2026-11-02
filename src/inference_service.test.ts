import { expect, spyOn, test } from "bun:test";
import { configure } from "./inference_service";
import { Worker } from "./activity/worker";
import { Option } from "./inference/models";
import * as setup from "./inference/setup";
import * as protocol from "./protocol";
import * as accounts from "./accounts";

test("model discovery replies while fetching and cached selections never wait for it", async () => {
  const worker = new Worker(),
    server: any = { summaries: worker, socket: "", runtime: { changed() {} } },
    replies: any[] = [],
    client: any = { queue: (reply: unknown) => replies.push(reply) },
    path = spyOn(setup, "path").mockReturnValue("/unused/settings.json"),
    uses = spyOn(setup, "loadUses").mockReturnValue(setup.allUses(true)),
    save = spyOn(setup, "save").mockImplementation(() => {}),
    selection = spyOn(setup, "saveSelection").mockImplementation(() => {});
  let finish!: () => void;
  const pending = new Promise<void>(resolve => (finish = resolve));
  const read = spyOn(worker.catalog as any, "read").mockImplementation(() => pending);
  worker.catalog.available = [Object.assign(new Option(), { provider: "pi", model: "custom/cached", name: "Cached" })];
  try {
    await configure(server, client, protocol.decode("inference.configure", {}));
    expect(replies).toHaveLength(1);
    expect(replies[0].inference.loading).toBe(true);
    expect(replies[0].inference.available[0].name).toBe("Cached");
    expect(read).toHaveBeenCalledTimes(1);
    await configure(server, client, protocol.decode("inference.configure", {}));
    expect(replies).toHaveLength(2);
    expect(read).toHaveBeenCalledTimes(1);

    await configure(server, client, protocol.decode("inference.configure", { choice: "pi", model: "custom/cached" }));
    expect(replies).toHaveLength(3);
    expect(worker.selected.model).toBe("custom/cached");
    expect(read).toHaveBeenCalledTimes(1);
    await configure(server, client, protocol.decode("inference.configure", { activity: false }));
    expect(worker.uses.activity).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);

    finish();
    await worker.catalog.refresh();
    await configure(server, client, protocol.decode("inference.configure", {}));
    expect(replies.at(-1).inference.loading).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
  } finally {
    finish();
    worker.stop();
    read.mockRestore();
    selection.mockRestore();
    save.mockRestore();
    uses.mockRestore();
    path.mockRestore();
  }
});

test("an uncached selection fails promptly without starting model discovery", async () => {
  const worker = new Worker(),
    server: any = { summaries: worker },
    read = spyOn(worker.catalog, "refresh");
  try {
    await expect(
      configure(server, {} as any, protocol.decode("inference.configure", { choice: "pi" })),
    ).rejects.toThrow("ModelUnavailable");
    expect(read).not.toHaveBeenCalled();
  } finally {
    worker.stop();
    read.mockRestore();
  }
});

test("native inference selects a known named account and returns to default without retaining it", async () => {
  const worker = new Worker(),
    server: any = { summaries: worker, socket: "", runtime: { changed() {} } },
    client: any = { queue() {} },
    path = spyOn(setup, "path").mockReturnValue("/unused/settings.json"),
    uses = spyOn(setup, "loadUses").mockReturnValue(setup.allUses(true)),
    save = spyOn(setup, "save").mockImplementation(() => {}),
    selection = spyOn(setup, "saveSelection").mockImplementation(() => {}),
    find = spyOn(accounts, "find").mockImplementation((provider, dir) =>
      dir === "/nvidia" ? { provider, dir, name: "nvidia", managed: false } : null,
    ),
    read = spyOn(worker.catalog, "refresh");
  try {
    for (const provider of ["codex", "claude"] as const) {
      await configure(
        server,
        client,
        protocol.decode("inference.configure", { choice: provider, model: "custom/model", account: "/nvidia" }),
      );
      expect(worker.selection(provider)).toEqual({ provider, model: "custom/model", account: "/nvidia" });
      expect(selection).toHaveBeenLastCalledWith("/unused/settings.json", {
        provider,
        model: "custom/model",
        account: "/nvidia",
      });
      await expect(
        configure(
          server,
          client,
          protocol.decode("inference.configure", { choice: provider, model: "custom/model", account: "/removed" }),
        ),
      ).rejects.toThrow("ModelUnavailable");
      await configure(server, client, protocol.decode("inference.configure", { choice: provider }));
      expect(worker.selection(provider).account).toBe("");
      expect(worker.selected.provider).toBeNull();
    }
    expect(read).not.toHaveBeenCalled();
  } finally {
    worker.stop();
    read.mockRestore();
    find.mockRestore();
    selection.mockRestore();
    save.mockRestore();
    uses.mockRestore();
    path.mockRestore();
  }
});
