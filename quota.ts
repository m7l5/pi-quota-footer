/**
 * Quota collection orchestration.
 *
 * A provider's quota segment is enabled only while that provider is active in
 * pi (i.e. pi has credentials configured for it — stored, runtime, models.json,
 * or environment). Within that gate, credentials are resolved and both
 * providers are fetched in parallel; merging is flicker-free (the last good
 * snapshot is kept across transient errors).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type ApiKeyLookup,
  resolveCodexCredentials,
  resolveKimiApiKey,
  resolveZaiApiKey,
} from "./credentials.js";
import { fetchClaudeUsage, isClaudeCodeLoggedIn } from "./providers/claude.js";
import { fetchCodexUsage } from "./providers/codex.js";
import { fetchKimiUsage } from "./providers/kimi.js";
import { fetchZaiUsage } from "./providers/zai.js";
import type { ProviderState, QuotaState, UsageFetchResult } from "./types.js";
import { formatResetIn } from "./util.js";

const CODEX_PROVIDER = "openai-codex";
const CLAUDE_PROVIDERS = ["anthropic", "claude-runtime"];
const ZAI_PROVIDER = "zai";
const KIMI_PROVIDER = "kimi-coding";
const CLAUDE_BINARY = process.env.PI_CLAUDE_RUNTIME_BINARY ?? "claude";

/** Segment omitted: provider not active in pi. Any previous snapshot is dropped. */
function inactive(): ProviderState {
  return { configured: false, snapshot: undefined, error: undefined, note: undefined };
}

/** Segment omitted although the provider is active — the note explains why in /quota. */
function hidden(note: string): ProviderState {
  return { configured: false, snapshot: undefined, error: undefined, note };
}

function mergeProviderState(previous: ProviderState, result: UsageFetchResult): ProviderState {
  if (result.ok) {
    return { configured: true, snapshot: result.snapshot, error: undefined, note: undefined };
  }
  return { configured: true, snapshot: previous.snapshot, error: result.error, note: undefined };
}

/** "Active in pi" = pi has credentials configured for the provider (any source). */
function isProviderActive(ctx: ExtensionContext, provider: string): boolean {
  return ctx.modelRegistry.getProviderAuthStatus(provider).configured;
}

function apiKeyLookup(ctx: ExtensionContext): ApiKeyLookup {
  return (provider) => ctx.modelRegistry.getApiKeyForProvider(provider).catch(() => undefined);
}

async function collectCodex(
  ctx: ExtensionContext,
  previous: ProviderState,
): Promise<ProviderState> {
  if (!isProviderActive(ctx, CODEX_PROVIDER)) return inactive();

  // The usage endpoint requires ChatGPT OAuth — a plain OpenAI API key cannot
  // query it. Only let the registry hand us a key when pi's codex auth is OAuth;
  // otherwise fall through to the codex CLI's ChatGPT tokens inside the resolver.
  const model = ctx.modelRegistry.getAvailable().find((m) => m.provider === CODEX_PROVIDER);
  const registryIsOAuth = model !== undefined && ctx.modelRegistry.isUsingOAuth(model);
  const credentials = await resolveCodexCredentials(
    registryIsOAuth ? apiKeyLookup(ctx) : undefined,
  );
  if (credentials === undefined) {
    return hidden("active in pi with API-key auth — the Codex usage endpoint needs ChatGPT OAuth");
  }
  return mergeProviderState(previous, await fetchCodexUsage(credentials));
}

async function collectClaude(
  ctx: ExtensionContext,
  previous: ProviderState,
): Promise<ProviderState> {
  const activeInPi = CLAUDE_PROVIDERS.some((provider) => isProviderActive(ctx, provider));
  const cliLoggedIn = await isClaudeCodeLoggedIn(CLAUDE_BINARY);
  if (!activeInPi && !cliLoggedIn) return inactive();
  if (!cliLoggedIn) {
    return hidden(
      "active in pi with API-key auth, but Claude plan quota needs a Claude Code subscription login",
    );
  }
  return mergeProviderState(previous, await fetchClaudeUsage(CLAUDE_BINARY));
}

async function collectZai(ctx: ExtensionContext, previous: ProviderState): Promise<ProviderState> {
  if (!isProviderActive(ctx, ZAI_PROVIDER)) return inactive();
  const apiKey = await resolveZaiApiKey(apiKeyLookup(ctx));
  if (apiKey === undefined) return hidden("active in pi, but no usable Z.AI credential was found");
  return mergeProviderState(previous, await fetchZaiUsage(apiKey));
}

async function collectKimi(ctx: ExtensionContext, previous: ProviderState): Promise<ProviderState> {
  if (!isProviderActive(ctx, KIMI_PROVIDER)) return inactive();

  const apiKey = await resolveKimiApiKey(apiKeyLookup(ctx));
  if (apiKey === undefined) {
    return hidden("active in pi, but no usable Kimi credential was found");
  }
  return mergeProviderState(previous, await fetchKimiUsage(apiKey));
}

export async function collectQuotas(
  ctx: ExtensionContext,
  previous: QuotaState,
): Promise<QuotaState> {
  const [codex, claude, zai, kimi] = await Promise.all([
    collectCodex(ctx, previous.codex),
    collectClaude(ctx, previous.claude),
    collectZai(ctx, previous.zai),
    collectKimi(ctx, previous.kimi),
  ]);
  return { codex, claude, zai, kimi };
}

function formatProviderDetails(name: string, state: ProviderState, nowMs: number): string {
  if (!state.configured) return `${name}: ${state.note ?? "not active in pi"}`;
  if (state.snapshot === undefined) {
    return state.error === undefined ? `${name}: fetching…` : `${name}: ${state.error}`;
  }
  const windows = state.snapshot.windows
    .map((window) => {
      const reset =
        window.resetAtMs === undefined
          ? ""
          : ` (resets in ${formatResetIn(window.resetAtMs, nowMs)})`;
      return `${window.label} ${String(Math.round(window.usedPercent))}% used${reset}`;
    })
    .join(", ");
  const details =
    state.snapshot.detailLines.length > 0 ? ` — ${state.snapshot.detailLines.join(", ")}` : "";
  const error = state.error === undefined ? "" : ` (stale: ${state.error})`;
  return `${name}: ${windows}${details}${error}`;
}

/** Multi-line summary for the /quota command. */
export function formatQuotaDetails(state: QuotaState, nowMs: number): string {
  return [
    formatProviderDetails("Codex", state.codex, nowMs),
    formatProviderDetails("Claude", state.claude, nowMs),
    formatProviderDetails("GLM", state.zai, nowMs),
    formatProviderDetails("Kimi", state.kimi, nowMs),
  ].join("\n");
}
