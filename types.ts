/**
 * Shared state types for the quota-footer extension.
 */

/** One usage/rate-limit window, e.g. the 5-hour burst window or the weekly window. */
export interface UsageWindow {
  /** Compact label rendered in the footer, e.g. "5h" or "w". */
  label: string;
  /** Usage in percent, clamped to 0–100. */
  usedPercent: number;
  /** Epoch milliseconds when the window resets, if the provider reports it. */
  resetAtMs: number | undefined;
}

/** A successfully fetched provider usage snapshot. */
export interface UsageOk {
  windows: UsageWindow[];
  /** Extra human-readable lines for the /quota details view (plan, membership, credits…). */
  detailLines: string[];
  fetchedAtMs: number;
}

/** Result of a single provider fetch: either a fresh snapshot or an error message. */
export type UsageFetchResult = { ok: true; snapshot: UsageOk } | { ok: false; error: string };

export interface ProviderState {
  /** Whether credentials exist for this provider (in pi or the provider's CLI). */
  configured: boolean;
  /** Last successfully fetched snapshot. Kept across transient errors so the meter never flickers. */
  snapshot: UsageOk | undefined;
  /** Message of the most recent fetch failure; undefined after a success. */
  error: string | undefined;
  /** Why the segment stays hidden although the provider is active in pi (details view only). */
  note: string | undefined;
}

export interface QuotaState {
  codex: ProviderState;
  claude: ProviderState;
  zai: ProviderState;
  kimi: ProviderState;
}

function emptyProviderState(): ProviderState {
  return { configured: false, snapshot: undefined, error: undefined, note: undefined };
}

export function emptyQuotaState(): QuotaState {
  return {
    codex: emptyProviderState(),
    claude: emptyProviderState(),
    zai: emptyProviderState(),
    kimi: emptyProviderState(),
  };
}
