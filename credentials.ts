/**
 * Credential resolution for Codex, Kimi, and Z.AI.
 *
 * Order per provider:
 *   1. pi's own auth store (~/.pi/agent/auth.json) — the credentials pi itself uses.
 *   2. pi's ModelRegistry (refreshes OAuth tokens when expired).
 *   3. The provider CLI's own credential store, as a fallback:
 *      - Codex: ~/.codex/auth.json (ChatGPT sign-in only; the codex CLI refreshes it)
 *      - Kimi:  ~/.kimi/credentials/kimi-code.json (15-minute OAuth tokens; used only if unexpired)
 *
 * Codex note: the usage endpoint only works with ChatGPT OAuth tokens — a plain
 * OpenAI API key cannot query usage (same restriction as the codex CLI, which
 * shows "Sign in with ChatGPT to use /usage" for API-key users). API-key entries
 * are therefore skipped on purpose.
 *
 * Tokens are never logged or included in rendered output.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { asNumber, asRecord, asString } from "./util.js";

export interface CodexCredentials {
  accessToken: string;
  accountId: string | undefined;
}

/** Refreshed API key lookup, e.g. `ctx.modelRegistry.getApiKeyForProvider`. */
export type ApiKeyLookup = (provider: string) => Promise<string | undefined>;

const PI_AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json");
const CODEX_AUTH_PATH = join(homedir(), ".codex", "auth.json");
const KIMI_CREDENTIALS_PATH = join(homedir(), ".kimi", "credentials", "kimi-code.json");

/** Treat tokens expiring within this margin as already expired. */
const EXPIRY_MARGIN_MS = 60_000;

async function readJsonFile(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    return asRecord(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function withAccountId(accessToken: string, accountId: string | undefined): CodexCredentials {
  return accountId === undefined
    ? { accessToken, accountId: undefined }
    : { accessToken, accountId };
}

export async function resolveCodexCredentials(
  lookupApiKey?: ApiKeyLookup,
): Promise<CodexCredentials | undefined> {
  const now = Date.now();

  // 1. pi's auth store: { "openai-codex": { type: "oauth", access, refresh, expires, accountId } }.
  //    Only OAuth entries — plain API keys ("type": "api_key") cannot query usage.
  const piAuth = await readJsonFile(PI_AUTH_PATH);
  const piCodex = asRecord(piAuth?.["openai-codex"]);
  const piType = piCodex ? asString(piCodex.type) : undefined;
  const piAccountId = piCodex ? asString(piCodex.accountId) : undefined;
  const piAccess = piCodex ? asString(piCodex.access) : undefined;
  const piExpires = piCodex ? asNumber(piCodex.expires) : undefined;
  if (
    piType === "oauth" &&
    piAccess !== undefined &&
    piExpires !== undefined &&
    piExpires > now + EXPIRY_MARGIN_MS
  ) {
    return withAccountId(piAccess, piAccountId);
  }

  // 2. ModelRegistry — performs an OAuth refresh when the stored token is expired.
  //    The caller passes lookupApiKey only when pi's codex auth is OAuth-based.
  if (lookupApiKey !== undefined) {
    const refreshed = await lookupApiKey("openai-codex").catch(() => undefined);
    if (refreshed !== undefined) return withAccountId(refreshed, piAccountId);
  }

  // 3. Codex CLI's own store, ChatGPT sign-in only:
  //    { auth_mode: "chatgpt", tokens: { access_token, account_id } }
  const codexAuth = await readJsonFile(CODEX_AUTH_PATH);
  if (asString(codexAuth?.auth_mode) === "chatgpt") {
    const tokens = asRecord(codexAuth?.tokens);
    const cliAccess = tokens ? asString(tokens.access_token) : undefined;
    if (cliAccess !== undefined) {
      const cliAccountId = tokens ? asString(tokens.account_id) : undefined;
      return withAccountId(cliAccess, cliAccountId ?? piAccountId);
    }
  }

  return undefined;
}

export async function resolveZaiApiKey(lookupApiKey?: ApiKeyLookup): Promise<string | undefined> {
  const piAuth = await readJsonFile(PI_AUTH_PATH);
  const piZai = asRecord(piAuth?.zai);
  const piKey = piZai ? (asString(piZai.key) ?? asString(piZai.access)) : undefined;
  if (piKey !== undefined) return piKey;
  return lookupApiKey?.("zai").catch(() => undefined);
}

export async function resolveKimiApiKey(lookupApiKey?: ApiKeyLookup): Promise<string | undefined> {
  // 1. pi's auth store: { "kimi-coding": { type: "api_key", key } }
  //    (an OAuth-style "access" token works against /usages too).
  const piAuth = await readJsonFile(PI_AUTH_PATH);
  const piKimi = asRecord(piAuth?.["kimi-coding"]);
  const piKey = piKimi ? (asString(piKimi.key) ?? asString(piKimi.access)) : undefined;
  if (piKey !== undefined) return piKey;

  // 2. ModelRegistry.
  if (lookupApiKey !== undefined) {
    const resolved = await lookupApiKey("kimi-coding").catch(() => undefined);
    if (resolved !== undefined) return resolved;
  }

  // 3. Kimi CLI's OAuth store — access tokens live only ~15 minutes, so use only if fresh.
  const kimiCreds = await readJsonFile(KIMI_CREDENTIALS_PATH);
  const accessToken = kimiCreds ? asString(kimiCreds.access_token) : undefined;
  const expiresAtSec = kimiCreds ? asNumber(kimiCreds.expires_at) : undefined;
  if (
    accessToken !== undefined &&
    expiresAtSec !== undefined &&
    expiresAtSec * 1000 > Date.now() + EXPIRY_MARGIN_MS
  ) {
    return accessToken;
  }

  return undefined;
}
