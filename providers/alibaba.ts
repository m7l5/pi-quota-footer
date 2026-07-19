/**
 * Alibaba Cloud Model Studio (Bailian / Qwen) Token Plan usage fetching.
 *
 * Calls the Bailian *console gateway* directly over HTTP — no dependency on the
 * `bailian-cli` (`bl`) binary at runtime. The request shape, gateway hosts, and
 * response parsing below are reverse-engineered from the installed
 * `bailian-cli` source and the Model Studio console web app.
 *
 *   gateway host/action by (region, site):
 *     cn-beijing/domestic       bailian-cs.console.aliyun.com         BroadScopeAspnGateway
 *     cn-beijing/international  bailian-cs.console.alibabacloud.com   BroadScopeAspnGateway
 *     ap-southeast-1/domestic   modelstudio-cs.console.aliyun.com     IntlBroadScopeAspnGateway
 *     ap-southeast-1/intl       bailian-singapore-cs.alibabacloud.com IntlBroadScopeAspnGateway
 *
 *   POST https://<csGateway>/cli/api.json?action=<action>&product=sfm_bailian&api=<api>
 *   Content-Type: application/x-www-form-urlencoded
 *   Authorization: Bearer <console access_token>
 *   body: params=<JSON>&region=<region>
 *     JSON = { Api, V: "1.0", Data: { ...request,
 *              cornerstoneParam: { protocol: "V2", console: "ONE_CONSOLE",
 *                productCode: "p_efm", switchUserType: 3,
 *                consoleSite: "BAILIAN_ALIYUN", [switchAgent] } } }
 *
 *   Token Plan usage (the quota the console "plan" page shows):
 *     api  = zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage
 *     data = {}   // no request fields required
 *     response data.DataV2.data.data:
 *       { per5HourPercentage, per5HourResetTime, per1WeekPercentage, per1WeekResetTime }
 *     Percentages are 0–1 fractions; reset times are epoch ms. Mapped to a
 *     5-hour window ("5h") and a weekly window ("w"), like Claude/Codex.
 *
 *   Token Plan subscription (plan metadata for the /quota details view):
 *     api  = zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/subscription
 *     response data.DataV2.data.data:
 *       { specCode, status, remainingDays, endTime, autoRenewFlag, ... }
 *
 * The console access_token is provisioned once via `bl auth login --console`
 * and stored in ~/.bailian/config.json (dir overridable with BAILIAN_CONFIG_DIR).
 * The active profile name lives under the "active_config" key; the default
 * profile's fields sit at the top level, named profiles are nested objects.
 * The stored console_region/console_site select the gateway; both can be
 * overridden with PI_BAILIAN_CONSOLE_REGION / PI_BAILIAN_CONSOLE_SITE (useful
 * for international accounts whose region the browser login may not persist).
 * The token is never logged or rendered.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UsageFetchResult, UsageWindow } from "../types.js";
import { asNumber, asRecord, asString, clampPercent } from "../util.js";

const FETCH_TIMEOUT_MS = 15_000;
const ACTIVE_CONFIG_KEY = "active_config";
const API_TOKEN_PLAN_USAGE = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage";
const API_TOKEN_PLAN_SUBSCRIPTION = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/subscription";

interface Gateway {
  csGateway: string;
  action: string;
}

interface SiteMap {
  domestic: Gateway;
  international: Gateway;
}

const DEFAULT_SITE_MAP: SiteMap = {
  domestic: { csGateway: "bailian-cs.console.aliyun.com", action: "BroadScopeAspnGateway" },
  international: {
    csGateway: "bailian-cs.console.alibabacloud.com",
    action: "BroadScopeAspnGateway",
  },
};

const GATEWAYS: Record<string, SiteMap> = {
  "cn-beijing": DEFAULT_SITE_MAP,
  "ap-southeast-1": {
    domestic: {
      csGateway: "modelstudio-cs.console.aliyun.com",
      action: "IntlBroadScopeAspnGateway",
    },
    international: {
      csGateway: "bailian-singapore-cs.alibabacloud.com",
      action: "IntlBroadScopeAspnGateway",
    },
  },
};

function resolveGateway(region: string, site: string): Gateway {
  const bySite = GATEWAYS[region] ?? DEFAULT_SITE_MAP;
  return site === "international" ? bySite.international : bySite.domestic;
}

export interface BailianConsoleIdentity {
  token: string;
  region: string;
  site: string;
  switchAgent: number | undefined;
}

function bailianConfigPath(): string {
  const dir = process.env.BAILIAN_CONFIG_DIR ?? join(homedir(), ".bailian");
  return join(dir, "config.json");
}

/**
 * Read the Bailian console credential (access_token + region + site) from the
 * active profile in ~/.bailian/config.json. Returns undefined when the file or
 * the console token is absent (i.e. `bl auth login --console` has not been run).
 */
