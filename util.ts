/**
 * Small parsing and formatting helpers shared by the provider fetchers.
 */

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/** Compact footer label for a window length: "5h", "24h", "3d", "w". */
export function windowLabel(windowSeconds: number): string {
  const hours = Math.round(windowSeconds / 3600);
  if (hours <= 5) return "5h";
  if (hours >= 24 * 7) return "w";
  if (hours >= 24) return `${Math.round(hours / 24)}d`;
  return `${String(hours)}h`;
}

/** Parse an ISO timestamp to epoch ms, returning undefined on failure. */
export function parseTimeMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Human-friendly "in how long" text, e.g. "2d 3h", "5h 12m", "42m". */
export function formatResetIn(resetAtMs: number, nowMs: number): string {
  const deltaMs = resetAtMs - nowMs;
  if (deltaMs <= 0) return "now";
  const minutes = Math.floor(deltaMs / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${String(days)}d ${String(hours % 24)}h`;
  if (hours > 0) return `${String(hours)}h ${String(minutes % 60)}m`;
  return `${String(Math.max(1, minutes))}m`;
}

/** Compact single-unit remaining time for the footer: "6d", "13h", "45m". */
export function formatResetCompact(resetAtMs: number, nowMs: number): string {
  const deltaMs = resetAtMs - nowMs;
  if (deltaMs <= 0) return "0m";
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes >= 24 * 60) return `${String(Math.floor(minutes / (24 * 60)))}d`;
  if (minutes >= 60) return `${String(Math.floor(minutes / 60))}h`;
  return `${String(Math.max(1, minutes))}m`;
}
