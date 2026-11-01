import { expect, test } from "bun:test";
import { byProvider, type Provider } from "./providers";
import type { Effort } from "./providers/effort";
import type { Entry } from "./model_picker";
import { auto, fit, lookup, suggest, type Usage } from "./model_suggest";

function entry(provider: Provider, model: string, name: string, efforts: Effort[], fields: Partial<Entry> = {}): Entry {
  return { provider, account: "", account_name: "", model, name, efforts, default_effort: null, ...fields };
}
const claude = [
  entry("claude", "claude-opus-5-5", "Opus 5.5", ["low", "medium", "high", "xhigh", "max"]),
  entry("claude", "claude-sonnet-5-5", "Sonnet 5.5", ["low", "medium", "high"]),
  entry("claude", "claude-haiku-5-5", "Haiku 5.5", ["low", "medium", "high"]),
];
const codex = [
  entry("codex", "gpt-6-astra", "GPT-6 Astra", ["minimal", "low", "medium", "high", "xhigh"], {
    default_effort: "medium",
  }),
  entry("codex", "gpt-6-luna", "GPT-6 Luna", ["none", "low", "medium", "high"], { default_effort: "low" }),
];
const entries = [...codex, ...claude];
function usage(fields: Partial<Usage> = {}): Usage {
  return { launches: byProvider(() => 0), agents: [], last: null, clever: null, ...fields };
}
const brief = (choices: { model: string; effort: Effort | null }[]) => choices.map(c => `${c.model} ${c.effort}`);

test("without any usage each agent offers its default model, then the rest of its lineup; the first a quick one", () => {
  expect(brief(suggest(usage(), entries))).toEqual([
    "gpt-6-astra medium",
    "gpt-6-luna low",
    "claude-opus-5-5 null",
    "claude-sonnet-5-5 null",
    "claude-haiku-5-5 null",
  ]);
  expect(suggest(usage(), [])).toEqual([]);
});

test("it matches the energy of a heavy Claude user who sometimes runs Codex", () => {
  const u = usage({
    launches: { ...byProvider(() => 0), claude: 40, codex: 5 },
    agents: [
      { provider: "codex", account: "", model: "gpt-6-astra", effort: "xhigh" },
      { provider: "claude", account: "", model: "claude-opus-5-5", effort: "high" },
      { provider: "claude", account: "", model: "claude-sonnet-5-5", effort: "medium" },
      { provider: "claude", account: "", model: "claude-opus-5-5[1m]", effort: "high" },
      { provider: "claude", account: "", model: "claude-opus-5-5", effort: "max" },
      { provider: "codex", account: "", model: "gpt-6-astra", effort: "xhigh" },
    ],
    clever: { provider: "claude", model: "claude-haiku-5-5" },
  });
  expect(brief(suggest(u, entries))).toEqual([
    "claude-opus-5-5 high",
    "claude-sonnet-5-5 medium",
    "claude-haiku-5-5 low",
    "gpt-6-astra xhigh",
    // Luna doesn't offer xhigh, so its default stands in.
    "gpt-6-luna low",
  ]);
});

test("the prompt's last pick leads, and the usual model doesn't repeat it", () => {
  const u = usage({
    launches: { ...byProvider(() => 0), claude: 3 },
    agents: [{ provider: "claude", account: "", model: "claude-opus-5-5", effort: "high" }],
    last: { provider: "claude", account: "", model: "claude-opus-5-5", name: "Opus 5.5", effort: "xhigh" },
  });
  const out = suggest(u, entries);
  expect(brief(out).slice(0, 3)).toEqual(["claude-opus-5-5 xhigh", "claude-haiku-5-5 low", "claude-sonnet-5-5 null"]);
  expect(new Set(out.map(c => c.model)).size).toBe(out.length);
});

