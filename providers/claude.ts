import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { query, type SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import type { UsageFetchResult, UsageWindow } from "../types.js";
import { asNumber, asRecord, asString, clampPercent } from "../util.js";

const execFileAsync = promisify(execFile);
const FETCH_TIMEOUT_MS = 15_000;

function resetTimeMs(value: unknown): number | undefined {
  const text = asString(value);
  if (text === undefined) return undefined;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function addWindow(windows: UsageWindow[], label: string, value: unknown): void {
  const record = asRecord(value);
  const utilization = asNumber(record?.utilization);
  if (utilization === undefined) return;
  windows.push({
    label,
    usedPercent: clampPercent(utilization),
    resetAtMs: resetTimeMs(record?.resets_at),
  });
}

export function parseClaudeUsage(payload: unknown): UsageFetchResult {
  const root = asRecord(payload);
  const rateLimits = asRecord(root?.rate_limits);
  if (root === undefined || root.rate_limits_available !== true || rateLimits === undefined) {
    return { ok: false, error: "Claude plan rate limits are unavailable for this login" };
  }

  const windows: UsageWindow[] = [];
  addWindow(windows, "5h", rateLimits.five_hour);
  addWindow(windows, "w", rateLimits.seven_day);
  addWindow(windows, "apps", rateLimits.seven_day_oauth_apps);
  addWindow(windows, "Opus", rateLimits.seven_day_opus);
  addWindow(windows, "Sonnet", rateLimits.seven_day_sonnet);

  const existingLabels = new Set(windows.map((window) => window.label.toLowerCase()));
  const modelScoped = Array.isArray(rateLimits.model_scoped) ? rateLimits.model_scoped : [];
  for (const value of modelScoped) {
    const record = asRecord(value);
    const name = asString(record?.display_name);
    const utilization = asNumber(record?.utilization);
    if (name === undefined || utilization === undefined || existingLabels.has(name.toLowerCase())) {
      continue;
    }
    windows.push({
      label: name,
      usedPercent: clampPercent(utilization),
      resetAtMs: resetTimeMs(record?.resets_at),
    });
    existingLabels.add(name.toLowerCase());
  }
  if (windows.length === 0) return { ok: false, error: "no Claude rate-limit windows found" };

  const detailLines: string[] = [];
  const subscription = asString(root.subscription_type);
  if (subscription !== undefined) detailLines.push(`subscription: ${subscription}`);
  const extra = asRecord(rateLimits.extra_usage);
  if (extra?.is_enabled === true) {
    const used = asNumber(extra.used_credits);
    const limit = asNumber(extra.monthly_limit);
    if (used !== undefined && limit !== undefined) {
      detailLines.push(`extra usage: ${String(used)}/${String(limit)}`);
    } else {
      detailLines.push("extra usage: enabled");
    }
  }
  return { ok: true, snapshot: { windows, detailLines, fetchedAtMs: Date.now() } };
}

function parseCliReset(value: string): number | undefined {
  const withoutZone = value.replace(/\s*\([^)]*\)\s*$/u, "").trim();
  const parsed = Date.parse(withoutZone);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseClaudeCliUsage(output: string): UsageFetchResult {
  let text = output;
  try {
    const payload = JSON.parse(output) as unknown;
    const record = asRecord(payload);
    text = asString(record?.result) ?? output;
  } catch {
    // Claude may emit the formatted /usage text directly in older versions.
  }

  const windows: UsageWindow[] = [];
  const linePattern =
    /^Current (session|week \(([^)]+)\)):\s*([\d.]+)% used(?:\s*·\s*resets\s+(.+))?$/gmu;
  for (const match of text.matchAll(linePattern)) {
    const scope = match[1];
    const detail = match[2];
    const percent = Number(match[3]);
    if (!Number.isFinite(percent)) continue;
    const label = scope === "session" ? "5h" : detail === "all models" ? "w" : (detail ?? "w");
    windows.push({
      label,
      usedPercent: clampPercent(percent),
      resetAtMs: match[4] ? parseCliReset(match[4]) : undefined,
    });
  }
  if (windows.length === 0) return { ok: false, error: "could not parse Claude Code /usage" };
  return { ok: true, snapshot: { windows, detailLines: [], fetchedAtMs: Date.now() } };
}

async function fetchStructuredUsage(): Promise<UsageFetchResult> {
  const abortController = new AbortController();
  const idlePrompt = (async function* () {
    await new Promise<void>(() => {});
    yield undefined as never;
  })();
  const sdkQuery = query({
    prompt: idlePrompt,
    options: {
      cwd: process.cwd(),
      tools: [],
      settingSources: [],
      persistSession: false,
      abortController,
    },
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const usage = await Promise.race([
      sdkQuery.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Claude usage request timed out")),
          FETCH_TIMEOUT_MS,
        );
      }),
    ]);
    return parseClaudeUsage(usage satisfies SDKControlGetUsageResponse);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    sdkQuery.close();
    abortController.abort();
  }
}

async function fetchCliUsage(binary: string): Promise<UsageFetchResult> {
  try {
    const { stdout } = await execFileAsync(
      binary,
      [
        "-p",
        "/usage",
        "--output-format",
        "json",
        "--tools",
        "",
        "--setting-sources",
        "",
        "--no-session-persistence",
      ],
      { timeout: FETCH_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 },
    );
    return parseClaudeCliUsage(stdout);
  } catch (error) {
    return {
      ok: false,
      error: `Claude CLI: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function isClaudeCodeLoggedIn(binary: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(binary, ["auth", "status", "--json"], {
      timeout: 5000,
      maxBuffer: 256 * 1024,
    });
    const status = asRecord(JSON.parse(stdout));
    return status?.loggedIn === true && asString(status.authMethod) === "claude.ai";
  } catch {
    return false;
  }
}

export async function fetchClaudeUsage(binary: string): Promise<UsageFetchResult> {
  const structured = await fetchStructuredUsage();
  if (structured.ok) return structured;
  const cli = await fetchCliUsage(binary);
  return cli.ok ? cli : { ok: false, error: `${structured.error}; ${cli.error}` };
}
