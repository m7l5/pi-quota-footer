/**
 * Dev probe (not loaded by pi): verifies credential resolution and the live
 * usage endpoints through the extension's own code, tests the provider
 * activation gating with a mock registry, then smoke-tests the pure footer
 * renderer with fake data. Run: npm run probe
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveCodexCredentials, resolveKimiApiKey } from "../credentials.js";
import { renderFooterLines, type FooterStyle } from "../footer.js";
import { fetchCodexUsage } from "../providers/codex.js";
import { fetchKimiUsage } from "../providers/kimi.js";
import { collectQuotas, formatQuotaDetails } from "../quota.js";
import { emptyQuotaState, type QuotaState } from "../types.js";

console.log("== credentials ==");
const codexCredentials = await resolveCodexCredentials();
console.log(
  "codex:",
  codexCredentials === undefined
    ? "not found"
    : {
        accountIdFound: codexCredentials.accountId !== undefined,
        tokenLength: codexCredentials.accessToken.length,
      },
);
const kimiApiKey = await resolveKimiApiKey();
console.log(
  "kimi:",
  kimiApiKey === undefined ? "not found" : `found (length ${kimiApiKey.length})`,
);

console.log("\n== live fetches ==");
const quota: QuotaState = emptyQuotaState();
quota.codex.configured = codexCredentials !== undefined;
quota.kimi.configured = kimiApiKey !== undefined;

if (codexCredentials !== undefined) {
  const result = await fetchCodexUsage(codexCredentials);
  if (result.ok) {
    quota.codex.snapshot = result.snapshot;
    console.log("codex usage:", JSON.stringify(result.snapshot, null, 2));
  } else {
    quota.codex.error = result.error;
    console.log("codex error:", result.error);
  }
}
if (kimiApiKey !== undefined) {
  const result = await fetchKimiUsage(kimiApiKey);
  if (result.ok) {
    quota.kimi.snapshot = result.snapshot;
    console.log("kimi usage:", JSON.stringify(result.snapshot, null, 2));
  } else {
    quota.kimi.error = result.error;
    console.log("kimi error:", result.error);
  }
}

console.log("\n== activation gating (mock registry) ==");

interface MockRegistryOptions {
  codexConfigured: boolean;
  kimiConfigured: boolean;
  codexOAuth: boolean;
}

function mockCtx(options: MockRegistryOptions): ExtensionContext {
  const registry = {
    getProviderAuthStatus: (provider: string) => ({
      configured: provider === "openai-codex" ? options.codexConfigured : options.kimiConfigured,
    }),
    getAvailable: () => (options.codexConfigured ? [{ provider: "openai-codex" }] : []),
    isUsingOAuth: () => options.codexOAuth,
    getApiKeyForProvider: () => Promise.resolve(undefined),
  };
  return { modelRegistry: registry } as unknown as ExtensionContext;
}

// Case 1: neither provider active in pi → both segments off, zero network calls.
const inactive = await collectQuotas(
  mockCtx({ codexConfigured: false, kimiConfigured: false, codexOAuth: false }),
  emptyQuotaState(),
);
console.log("both inactive:", formatQuotaDetails(inactive, Date.now()).replace("\n", " | "));
if (inactive.codex.configured || inactive.kimi.configured) {
  throw new Error("gating broken: segments enabled without active providers");
}

// Case 2: only kimi active → codex segment off, kimi fetched live.
const kimiOnly = await collectQuotas(
  mockCtx({ codexConfigured: false, kimiConfigured: true, codexOAuth: false }),
  emptyQuotaState(),
);
console.log("kimi only:", formatQuotaDetails(kimiOnly, Date.now()).replace("\n", " | "));
if (kimiOnly.codex.configured || !kimiOnly.kimi.configured) {
  throw new Error("gating broken: codex should be off, kimi should be on");
}

// Case 3: both active → both fetched live.
const bothActive = await collectQuotas(
  mockCtx({ codexConfigured: true, kimiConfigured: true, codexOAuth: true }),
  emptyQuotaState(),
);
console.log("both active:", formatQuotaDetails(bothActive, Date.now()).replace("\n", " | "));
if (!bothActive.codex.configured || !bothActive.kimi.configured) {
  throw new Error("gating broken: both segments should be on");
}

console.log("\n== footer smoke test (width 160, no ANSI) ==");
const plainStyle: FooterStyle = { fg: (_color, text) => text, bold: (text) => text };
const lines = renderFooterLines(
  {
    width: 160,
    cwd: "/Users/mohammed.larabi/code/some-project",
    homeDir: "/Users/mohammed.larabi",
    branch: "main",
    sessionName: undefined,
    totalInput: 12_345,
    totalOutput: 3_210,
    totalCacheRead: 1_234_567,
    totalCacheWrite: 9_876,
    totalCost: 0.4123,
    latestCacheHitRate: 78.4,
    usingSubscription: false,
    contextPercent: 41.23,
    contextWindow: 200_000,
    autoCompactEnabled: true,
    experimentalEnabled: false,
    modelId: "k3",
    modelReasoning: true,
    modelProvider: "kimi-coding",
    thinkingLevel: "high",
    providerCount: 2,
    quota,
    nowMs: Date.now(),
    extensionStatuses: new Map([["other-ext", "other status text"]]),
  },
  plainStyle,
);
for (const line of lines) console.log(`|${line}|`);

console.log("\n== footer smoke test (width 90, truncation) ==");
const narrow = renderFooterLines(
  {
    ...structuredClone({
      width: 90,
      cwd: "/Users/mohammed.larabi/code/some-project",
      homeDir: "/Users/mohammed.larabi",
      branch: "main",
      sessionName: undefined,
      totalInput: 12_345,
      totalOutput: 3_210,
      totalCacheRead: 1_234_567,
      totalCacheWrite: 9_876,
      totalCost: 0.4123,
      latestCacheHitRate: 78.4,
      usingSubscription: false,
      contextPercent: 41.23,
      contextWindow: 200_000,
      autoCompactEnabled: true,
      experimentalEnabled: false,
      modelId: "k3",
      modelReasoning: true,
      modelProvider: "kimi-coding",
      thinkingLevel: "high",
      providerCount: 2,
      nowMs: Date.now(),
      extensionStatuses: new Map(),
    }),
    quota,
  },
  plainStyle,
);
for (const line of narrow) console.log(`|${line}|`);
