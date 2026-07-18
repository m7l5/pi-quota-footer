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
