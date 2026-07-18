/**
 * Footer component: a faithful port of pi's built-in footer
 * (dist/modes/interactive/components/footer.js) with one addition — a Codex/Kimi
 * quota segment appended to the stats group, i.e. between the context/cache/cost
 * stats on the left and the model name on the right.
 *
 * The rendering core (renderFooterLines) is pure and takes plain data, so it can
 * be smoke-tested outside the TUI (see scripts/probe.ts). createQuotaFooterComponent
 * is the thin adapter that assembles that data from pi's ExtensionContext.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { QuotaState } from "./types.js";
import { formatResetCompact } from "./util.js";

/** Structural mirror of pi's ReadonlyFooterDataProvider (avoids depending on deep exports). */
export interface FooterDataLike {
  getGitBranch(): string | null;
  getExtensionStatuses(): ReadonlyMap<string, string>;
  getAvailableProviderCount(): number;
  onBranchChange(callback: () => void): () => void;
}

/** Subset of pi's Theme used by the footer. */
export interface FooterStyle {
  fg(color: "dim" | "muted" | "warning" | "error" | "success" | "accent", text: string): string;
  bold(text: string): string;
}

/** Snapshots older than this are rendered dimmed (the poller may be failing). */
export const STALE_AFTER_MS = 15 * 60_000;

/**
 * Auto-compaction state is not exposed to extensions, so we assume pi's default
 * (enabled) for the "(auto)" marker, exactly like a stock pi with default settings.
 */
const AUTO_COMPACT_ENABLED = true;

const MIN_PADDING = 2;

/** Format token counts for compact footer display (ported from pi's footer.js). */
export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

/** Collapse the home directory prefix to `~` (ported from pi's footer.js). */
export function formatCwdForFooter(cwd: string, homeDir: string | undefined): string {
  if (homeDir === undefined || homeDir === "") return cwd;
  if (cwd === homeDir) return "~";
  const prefix = homeDir.endsWith("/") ? homeDir : `${homeDir}/`;
  return cwd.startsWith(prefix) ? `~/${cwd.slice(prefix.length)}` : cwd;
}

/** Strip newlines/tabs so extension statuses stay on one line (ported from pi's footer.js). */
function sanitizeStatusText(text: string): string {
  return text
    .replaceAll(/[\r\n\t]/gu, " ")
    .replaceAll(/ +/gu, " ")
    .trim();
}

function colorByPercent(style: FooterStyle, percent: number, text: string): string {
  if (percent > 90) return style.fg("error", text);
  if (percent > 70) return style.fg("warning", text);
  return style.fg("dim", text);
}

export interface FooterRenderInput {
  width: number;
  cwd: string;
  homeDir: string | undefined;
  branch: string | null;
  sessionName: string | undefined;
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  totalCost: number;
  latestCacheHitRate: number | undefined;
  usingSubscription: boolean;
  contextPercent: number | null;
  contextWindow: number;
  autoCompactEnabled: boolean;
  experimentalEnabled: boolean;
  modelId: string | undefined;
  modelReasoning: boolean;
  modelProvider: string | undefined;
  thinkingLevel: string;
  providerCount: number;
  quota: QuotaState;
  nowMs: number;
  extensionStatuses: ReadonlyMap<string, string>;
}

interface ProviderRenderSpec {
  key: keyof QuotaState;
  name: string;
}

const PROVIDERS: ProviderRenderSpec[] = [
  { key: "codex", name: "Codex" },
  { key: "claude", name: "Claude" },
  { key: "zai", name: "GLM" },
  { key: "kimi", name: "Kimi" },
];

/** Build the quota segment parts, one per configured provider. */
export function quotaFooterParts(quota: QuotaState, nowMs: number, style: FooterStyle): string[] {
  const parts: string[] = [];
  for (const { key, name } of PROVIDERS) {
    const state = quota[key];
    if (!state.configured) continue;
    if (state.snapshot === undefined) {
      // Configured but never fetched successfully.
      parts.push(style.fg("dim", state.error === undefined ? `${name} …` : `${name} !`));
      continue;
    }
    const stale = nowMs - state.snapshot.fetchedAtMs > STALE_AFTER_MS;
    if (stale) {
      const windowText = state.snapshot.windows
        .map((window) => `${window.label}:${String(Math.round(window.usedPercent))}%`)
        .join(" ");
      parts.push(style.fg("dim", `${name} ${windowText}`));
      continue;
    }
    // Percent carries the threshold color; the remaining time stays dim.
    const maxPercent = Math.max(0, ...state.snapshot.windows.map((window) => window.usedPercent));
    const windowText = state.snapshot.windows
      .map((window) => {
        const percent = colorByPercent(
          style,
          maxPercent,
          `${window.label}:${String(Math.round(window.usedPercent))}%`,
        );
        const reset =
          window.resetAtMs === undefined
            ? ""
            : style.fg("dim", `(${formatResetCompact(window.resetAtMs, nowMs)})`);
        return percent + reset;
      })
      .join(" ");
    parts.push(`${style.fg("dim", name)} ${windowText}`);
  }
  return parts;
}

