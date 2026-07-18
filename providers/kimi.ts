/**
 * Kimi (Moonshot "Kimi For Coding") usage fetching.
 *
 * Mirrors the kimi CLI (kimi-code), whose bundled source shows:
 *
 *   base = process.env.KIMI_CODE_BASE_URL ?? "https://api.kimi.com/coding/v1"
 *   GET  ${base}/usages
 *   Authorization: Bearer <api key or OAuth access token>
 *   Accept: application/json
 *
 * The CLI labels the top-level `usage` record "Weekly limit" and renders each
 * entry of `limits[]` as an extra window (e.g. the 300-minute burst window).
 * Numeric fields arrive as strings.
 *
 * Response (relevant parts):
 *   usage:  { limit, used, remaining, resetTime }              — weekly quota
 *   limits: [{ window: { duration, timeUnit }, detail: { limit, used, remaining, resetTime } }]
 *   user.membership.level, parallel.limit, totalQuota
 */

import type { UsageFetchResult, UsageWindow } from "../types.js";
import { asNumber, asRecord, asString, clampPercent, parseTimeMs, windowLabel } from "../util.js";

const DEFAULT_KIMI_BASE_URL = "https://api.kimi.com/coding/v1";
const FETCH_TIMEOUT_MS = 8000;

export async function fetchKimiUsage(apiKey: string): Promise<UsageFetchResult> {
  const baseUrl = (process.env.KIMI_CODE_BASE_URL ?? DEFAULT_KIMI_BASE_URL).replace(/\/+$/u, "");

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/usages`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      ok: false,
      error: `network: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!response.ok) {
    const authHint = response.status === 401 ? " (auth failed? try /login)" : "";
    return { ok: false, error: `HTTP ${String(response.status)}${authHint}` };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, error: "invalid JSON response" };
  }
  return parseKimiUsage(payload);
}

function timeUnitSeconds(timeUnit: string | undefined): number | undefined {
  switch (timeUnit) {
    case "TIME_UNIT_SECOND":
      return 1;
    case "TIME_UNIT_MINUTE":
      return 60;
    case "TIME_UNIT_HOUR":
      return 3600;
    case "TIME_UNIT_DAY":
      return 86_400;
    default:
      return undefined;
  }
}

interface RawQuota {
  limit: number;
  used: number;
  resetAtMs: number | undefined;
}

function readQuota(record: Record<string, unknown>): RawQuota | undefined {
  const limit = asNumber(record.limit);
  const used = asNumber(record.used);
  if (limit === undefined || used === undefined || limit <= 0) return undefined;
  return { limit, used, resetAtMs: parseTimeMs(asString(record.resetTime)) };
}

export function parseKimiUsage(payload: unknown): UsageFetchResult {
  const root = asRecord(payload);
  if (root === undefined) return { ok: false, error: "unexpected payload shape" };

  const windows: UsageWindow[] = [];

  // Extra per-window limits first (e.g. the 300-minute burst window), like the CLI.
  const limits = Array.isArray(root.limits) ? root.limits : [];
  for (const item of limits) {
    const entry = asRecord(item);
    if (entry === undefined) continue;
    const detail = asRecord(entry.detail);
    const window = asRecord(entry.window);
    if (detail === undefined || window === undefined) continue;
    const duration = asNumber(window.duration);
    const unitSeconds = timeUnitSeconds(asString(window.timeUnit));
    if (duration === undefined || unitSeconds === undefined) continue;
    const quota = readQuota(detail);
    if (quota === undefined) continue;
    windows.push({
      label: windowLabel(duration * unitSeconds),
      usedPercent: clampPercent((quota.used / quota.limit) * 100),
      resetAtMs: quota.resetAtMs,
    });
  }

  // Main weekly quota — the kimi CLI calls this row "Weekly limit".
  const usage = asRecord(root.usage);
  if (usage !== undefined) {
    const quota = readQuota(usage);
    if (quota !== undefined) {
      windows.push({
        label: "w",
        usedPercent: clampPercent((quota.used / quota.limit) * 100),
        resetAtMs: quota.resetAtMs,
      });
    }
  }
  if (windows.length === 0) return { ok: false, error: "no usage data in payload" };

  const detailLines: string[] = [];
  const user = asRecord(root.user);
  const membership = user === undefined ? undefined : asRecord(user.membership);
  const level = membership === undefined ? undefined : asString(membership.level);
  if (level !== undefined) detailLines.push(`membership: ${level.replace(/^LEVEL_/u, "")}`);
  if (usage !== undefined) {
    const remaining = asNumber(usage.remaining);
    const limit = asNumber(usage.limit);
    if (remaining !== undefined && limit !== undefined) {
      detailLines.push(`weekly quota: ${String(remaining)}/${String(limit)} remaining`);
    }
  }
  const parallel = asRecord(root.parallel);
  const parallelLimit = parallel === undefined ? undefined : asNumber(parallel.limit);
  if (parallelLimit !== undefined) detailLines.push(`parallel sessions: ${String(parallelLimit)}`);

  return { ok: true, snapshot: { windows, detailLines, fetchedAtMs: Date.now() } };
}
