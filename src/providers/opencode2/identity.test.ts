import { expect, spyOn, test } from "bun:test";
import { API } from "./api";
import { Accounts, identities } from "./identity";

test("native account IDs follow the model provider and survive label and token changes", () => {
  const providers = {
    data: [
      { id: "claude-work", integrationID: "anthropic" },
      { id: "openai", integrationID: "openai" },
    ],
  };
  const credentials = {
    data: [
      { id: "personal", integrationID: "anthropic", label: "Personal", active: false },
      { id: "work", integrationID: "anthropic", label: "Work", active: true, value: { access: "secret" } },
      { id: "codex", integrationID: "openai", label: "Codex", active: true },
    ],
  };
  const before = identities(providers, credentials);
  expect(before.get("claude-work")).toEqual({
    id: '["opencode2","work"]',
    name: "Work",
    directory: null,
    loginId: "work",
    email: null,
    type: null,
    plan: null,
    usage: null,
  });
  expect(before.get("openai")?.id).not.toBe(before.get("claude-work")?.id);
  expect(JSON.stringify([...before.values()])).not.toContain("secret");
  credentials.data[1].label = "Renamed";
  credentials.data[1].value = { access: "new-secret" };
  expect(identities(providers, credentials).get("claude-work")?.id).toBe(before.get("claude-work")?.id);
  credentials.data[1].active = false;
  credentials.data[0].active = true;
  expect(identities(providers, credentials).get("claude-work")?.id).toBe('["opencode2","personal"]');
});

test("session identity uses project-scoped providers, caches reads, and refreshes native switches", async () => {
  let chosen = "work";
  const calls: string[] = [];
  const call = spyOn(API.prototype, "call").mockImplementation(async (_method, path) => {
    calls.push(path);
    if (path.startsWith("/api/model/default")) return { data: { providerID: "alias" } };
    if (path.startsWith("/api/provider?")) return { data: [{ id: "alias", integrationID: "anthropic" }] };
    if (path === "/api/credential")
      return { data: [{ id: chosen, integrationID: "anthropic", active: true, label: chosen }] };
    throw Error("UnexpectedRequest");
  });
  try {
    const cache = new Accounts(new API("unused", "/fallback")),
      session = { model: { providerID: "alias" }, location: { directory: "/project" } };
    expect((await cache.describe(session))?.id).toBe('["opencode2","work"]');
    expect((await cache.describe(session))?.id).toBe('["opencode2","work"]');
    expect(calls).toEqual(["/api/provider?location%5Bdirectory%5D=%2Fproject", "/api/credential"]);
    chosen = "personal";
    expect(cache.invalidate("credential.switched")).toBe(true);
    expect((await cache.describe(session))?.id).toBe('["opencode2","personal"]');
    expect((await cache.describe({ location: session.location }))?.id).toBe('["opencode2","personal"]');
    expect(await cache.describe({ ...session, model: { providerID: "unknown" } })).toBeNull();
  } finally {
    call.mockRestore();
  }
});
