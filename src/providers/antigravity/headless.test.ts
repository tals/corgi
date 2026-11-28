import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as json from "../../json";
import { max_image_bytes } from "../adapter";
import { Stdio } from "../stdio";
import { Antigravity } from "./headless";

const session = "0bba77c5-f8cc-4ac4-9e6c-3995feb59cb6";
function client() {
  return new Antigravity(new Stdio(), { cwd: "/tmp", instructions: "", model: "", effort: "" });
}
function respond(agent: Antigravity, id: string, result: unknown) {
  const read = spyOn(agent.io, "read").mockReturnValueOnce([{ id, result }]);
  try {
    return agent.take();
  } finally {
    read.mockRestore();
  }
}
function lastRequest(agent: Antigravity) {
  return JSON.parse(agent.io.output.toString().trimEnd().split("\n").at(-1)!);
}

test("a queued full-size Antigravity image survives source changes and live handoff", () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-acp-")),
    path = join(dir, "a.png"),
    original = Buffer.alloc(max_image_bytes, 42),
    agent = client();
  let adopted: Antigravity | undefined;
  try {
    respond(agent, "new", { sessionId: session });
    agent.send({ kind: "prompt", text: "first" });
    writeFileSync(path, original);
    agent.send({ kind: "prompt", text: "look", images: [{ path, mime: "image/png" }] });
    agent.send({ kind: "prompt", text: "last" });
    writeFileSync(path, "replaced");
    rmSync(path);
    const saved = json.clone(agent.save(true)),
      copy = json.field(saved.state, "pending")[0].images[0].path;
    expect(json.stringify(saved).length).toBeLessThan(4096);
    const cold = Antigravity.restore(json.clone(agent.save(false)), false);
    expect(cold.io.exited).toBe(true);
    cold.close();
    Antigravity.restore(saved, true).close();
    expect(existsSync(copy)).toBe(true);
    adopted = Antigravity.restore(saved, true);
    adopted.adopt();
    respond(adopted, "turn-1", { stopReason: "end_turn" });
    const request = lastRequest(adopted);
    expect(request.id).toBe("turn-2");
    expect(request.params.prompt[0]).toEqual({ type: "text", text: "look" });
    expect(Buffer.from(request.params.prompt[1].data, "base64").equals(original)).toBe(true);
    expect(existsSync(copy)).toBe(false);
    adopted.io.output = Buffer.alloc(0);
    respond(adopted, "turn-2", { stopReason: "end_turn" });
    expect(lastRequest(adopted)).toMatchObject({ id: "turn-3", params: { prompt: [{ type: "text", text: "last" }] } });
  } finally {
    adopted?.close();
    agent.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Antigravity cleans queued copies on rejection, interruption and close", () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-acp-")),
    path = join(dir, "a.png"),
    image = { path, mime: "image/png" },
    agent = client();
  try {
    writeFileSync(path, "image");
    expect(() =>
      agent.send({ kind: "prompt", text: "", images: [image, { ...image, path: join(dir, "missing") }] }),
    ).toThrow();
    const root = json.str(agent.save(false).state, "root");
    expect(readdirSync(root)).toEqual([]);
    truncateSync(path, max_image_bytes + 1);
    expect(() => agent.send({ kind: "prompt", text: "", images: [image] })).toThrow("ImageTooLarge");
    writeFileSync(path, "image");
    agent.send({ kind: "prompt", text: "", images: [image] });
    expect(readdirSync(root)).toHaveLength(1);
    agent.send({ kind: "interrupt" });
    expect(readdirSync(root)).toEqual([]);
    agent.send({ kind: "prompt", text: "", images: [image] });
    agent.close();
    expect(existsSync(root)).toBe(false);
    expect(existsSync(path)).toBe(true);
  } finally {
    agent.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Antigravity resumes an older handoff with an unreadable prompt at the head of the queue", () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-acp-")),
    agent = client();
  let adopted: Antigravity | undefined;
  try {
    respond(agent, "new", { sessionId: session });
    const saved = json.clone(agent.save(true));
    json.object(saved.state).pending = [
      { kind: "prompt", text: "", images: [{ path: join(dir, "missing"), mime: "image/png" }] },
      { kind: "prompt", text: "next" },
    ];
    adopted = Antigravity.restore(saved, true);
    adopted.adopt();
    expect(adopted.take()).toMatchObject([
      { kind: "turn", phase: "started", turn: "turn-1" },
      { kind: "turn", phase: "ended", turn: "turn-1", outcome: "failed" },
      { kind: "turn", phase: "started", turn: "turn-2" },
    ]);
    expect(lastRequest(adopted).params.prompt).toEqual([{ type: "text", text: "next" }]);
  } finally {
    adopted?.close();
    agent.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
