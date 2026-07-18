import type { UsageFetchResult, UsageWindow } from "../types.js";
import { asNumber, asRecord, asString, clampPercent } from "../util.js";

const ZAI_USAGE_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
const FETCH_TIMEOUT_MS = 8000;

type ZaiLimit = {
  type: string | undefined;
  percentage: number | undefined;
  unit: number | undefined;
  number: number | undefined;
  nextResetTime: string | number | undefined;
};

function resetTimeMs(value: unknown): number | undefined {
  const numeric = asNumber(value);
  if (numeric !== undefined) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const text = asString(value);
  if (text === undefined) return undefined;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function tokenWindowLabel(limit: ZaiLimit): string {
  if (limit.unit === 3 && limit.number !== undefined) return `${String(limit.number)}h`;
  if (limit.unit === 6 && limit.number === 1) return "w";
  return "tokens";
}

export async function fetchZaiUsage(apiKey: string): Promise<UsageFetchResult> {
  let response: Response;
  try {
    response = await fetch(process.env.PI_QUOTA_ZAI_URL ?? ZAI_USAGE_URL, {
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
    const authHint = response.status === 401 || response.status === 403 ? " (auth failed?)" : "";
    return { ok: false, error: `HTTP ${String(response.status)}${authHint}` };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, error: "invalid JSON response" };
  }
  return parseZaiUsage(payload);
}

export function parseZaiUsage(payload: unknown): UsageFetchResult {
  const root = asRecord(payload);
  if (root === undefined) return { ok: false, error: "unexpected payload shape" };
  if (root.success !== true || asNumber(root.code) !== 200) {
    return { ok: false, error: asString(root.msg)?.trim() || "API error" };
  }

  const data = asRecord(root.data);
  const limits = Array.isArray(data?.limits) ? data.limits : [];
  const windows: UsageWindow[] = [];
  const detailLines: string[] = [];
  for (const value of limits) {
    const record = asRecord(value);
    if (record === undefined) continue;
    const limit: ZaiLimit = {
      type: asString(record.type),
      percentage: asNumber(record.percentage),
      unit: asNumber(record.unit),
      number: asNumber(record.number),
      nextResetTime: asNumber(record.nextResetTime) ?? asString(record.nextResetTime),
    };
    if (limit.percentage === undefined) continue;
    if (limit.type === "TOKENS_LIMIT") {
      windows.push({
        label: tokenWindowLabel(limit),
        usedPercent: clampPercent(limit.percentage),
        resetAtMs: resetTimeMs(limit.nextResetTime),
      });
    }
  }
  if (windows.length === 0) return { ok: false, error: "no usage limits in payload" };

  const plan = asString(data?.planName) ?? asString(data?.plan);
  if (plan !== undefined) detailLines.unshift(`plan: ${plan}`);
  return { ok: true, snapshot: { windows, detailLines, fetchedAtMs: Date.now() } };
}