/** Pure footer renderer — mirrors pi's built-in footer layout plus the quota segment. */
export function renderFooterLines(input: FooterRenderInput, style: FooterStyle): string[] {
  // --- Left stats group (tokens, cache, cost, context) -------------------------
  const statsParts: string[] = [];
  if (input.totalInput > 0) statsParts.push(style.fg("dim", `↑${formatTokens(input.totalInput)}`));
  if (input.totalOutput > 0)
    statsParts.push(style.fg("dim", `↓${formatTokens(input.totalOutput)}`));
  if (input.totalCacheRead > 0)
    statsParts.push(style.fg("dim", `R${formatTokens(input.totalCacheRead)}`));
  if (input.totalCacheWrite > 0)
    statsParts.push(style.fg("dim", `W${formatTokens(input.totalCacheWrite)}`));
  if (
    (input.totalCacheRead > 0 || input.totalCacheWrite > 0) &&
    input.latestCacheHitRate !== undefined
  ) {
    statsParts.push(style.fg("dim", `CH${input.latestCacheHitRate.toFixed(1)}%`));
  }
  if (input.totalCost > 0 || input.usingSubscription) {
    const cost = `$${input.totalCost.toFixed(3)}${input.usingSubscription ? " (sub)" : ""}`;
    statsParts.push(style.fg("dim", cost));
  }

  const autoIndicator = input.autoCompactEnabled ? " (auto)" : "";
  const contextDisplay =
    input.contextPercent === null
      ? `?/${formatTokens(input.contextWindow)}${autoIndicator}`
      : `${input.contextPercent.toFixed(1)}%/${formatTokens(input.contextWindow)}${autoIndicator}`;
  statsParts.push(
    input.contextPercent === null
      ? style.fg("dim", contextDisplay)
      : colorByPercent(style, input.contextPercent, contextDisplay),
  );

  if (input.experimentalEnabled) {
    statsParts.push(`${style.fg("dim", "•")} ${style.bold(style.fg("warning", "xp"))}`);
  }

  // --- Quota segment: between the stats above and the model on the right -------
  statsParts.push(...quotaFooterParts(input.quota, input.nowMs, style));

  let statsLeft = statsParts.join(" ");
  let statsLeftWidth = visibleWidth(statsLeft);
  if (statsLeftWidth > input.width) {
    statsLeft = truncateToWidth(statsLeft, input.width, style.fg("dim", "..."));
    statsLeftWidth = visibleWidth(statsLeft);
  }

  // --- Right side: model (+provider, +thinking level) ---------------------------
  const modelName = input.modelId ?? "no-model";
  let rightWithoutProvider = modelName;
  if (input.modelReasoning) {
    rightWithoutProvider =
      input.thinkingLevel === "off"
        ? `${modelName} • thinking off`
        : `${modelName} • ${input.thinkingLevel}`;
  }
  const claudeRuntimeStatus =
    input.modelProvider === "claude-runtime"
      ? input.extensionStatuses.get("claude-runtime")
      : undefined;
  if (claudeRuntimeStatus !== undefined) {
    rightWithoutProvider = `${sanitizeStatusText(claudeRuntimeStatus)} • ${rightWithoutProvider}`;
  }
  let rightSide = rightWithoutProvider;
  if (input.providerCount > 1 && input.modelProvider !== undefined) {
    const withProvider = `(${input.modelProvider}) ${rightWithoutProvider}`;
    if (statsLeftWidth + MIN_PADDING + visibleWidth(withProvider) <= input.width) {
      rightSide = withProvider;
    }
  }

  const rightWidth = visibleWidth(rightSide);
  let statsLine: string;
  if (statsLeftWidth + MIN_PADDING + rightWidth <= input.width) {
    statsLine = statsLeft + " ".repeat(input.width - statsLeftWidth - rightWidth) + rightSide;
  } else {
    const availableForRight = input.width - statsLeftWidth - MIN_PADDING;
    if (availableForRight > 0) {
      const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
      const truncatedWidth = visibleWidth(truncatedRight);
      statsLine =
        statsLeft +
        " ".repeat(Math.max(0, input.width - statsLeftWidth - truncatedWidth)) +
        truncatedRight;
    } else {
      statsLine = statsLeft;
    }
  }
  // Dim the padding + model portion (the stats parts are already styled individually).
  const remainder = statsLine.slice(statsLeft.length);
  statsLine = statsLeft + style.fg("dim", remainder);

  // --- Line 1: pwd (+ branch, + session name) ------------------------------------
  let pwd = formatCwdForFooter(input.cwd, input.homeDir);
  if (input.branch !== null && input.branch !== "") pwd = `${pwd} (${input.branch})`;
  if (input.sessionName !== undefined) pwd = `${pwd} • ${input.sessionName}`;
  const lines = [
    truncateToWidth(style.fg("dim", pwd), input.width, style.fg("dim", "...")),
    statsLine,
  ];

  // --- Line 3 (optional): other extensions' setStatus() texts ---------------------
  const otherStatuses = [...input.extensionStatuses.entries()]
    .filter(([key]) => key !== "claude-runtime" || input.modelProvider !== "claude-runtime")
    .toSorted(([a], [b]) => a.localeCompare(b));
  if (otherStatuses.length > 0) {
    const statusLine = otherStatuses.map(([, text]) => sanitizeStatusText(text)).join(" ");
    lines.push(truncateToWidth(statusLine, input.width, style.fg("dim", "...")));
  }

  return lines;
}