export async function readBailianConsoleIdentity(): Promise<BailianConsoleIdentity | undefined> {
  let config: Record<string, unknown> | undefined;
  try {
    config = asRecord(JSON.parse(await readFile(bailianConfigPath(), "utf8")));
  } catch {
    return undefined;
  }
  if (config === undefined) return undefined;

  // Resolve the active profile: a named nested object when active_config points
  // to one, otherwise the top-level (default) profile.
  const activeName = asString(config[ACTIVE_CONFIG_KEY]) ?? "default";
  const named = activeName === "default" ? undefined : asRecord(config[activeName]);
  const profile = named ?? config;

  const token = asString(profile.access_token)?.trim();
  if (token === undefined || token === "") return undefined;

  const region =
    process.env.PI_BAILIAN_CONSOLE_REGION ?? asString(profile.console_region) ?? "cn-beijing";
  const site = process.env.PI_BAILIAN_CONSOLE_SITE ?? asString(profile.console_site) ?? "domestic";
  const switchAgent = asNumber(profile.console_switch_agent);
  return { token, region, site, switchAgent };
}

function buildParamsJson(
  api: string,
  data: Record<string, unknown>,
  switchAgent: number | undefined,
): string {
  return JSON.stringify({
    Api: api,
    V: "1.0",
    Data: {
      ...data,
      cornerstoneParam: {
        protocol: "V2",
        console: "ONE_CONSOLE",
        productCode: "p_efm",
        switchUserType: 3,
        consoleSite: "BAILIAN_ALIYUN",
        ...(switchAgent === undefined ? {} : { switchAgent }),
      },
    },
  });
}

type GatewayResult = { ok: true; payload: unknown } | { ok: false; error: string };

async function consoleGatewayCall(
  identity: BailianConsoleIdentity,
  api: string,
  data: Record<string, unknown>,
): Promise<GatewayResult> {
  const gateway = resolveGateway(identity.region, identity.site);
  const url = `https://${gateway.csGateway}/cli/api.json?action=${gateway.action}&product=sfm_bailian&api=${encodeURIComponent(api)}`;
  const body = new URLSearchParams({
    params: buildParamsJson(api, data, identity.switchAgent),
    region: identity.region,
  });

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "*/*",
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${identity.token}`,
      },
      body: body.toString(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      ok: false,
      error: `network: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return {
      ok: false,
      error: `HTTP ${String(response.status)}${text === "" ? "" : `: ${text.slice(0, 200)}`}`,
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, error: "invalid JSON response" };
  }

  // The gateway reports failures inside an HTTP 200 body — either at the outer
  // `data` level (e.g. NotLogined) or nested under `data.DataV2.data` (business
  // errors such as invalid parameters).
  const outer = asRecord(asRecord(payload)?.data);
  if (outer?.success === false && outer.errorCode !== undefined) {
    const code = asString(outer.errorCode) ?? JSON.stringify(outer.errorCode);
    if (code.includes("NotLogined")) {
      return { ok: false, error: "console session expired — run `bl auth login --console`" };
    }
    return { ok: false, error: `console gateway error: ${code}` };
  }
  const inner = asRecord(asRecord(outer?.DataV2)?.data);
  if (inner?.success === false) {
    const message = asString(inner.message) ?? asString(inner.code) ?? "unknown error";
    return { ok: false, error: `console gateway error: ${message}` };
  }
  return { ok: true, payload };
}

