/**
 * quota-footer — Codex, Claude, GLM, and Kimi usage quotas in pi's footer.
 *
 * Renders a compact quota segment between the session stats (tokens, cache hit,
 * cost, context %) and the model name, e.g.:
 *
 *   ↑12k ↓3k R1.2M CH78% $0.412 41.2%/200k (auto) Codex 5h:3% w:12% · Kimi w:21%   (kimi-coding) k3 • high
 *
 * Data is refreshed on session start, after each agent run, and every 5 minutes.
 * Commands:
 *   /quota         force a refresh and show detailed quota info
 *   /quota-footer  toggle between this footer and pi's built-in footer
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createQuotaFooterComponent } from "./footer.js";
import { collectQuotas, formatQuotaDetails } from "./quota.js";
import type { QuotaState } from "./types.js";
import { emptyQuotaState } from "./types.js";

const REFRESH_INTERVAL_MS = 5 * 60_000;
/** Minimum gap between automatic refreshes (agent runs can settle in bursts). */
const MIN_REFRESH_GAP_MS = 30_000;

export default function quotaFooter(pi: ExtensionAPI): void {
  let quota: QuotaState = emptyQuotaState();
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let lastRefreshAtMs = 0;
  let refreshInFlight = false;
  let requestRender: (() => void) | undefined;
  let footerEnabled = true;

  async function refresh(ctx: ExtensionContext, options?: { force?: boolean }): Promise<void> {
    if (refreshInFlight) return;
    const force = options?.force ?? false;
    if (!force && Date.now() - lastRefreshAtMs < MIN_REFRESH_GAP_MS) return;
    refreshInFlight = true;
    lastRefreshAtMs = Date.now();
    try {
      quota = await collectQuotas(ctx, quota);
      requestRender?.();
    } finally {
      refreshInFlight = false;
    }
  }

  function installFooter(ctx: ExtensionContext): void {
    ctx.ui.setFooter((tui, theme, footerData) => {
      requestRender = () => {
        tui.requestRender();
      };
      return createQuotaFooterComponent(tui, theme, footerData, {
        ctx,
        getQuota: () => quota,
        getThinkingLevel: () => pi.getThinkingLevel(),
      });
    });
  }

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    if (footerEnabled) installFooter(ctx);
    // Fire-and-forget: never block session startup on network calls.
    void refresh(ctx, { force: true });
    refreshTimer = setInterval(() => {
      void refresh(ctx);
    }, REFRESH_INTERVAL_MS);
    refreshTimer.unref();
  });

  pi.on("agent_settled", (_event, ctx) => {
    // pi itself burns Codex/Kimi quota while working — keep the meter live.
    if (ctx.mode === "tui") void refresh(ctx);
  });

  pi.on("session_shutdown", () => {
    if (refreshTimer !== undefined) {
      clearInterval(refreshTimer);
      refreshTimer = undefined;
    }
    requestRender = undefined;
  });

  pi.registerCommand("quota", {
    description: "Refresh provider usage quotas and show details",
    handler: async (_args, ctx) => {
      await refresh(ctx, { force: true });
      ctx.ui.notify(formatQuotaDetails(quota, Date.now()), "info");
    },
  });

  pi.registerCommand("quota-footer", {
    description: "Toggle between the quota footer and pi's built-in footer",
    handler: async (_args, ctx) => {
      footerEnabled = !footerEnabled;
      if (footerEnabled) {
        installFooter(ctx);
        await refresh(ctx, { force: true });
        ctx.ui.notify("Quota footer enabled", "info");
      } else {
        ctx.ui.setFooter(undefined);
        ctx.ui.notify("Built-in footer restored", "info");
      }
    },
  });
}
