import assert from "node:assert/strict";
import test from "node:test";
import { renderFooterLines, type FooterRenderInput, type FooterStyle } from "../footer.js";
import { emptyQuotaState } from "../types.js";

const style: FooterStyle = { fg: (_color, text) => text, bold: (text) => text };

test("renders Claude Runtime status inline without an extra status line", () => {
  const input: FooterRenderInput = {
    width: 180,
    cwd: "/tmp",
    homeDir: "/home/test",
    branch: null,
    sessionName: undefined,
    totalInput: 0,
    totalOutput: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
    totalCost: 0,
    latestCacheHitRate: undefined,
    usingSubscription: true,
    contextPercent: 10,
    contextWindow: 200_000,
    autoCompactEnabled: true,
    experimentalEnabled: false,
    modelId: "claude-sonnet-4-6",
    modelReasoning: true,
    modelProvider: "claude-runtime",
    thinkingLevel: "high",
    providerCount: 4,
    quota: emptyQuotaState(),
    nowMs: Date.now(),
    extensionStatuses: new Map([["claude-runtime", "Claude: idle • CLI 2.1.214 ✓"]]),
  };
  const lines = renderFooterLines(input, style);
  assert.equal(lines.length, 2);
  assert.match(lines[1]!, /Claude: idle • CLI 2\.1\.214 ✓/u);
});

// --- Responsive layout: degrade-then-wrap width matrix -------------------------

import { visibleWidth } from "@earendil-works/pi-tui";

const NOW = 1_784_500_000_000;

function responsiveQuota() {
  const quota = emptyQuotaState();
  quota.codex = {
    configured: true,
    error: undefined,
    note: undefined,
    snapshot: {
      windows: [
        { label: "5h", usedPercent: 34, resetAtMs: NOW + 2 * 3_600_000 },
        { label: "w", usedPercent: 12, resetAtMs: NOW + 3 * 86_400_000 },
      ],
      detailLines: [],
      fetchedAtMs: NOW,
    },
  };
  quota.claude = {
    configured: true,
    error: undefined,
    note: undefined,
    snapshot: {
      windows: [
        { label: "5h", usedPercent: 71, resetAtMs: NOW + 90 * 60_000 },
        { label: "w", usedPercent: 45, resetAtMs: undefined },
      ],
      detailLines: [],
      fetchedAtMs: NOW,
    },
  };
  return quota;
}

function responsiveInput(width: number): FooterRenderInput {
  return {
    width,
    cwd: "/home/test/code/x",
    homeDir: "/home/test",
    branch: "main",
    sessionName: undefined,
    totalInput: 12_400,
    totalOutput: 3_100,
    totalCacheRead: 80_000,
    totalCacheWrite: 9_000,
    totalCost: 0.412,
    latestCacheHitRate: 89.9,
    usingSubscription: true,
    contextPercent: 42.3,
    contextWindow: 1_000_000,
    autoCompactEnabled: true,
    experimentalEnabled: false,
    modelId: "claude-fable-5",
    modelReasoning: true,
    modelProvider: "claude-runtime",
    thinkingLevel: "xhigh",
    providerCount: 4,
    quota: responsiveQuota(),
    nowMs: NOW,
    extensionStatuses: new Map([["claude-runtime", "Claude: idle • CLI 2.4.1 ✓"]]),
  };
}

test("wide window renders full quota detail inline", () => {
  const lines = renderFooterLines(responsiveInput(200), style);
  assert.equal(lines.length, 2);
  assert.ok(lines[1]!.includes("Codex 5h:34%(2h) w:12%(3d)"));
  assert.ok(lines[1]!.includes("claude-fable-5"));
});

test("moderate squeeze drops reset times, then window labels, still inline", () => {
  const noResets = renderFooterLines(responsiveInput(160), style);
  assert.equal(noResets.length, 2);
  assert.ok(noResets[1]!.includes("Codex 5h:34% w:12%"));
  assert.ok(!noResets[1]!.includes("(2h)"));

  const worstOnly = renderFooterLines(responsiveInput(140), style);
  assert.equal(worstOnly.length, 2);
  assert.ok(worstOnly[1]!.includes("Codex 34% Claude 71%"));
  assert.ok(!worstOnly[1]!.includes("5h:"));
});

test("narrow window wraps quota to its own line and regains full detail", () => {
  const lines = renderFooterLines(responsiveInput(120), style);
  assert.equal(lines.length, 3);
  assert.ok(!lines[1]!.includes("Codex"));
  assert.ok(lines[1]!.includes("claude-fable-5"));
  assert.equal(lines[2], "Codex 5h:34%(2h) w:12%(3d) Claude 5h:71%(1h) w:45%");
});

test("the wrapped quota line degrades before truncating and drops when tiny", () => {
  const noResets = renderFooterLines(responsiveInput(40), style);
  assert.equal(noResets[2], "Codex 5h:34% w:12% Claude 5h:71% w:45%");

  const worstOnly = renderFooterLines(responsiveInput(25), style);
  assert.equal(worstOnly[2], "Codex 34% Claude 71%");

  const dropped = renderFooterLines(responsiveInput(14), style);
  assert.equal(dropped.length, 2);
});

test("no rendered line ever exceeds the terminal width", () => {
  for (const width of [220, 200, 160, 140, 120, 100, 80, 60, 40, 25, 20, 14, 10]) {
    for (const line of renderFooterLines(responsiveInput(width), style)) {
      assert.ok(
        visibleWidth(line) <= width,
        `width ${String(width)}: line overflows (${String(visibleWidth(line))}): ${line}`,
      );
    }
  }
});

test("extension statuses wrap between entries instead of truncating", () => {
  const input = responsiveInput(40);
  input.modelProvider = "anthropic";
  input.extensionStatuses = new Map([
    ["a-ext", "first status segment here"],
    ["b-ext", "second status segment here"],
  ]);
  const lines = renderFooterLines(input, style);
  const statusLines = lines.slice(3);
  assert.equal(statusLines.length, 2);
  assert.equal(statusLines[0], "first status segment here");
  assert.equal(statusLines[1], "second status segment here");
});