/**
 * Mirror the CLI's response unwrap: the real payload sits at
 * data.DataV2.data.data (or .DataV2.data, or .DataV2) when DataV2 is present,
 * otherwise at data.data (or data).
 */
function unwrapPayload(payload: unknown): Record<string, unknown> | undefined {
  const data = asRecord(asRecord(payload)?.data);
  if (data === undefined) return undefined;
  const dataV2 = asRecord(data.DataV2);
  if (dataV2 !== undefined) {
    const inner = asRecord(dataV2.data);
    return asRecord(inner?.data) ?? inner ?? dataV2;
  }
  return asRecord(data.data) ?? data;
}

/**
 * The Token Plan usage API reports two rolling rate-limit windows as 0–1
 * fractions with epoch-ms reset times — the same shape as Claude/Codex quotas.
 */
function addTokenPlanWindow(
  windows: UsageWindow[],
  label: string,
  fraction: unknown,
  resetAtMs: unknown,
): void {
  const used = asNumber(fraction);
  if (used === undefined) return;
  const reset = asNumber(resetAtMs);
  windows.push({
    label,
    usedPercent: clampPercent(used * 100),
    resetAtMs: reset !== undefined && reset > 0 ? reset : undefined,
  });
}

export function parseAlibabaUsage(payload: unknown): UsageFetchResult {
  const data = unwrapPayload(payload);
  if (data === undefined) return { ok: false, error: "unexpected payload shape" };

  const windows: UsageWindow[] = [];
  addTokenPlanWindow(windows, "5h", data.per5HourPercentage, data.per5HourResetTime);
  addTokenPlanWindow(windows, "w", data.per1WeekPercentage, data.per1WeekResetTime);
  if (windows.length === 0) return { ok: false, error: "no Token Plan usage data" };

  return { ok: true, snapshot: { windows, detailLines: [], fetchedAtMs: Date.now() } };
}

/** Plan metadata for the /quota details view (best-effort, separate endpoint). */
export function parseAlibabaSubscriptionDetails(payload: unknown): string[] {
  const data = unwrapPayload(payload);
  if (data === undefined) return [];

  const lines: string[] = [];
  const spec = asString(data.specCode);
  const status = asString(data.status);
  if (spec !== undefined || status !== undefined) {
    lines.push(`plan: ${[spec, status].filter((part) => part !== undefined).join(" · ")}`);
  }
  const remainingDays = asNumber(data.remainingDays);
  if (remainingDays !== undefined) lines.push(`days left: ${String(remainingDays)}`);
  const endTime = asNumber(data.endTime);
  if (endTime !== undefined && endTime > 0) {
    lines.push(`renews: ${new Date(endTime).toISOString().slice(0, 10)}`);
  }
  if (typeof data.autoRenewFlag === "boolean") {
    lines.push(`auto-renew: ${data.autoRenewFlag ? "on" : "off"}`);
  }
  return lines;
}

export async function fetchAlibabaUsage(
  identity: BailianConsoleIdentity,
): Promise<UsageFetchResult> {
  const [usageResult, subscriptionResult] = await Promise.all([
    consoleGatewayCall(identity, API_TOKEN_PLAN_USAGE, {}),
    consoleGatewayCall(identity, API_TOKEN_PLAN_SUBSCRIPTION, {}),
  ]);
  if (!usageResult.ok) return usageResult;

  const usage = parseAlibabaUsage(usageResult.payload);
  if (!usage.ok) return usage;

  const detailLines = subscriptionResult.ok
    ? parseAlibabaSubscriptionDetails(subscriptionResult.payload)
    : [];
  return {
    ok: true,
    snapshot: {
      windows: usage.snapshot.windows,
      detailLines,
      fetchedAtMs: usage.snapshot.fetchedAtMs,
    },
  };
}