test("a last pick whose model is gone falls back to what exists", () => {
  const u = usage({
    last: { provider: "claude", account: "", model: "claude-opus-4-1", name: "Opus 4.1", effort: "high" },
  });
  expect(suggest(u, entries).some(c => c.model === "claude-opus-4-1")).toBe(false);
  const offered = usage({
    last: { provider: "codex", account: "", model: "gpt-6-astra", name: "GPT-6 Astra", effort: "max" },
  });
  // Max isn't an effort Astra offers, so its default stands in.
  expect(suggest(offered, entries)[0]).toMatchObject({ model: "gpt-6-astra", effort: "medium" });
});

test("agents' models match their catalog entries however they report them", () => {
  const pi = [entry("pi", "openai-codex/gpt-6-luna", "GPT-6 Luna", ["low", "high"])];
  expect(lookup(pi, "pi", "", "gpt-6-luna")?.model).toBe("openai-codex/gpt-6-luna");
  expect(lookup(claude, "claude", "", "claude-opus-5-5[1m]")?.model).toBe("claude-opus-5-5");
  expect(lookup(claude, "claude", "", "opus")?.model).toBe("claude-opus-5-5");
  expect(lookup(claude, "claude", "", "")?.model).toBe("claude-opus-5-5");
  expect(lookup(claude, "claude", "", "gpt-6-luna")).toBeNull();
  expect(lookup(claude, "codex", "", "claude-opus-5-5")).toBeNull();
});

test("the most used model wins first, then the effort it ran at most", () => {
  const u = usage({
    agents: [
      { provider: "claude", account: "", model: "claude-sonnet-5-5", effort: "high" },
      { provider: "claude", account: "", model: "claude-opus-5-5", effort: "medium" },
      { provider: "claude", account: "", model: "claude-opus-5-5", effort: "low" },
      { provider: "claude", account: "", model: "claude-opus-5-5", effort: "low" },
    ],
  });
  expect(suggest(u, claude)[0]).toEqual({
    provider: "claude",
    account: "",
    model: "claude-opus-5-5",
    name: "Opus 5.5",
    effort: "low",
  });
});

test("a second account's model keeps that account", () => {
  const work = claude.map(e => ({ ...e, account: "/home/me/.claude-work", account_name: "work" }));
  const u = usage({
    agents: [{ provider: "claude", account: "/home/me/.claude-work", model: "claude-sonnet-5-5", effort: null }],
  });
  expect(suggest(u, [...claude, ...work])[0]).toMatchObject({
    account: "/home/me/.claude-work",
    model: "claude-sonnet-5-5",
  });
});

test("one installed agent fills the rest from its catalog", () => {
  expect(brief(suggest(usage(), claude))).toEqual([
    "claude-opus-5-5 null",
    "claude-haiku-5-5 low",
    "claude-sonnet-5-5 null",
  ]);
});

test("without a summary model the quick choice is a small-sounding one", () => {
  const pi = [
    entry("pi", "anthropic/claude-opus-5-5", "Opus 5.5", ["low", "high"]),
    entry("pi", "google/gemini-3-flash", "Gemini 3 Flash", ["minimal", "low", "high"]),
  ];
  expect(brief(suggest(usage(), pi))).toEqual(["anthropic/claude-opus-5-5 null", "google/gemini-3-flash minimal"]);
});

test("Clever Corgi's model is the quick one when the catalog has it", () => {
  const u = usage({ clever: { provider: "codex", model: "gpt-6-luna" } });
  const out = suggest(u, entries);
  // Luna's lowest effort that thinks at all.
  expect(out.find(c => c.model === "gpt-6-luna")?.effort).toBe("low");
  expect(suggest(u, entries)).toEqual(out);
});

test("ties between agents go to the order they're listed in", () => {
  expect(suggest(usage(), entries)[0].provider).toBe("codex");
  const u = usage({ launches: { ...byProvider(() => 0), claude: 2, codex: 2 } });
  expect(suggest(u, entries)[0].provider).toBe("codex");
  const v = usage({ launches: { ...byProvider(() => 0), claude: 3, codex: 2 } });
  expect(suggest(v, entries)[0].provider).toBe("claude");
});

