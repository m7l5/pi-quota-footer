/**
 * Codex (ChatGPT) usage fetching.
 *
 * Mirrors what the codex CLI does: its TUI `/usage` command asks the codex
 * app-server (`account/rateLimits/read`), which in turn calls this HTTPS
 * endpoint with the ChatGPT OAuth tokens from ~/.codex/auth.json:
 *
 *   GET https://chatgpt.com/backend-api/wham/usage
 *   Authorization: Bearer <access_token>
 *   chatgpt-account-id: <account_id>
 *   originator: codex_cli_rs
 *
 * Response (relevant parts):
 *   plan_type: "pro" | ...
 *   rate_limit.primary_window:   weekly window  { used_percent, limit_window_seconds, reset_at }
 *   rate_limit.secondary_window: 5-hour window while active, null otherwise
 *   credits: { has_credits, unlimited, balance }
 */

import type { CodexCredentials } from "../credentials.js";
import type { UsageFetchResult, UsageWindow } from "../types.js";
import { asNumber, asRecord, asString, clampPercent, windowLabel } from "../util.js";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const FETCH_TIMEOUT_MS = 8000;

export async function fetchCodexUsage(credentials: CodexCredentials): Promise<UsageFetchResult> {
  const url = process.env.PI_QUOTA_CODEX_URL ?? CODEX_USAGE_URL;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credentials.accessToken}`,
    Accept: "application/json",
    originator: "codex_cli_rs",
    "User-Agent": "codex_cli_rs/0.144.5 (pi-quota-footer)",
  };
  if (credentials.accountId !== undefined) {
    headers["chatgpt-account-id"] = credentials.accountId;
  }

  let response: Response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (error) {
    return {
      ok: false,
      error: `network: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!response.ok) {
    const authHint =
      response.status === 401 || response.status === 403 ? " (auth expired? try /login)" : "";
    return { ok: false, error: `HTTP ${String(response.status)}${authHint}` };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, error: "invalid JSON response" };
  }
  return parseCodexUsage(payload);
}

export function parseCodexUsage(payload: unknown): UsageFetchResult {
  const root = asRecord(payload);
  if (root === undefined) return { ok: false, error: "unexpected payload shape" };

  // Secondary (5h) window first so it renders before the weekly window.
  const windows: UsageWindow[] = [];
  const rateLimit = asRecord(root.rate_limit);
  for (const key of ["secondary_window", "primary_window"] as const) {
    const window = rateLimit === undefined ? undefined : asRecord(rateLimit[key]);
    if (window === undefined) continue;
    const usedPercent = asNumber(window.used_percent);
    const windowSeconds = asNumber(window.limit_window_seconds);
    if (usedPercent === undefined || windowSeconds === undefined) continue;
    const resetAtSec = asNumber(window.reset_at);
    windows.push({
      label: windowLabel(windowSeconds),
      usedPercent: clampPercent(usedPercent),
      resetAtMs: resetAtSec === undefined ? undefined : resetAtSec * 1000,
    });
  }
  if (windows.length === 0) return { ok: false, error: "no rate-limit windows in payload" };

  const detailLines: string[] = [];
  const plan = asString(root.plan_type);
  if (plan !== undefined) detailLines.push(`plan: ${plan}`);
  const credits = asRecord(root.credits);
  if (credits !== undefined) {
    if (credits.unlimited === true) {
      detailLines.push("credits: unlimited");
    } else {
      const balance = asString(credits.balance);
      if (balance !== undefined) detailLines.push(`credits: ${balance}`);
    }
  }
  if (rateLimit !== undefined && rateLimit.limit_reached === true) {
    detailLines.push("⚠ rate limit reached");
  }

  return { ok: true, snapshot: { windows, detailLines, fetchedAtMs: Date.now() } };
}
