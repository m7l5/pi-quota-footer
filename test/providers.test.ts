import assert from "node:assert/strict";
import test from "node:test";
import { parseAlibabaSubscriptionDetails, parseAlibabaUsage } from "../providers/alibaba.js";
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

test("parses Alibaba/Bailian Token Plan 5h and weekly windows", () => {
  const result = parseAlibabaUsage({
    data: {
      DataV2: {
        data: {
          data: {
            per5HourPercentage: 0.0625,
            per5HourResetTime: 1_784_475_240_000,
            per1WeekPercentage: 0.03125,
            per1WeekResetTime: 1_785_062_040_000,
          },
          success: true,
        },
      },
    },
  });
  const snapshot = expectOk(result);
  assert.deepEqual(
    snapshot.windows.map(({ label, usedPercent }) => ({ label, usedPercent })),
    [
      { label: "5h", usedPercent: 6.25 },
      { label: "w", usedPercent: 3.125 },
    ],
  );
  assert.equal(snapshot.windows[0]?.resetAtMs, 1_784_475_240_000);
  assert.equal(snapshot.windows[1]?.resetAtMs, 1_785_062_040_000);
});

test("Alibaba usage parser errors when no Token Plan data is present", () => {
  assert.equal(parseAlibabaUsage({ data: { DataV2: { data: { data: {} } } } }).ok, false);
  assert.equal(parseAlibabaUsage({}).ok, false);
});

test("parses Alibaba/Bailian subscription detail lines", () => {
  const endTime = 1_787_155_200_000;
  const lines = parseAlibabaSubscriptionDetails({
    data: {
      DataV2: {
        data: {
          data: {
            specCode: "standard",
            status: "VALID",
            remainingDays: 31,
            endTime,
            autoRenewFlag: false,
          },
        },
      },
    },
  });
  assert.deepEqual(lines, [
    "plan: standard · VALID",
    "days left: 31",
    `renews: ${new Date(endTime).toISOString().slice(0, 10)}`,
    "auto-renew: off",
  ]);
});
