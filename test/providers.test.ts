import assert from "node:assert/strict";
import test from "node:test";
import { parseClaudeCliUsage, parseClaudeUsage } from "../providers/claude.js";
import { parseZaiUsage } from "../providers/zai.js";
import type { UsageFetchResult, UsageOk } from "../types.js";

function expectOk(result: UsageFetchResult): UsageOk {
  if (!result.ok) assert.fail(result.error);
  return result.snapshot;
}

test("parses structured Claude plan and model-scoped windows", () => {
  const result = parseClaudeUsage({
    subscription_type: "max",
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 2, resets_at: "2026-07-18T16:00:00Z" },
      seven_day: { utilization: 3, resets_at: "2026-07-21T16:00:00Z" },
      model_scoped: [{ display_name: "Fable", utilization: 4, resets_at: "2026-07-21T16:00:00Z" }],
    },
  });
  const snapshot = expectOk(result);
  assert.deepEqual(
    snapshot.windows.map(({ label, usedPercent }) => ({ label, usedPercent })),
    [
      { label: "5h", usedPercent: 2 },
      { label: "w", usedPercent: 3 },
      { label: "Fable", usedPercent: 4 },
    ],
  );
});

test("parses zero-token Claude CLI usage fallback", () => {
  const result = parseClaudeCliUsage(
    JSON.stringify({
      result: [
        "Current session: 12% used · resets Jul 18, 7:20pm (Asia/Riyadh)",
        "Current week (all models): 34% used · resets Jul 22, 1am (Asia/Riyadh)",
        "Current week (Fable): 56% used · resets Jul 22, 1am (Asia/Riyadh)",
      ].join("\n"),
    }),
  );
  const snapshot = expectOk(result);
  assert.deepEqual(
    snapshot.windows.map(({ label, usedPercent }) => ({ label, usedPercent })),
    [
      { label: "5h", usedPercent: 12 },
      { label: "w", usedPercent: 34 },
      { label: "Fable", usedPercent: 56 },
    ],
  );
});

test("parses Z.AI model windows and ignores the MCP quota", () => {
  const result = parseZaiUsage({
    success: true,
    code: 200,
    data: {
      limits: [
        { type: "TIME_LIMIT", percentage: 7, unit: 5, number: 1, nextResetTime: 1784966710993 },
        { type: "TOKENS_LIMIT", percentage: 8, unit: 3, number: 5, nextResetTime: 1784389564000 },
        { type: "TOKENS_LIMIT", percentage: 9, unit: 6, number: 1, nextResetTime: 1784534710998 },
      ],
    },
  });
  const snapshot = expectOk(result);
  assert.deepEqual(
    snapshot.windows.map(({ label, usedPercent }) => ({ label, usedPercent })),
    [
      { label: "5h", usedPercent: 8 },
      { label: "w", usedPercent: 9 },
    ],
  );
  assert.equal(snapshot.windows[0]?.resetAtMs, 1784389564000);
});
