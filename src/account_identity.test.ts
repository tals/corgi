import { expect, test } from "bun:test";
import * as identity from "./account_identity";
import { readAccount } from "./providers/claude/account";
import { account } from "./providers/codex/account";
import { identities } from "./providers/opencode2/identity";

test("older account metadata gets defaults and credentials never cross the boundary", () => {
  const base = { id: "profile", name: "Work", directory: "/profiles/work" };
  expect(identity.read(base)).toEqual({
    ...base,
    loginId: null,
    email: null,
    type: null,
    plan: null,
    usage: null,
  });
  expect(
    identity.read({
      ...base,
      loginId: "user/org",
      email: "me@example.com",
      type: "oauth",
      token: "secret",
      usage: { limits: { windows: [{ used: 200 }, { used: 42, reset_at: -1 }] }, error: "\x1bsecret" },
    }),
  ).toEqual({
    ...base,
    loginId: "user/org",
    email: "me@example.com",
    type: "oauth",
    plan: null,
    usage: {
      limits: { windows: [null, { used: 42, reset_at: null, minutes: null }] },
      fetched_at: null,
      spend: null,
      error: null,
      needs_consent: false,
    },
  });
});

test("email and authentication type are provider fields, not account-column labels", () => {
  expect(
    identity.details(readAccount({ loggedIn: true, authMethod: "claude.ai", email: "me@example.com" })),
  ).toMatchObject({ email: "me@example.com", type: "oauth" });
  for (const authMethod of ["api_key", "api_key_helper", "third_party"]) {
    const info = identity.details(readAccount({ loggedIn: true, authMethod }));
    expect(info.email).toBeNull();
    expect(info.type).toBe(authMethod === "third_party" ? "external" : "api_key");
  }
  expect(identity.details(account({ type: "apiKey" }))).toMatchObject({ email: null, type: "api_key" });
  expect(identity.details(account({ type: "chatgpt", email: "me@example.com", planType: "pro" }))).toMatchObject({
    email: "me@example.com",
    type: "oauth",
    plan: "Pro 200",
  });
});

test("native account metadata uses the credential ID and whitelisted profile fields", () => {
  const found = identities(
    { data: [{ id: "anthropic", integrationID: "anthropic" }] },
    {
      data: [
        {
          id: "native-login",
          integrationID: "anthropic",
          active: true,
          label: "Work",
          value: { type: "oauth", email: "me@example.com", access: "secret" },
        },
      ],
    },
  ).get("anthropic");
  expect(found).toMatchObject({ loginId: "native-login", email: "me@example.com", type: "oauth" });
  expect(JSON.stringify(found)).not.toContain("secret");
});