export interface QuotaFooterDeps {
  ctx: ExtensionContext;
  getQuota(): QuotaState;
  getThinkingLevel(): string;
}

/** Adapter component: assembles FooterRenderInput from pi's ExtensionContext. */
export function createQuotaFooterComponent(
  tui: TUI,
  theme: Theme,
  footerData: FooterDataLike,
  deps: QuotaFooterDeps,
): Component & { dispose(): void } {
  const { ctx } = deps;
  const unsubscribe = footerData.onBranchChange(() => {
    tui.requestRender();
  });
  const style: FooterStyle = {
    fg: (color, text) => theme.fg(color, text),
    bold: (text) => theme.bold(text),
  };

  return {
    dispose: unsubscribe,
    invalidate() {},
    render(width: number): string[] {
      try {
        let totalInput = 0;
        let totalOutput = 0;
        let totalCacheRead = 0;
        let totalCacheWrite = 0;
        let totalCost = 0;
        let latestCacheHitRate: number | undefined;
        for (const entry of ctx.sessionManager.getEntries()) {
          if (entry.type !== "message") continue;
          const message = entry.message;
          if (message.role !== "assistant") continue;
          totalInput += message.usage.input;
          totalOutput += message.usage.output;
          totalCacheRead += message.usage.cacheRead;
          totalCacheWrite += message.usage.cacheWrite;
          totalCost += message.usage.cost.total;
          const promptTokens =
            message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
          latestCacheHitRate =
            promptTokens > 0 ? (message.usage.cacheRead / promptTokens) * 100 : undefined;
        }

        const contextUsage = ctx.getContextUsage();
        const model = ctx.model;
        const sessionName = ctx.sessionManager.getSessionName();

        return renderFooterLines(
          {
            width,
            cwd: ctx.cwd,
            homeDir: process.env.HOME ?? process.env.USERPROFILE,
            branch: footerData.getGitBranch(),
            sessionName,
            totalInput,
            totalOutput,
            totalCacheRead,
            totalCacheWrite,
            totalCost,
            latestCacheHitRate,
            usingSubscription: model !== undefined && ctx.modelRegistry.isUsingOAuth(model),
            contextPercent: contextUsage?.percent ?? null,
            contextWindow: contextUsage?.contextWindow ?? model?.contextWindow ?? 0,
            autoCompactEnabled: AUTO_COMPACT_ENABLED,
            experimentalEnabled: process.env.PI_EXPERIMENTAL === "1",
            modelId: model?.id,
            modelReasoning: model?.reasoning ?? false,
            modelProvider: model?.provider,
            thinkingLevel: deps.getThinkingLevel(),
            providerCount: footerData.getAvailableProviderCount(),
            quota: deps.getQuota(),
            nowMs: Date.now(),
            extensionStatuses: footerData.getExtensionStatuses(),
          },
          style,
        );
      } catch (error) {
        // Never break the footer — fall back to a minimal line.
        const message = error instanceof Error ? error.message : String(error);
        return [theme.fg("error", `quota-footer error: ${message}`)];
      }
    },
  };
}