test("a lineup Corgi knows offers its newest at the effort its group opens with, older versions only where run", () => {
  const codex = [
    entry("codex", "gpt-6.1-sol", "GPT-6.1-Sol", ["low", "medium", "high"]),
    entry("codex", "gpt-6-sol", "GPT-6-Sol", ["low", "medium", "high"]),
    entry("codex", "gpt-6-luna", "GPT-6-Luna", ["low", "medium", "high"]),
    entry("codex", "gpt-5.6-terra", "GPT-5.6-Terra", ["low", "medium", "high"]),
  ];
  const pi = [
    entry("pi", "big-pickle", "Big Pickle", []),
    entry("pi", "flint-40b-free", "Flint 40B Free", []),
    entry("pi", "openai/gpt-6-luna-fast", "GPT-6 Luna Fast", []),
  ];
  const u = usage({
    launches: { ...byProvider(() => 0), codex: 4 },
    agents: [{ provider: "codex", account: "", model: "gpt-6-sol", effort: "high" }],
  });
  // Older Sol because it's run, Luna as the quick one, then the newest Sol;
  // Terra 5.6 is a generation behind; free and fast builds wait for a search.
  expect(brief(suggest(u, [...codex, ...pi]))).toEqual([
    "gpt-6-sol high",
    "gpt-6-luna low",
    "gpt-6.1-sol high",
    "big-pickle null",
  ]);
});

test("narrowed, as Clever Corgi asks, a group keeps to what's run and its catalog's first", () => {
  const u = usage({ clever: { provider: "claude", model: "claude-haiku-5-5" } });
  expect(brief(suggest(u, entries, false))).toEqual([
    "gpt-6-astra medium",
    "claude-opus-5-5 null",
    "claude-haiku-5-5 low",
  ]);
});

test("each account is its own group, the one its agents run most first", () => {
  const work = claude.map(e => ({ ...e, account: "/work", account_name: "work" }));
  const u = usage({
    agents: [
      { provider: "claude", account: "/work", model: "claude-haiku-5-5", effort: "low" },
      { provider: "claude", account: "/work", model: "claude-haiku-5-5", effort: "low" },
      { provider: "claude", account: "", model: "claude-opus-5-5", effort: "high" },
    ],
  });
  const out = suggest(u, [...claude, ...work]);
  expect(out.map(c => `${c.account || "default"} ${c.model} ${c.effort}`).slice(0, 4)).toEqual([
    "/work claude-haiku-5-5 low",
    "/work claude-opus-5-5 low",
    "/work claude-sonnet-5-5 low",
    "default claude-opus-5-5 high",
  ]);
});

test("fit keeps offered efforts and falls back to the default", () => {
  expect(fit(codex[0], "high")).toBe("high");
  expect(fit(codex[0], "max")).toBe("medium");
  expect(fit(codex[0], null)).toBe("medium");
  expect(fit(claude[0], null)).toBeNull();
  expect(fit(entry("claude", "x", "X", []), "high")).toBeNull();
});

test("Auto runs the newest strong model of the agent run most, at the effort it runs", () => {
  const sonnet = entry("claude", "claude-sonnet-5-5", "Sonnet 5.5", ["low", "medium", "high"]);
  const terra = entry("codex", "gpt-6.1-terra", "GPT-6.1 Terra", ["low", "medium", "high"], {
    default_effort: "medium",
  });
  const list = [...codex, terra, ...claude.slice(0, 1), sonnet, ...claude.slice(1)];
  const heavy = usage({
    launches: { ...byProvider(() => 0), claude: 9 },
    agents: [{ provider: "claude", account: "", model: "claude-opus-5-5", effort: "high" }],
  });
  expect(auto(heavy, list)).toMatchObject({ provider: "claude", model: "claude-sonnet-5-5", effort: "high" });
  expect(auto(usage({ launches: { ...byProvider(() => 0), codex: 9 } }), list)).toMatchObject({
    model: "gpt-6.1-terra",
    effort: "medium",
  });
  // Without a strong model anywhere, the first suggestion.
  expect(auto(usage(), codex)).toMatchObject({ model: "gpt-6-astra" });
});
