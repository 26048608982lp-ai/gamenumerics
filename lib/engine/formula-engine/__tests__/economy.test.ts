import { describe, it, expect } from "vitest";
import { computeEconomyFromIntent, computeDailyBudget } from "../economy";
import { computeFromIntent } from "../index";
import { parseFeatureKeys } from "@/lib/api/parse-feature-keys";
import type { EconomyDesignIntent } from "../types";
import type { EconomyComputeResult, DailyBudgetRow } from "../economy";

/** stage3 停写 resourceBalanceTable 后：断言取正式键 dailyBudgetTable 的具名行类型 */
function balanceRows(result: EconomyComputeResult): DailyBudgetRow[] {
  return (result.dailyBudgetTable ?? []) as DailyBudgetRow[];
}

function makeEconomyIntent(overrides?: Partial<EconomyDesignIntent>): EconomyDesignIntent {
  return {
    moduleType: "economy",
    decisions: {
      resourceComplexity: "moderate",
      resourceCount: 4,
      rationale: "Moderate resource complexity for balanced economy",
    },
    strategy: {
      resourceTypes: [
        { id: "gold", name: "金币", isPremium: false, sinks: ["upgrade"], sources: ["quest"] },
        { id: "gem", name: "宝石", isPremium: true, sinks: ["gacha"], sources: ["shop"] },
      ],
      itemTypes: [
        { id: "sword_01", name: "铁剑", rarity: "common", primarySource: "quest" },
      ],
    },
    consumptionSplit: {
      progression: 0.4,
      gacha: 0.3,
      social: 0.2,
      other: 0.1,
    },
    anchors: {
      dailyBudget: { gold: [200, 800], gem: [10, 50] },
      productionConsumptionRatio: { gold: 1.2, gem: 1.0 },
    },
    ...overrides,
  };
}

describe("computeEconomyFromIntent", () => {
  it("generates resource balance table for all resource types", () => {
    const result = computeEconomyFromIntent(makeEconomyIntent());
    expect(balanceRows(result).length).toBe(2);
    expect(balanceRows(result).map((r) => r.resourceId)).toEqual(["gold", "gem"]);
  });

  it("daily production average is midpoint of budget range", () => {
    const result = computeEconomyFromIntent(makeEconomyIntent());
    const gold = balanceRows(result).find((r) => r.resourceId === "gold")!;
    expect(gold.dailyProductionAverage).toBe(500);
    expect(gold.dailyProductionCasual).toBe(200);
    expect(gold.dailyProductionHardcore).toBe(800);
  });

  it("consumption is production / ratio", () => {
    const result = computeEconomyFromIntent(makeEconomyIntent());
    const gold = balanceRows(result).find((r) => r.resourceId === "gold")!;
    // Use toBeCloseTo for computed division to handle floating-point precision
    expect(gold.dailyConsumption).toBeCloseTo(500 / 1.2, 0);
  });

  it("net flow is production - consumption", () => {
    const result = computeEconomyFromIntent(makeEconomyIntent());
    const gold = balanceRows(result).find((r) => r.resourceId === "gold")!;
    expect(gold.netFlowAverage).toBe(gold.dailyProductionAverage - gold.dailyConsumption);
  });

  it("defaults budget range when missing", () => {
    const result = computeEconomyFromIntent({
      moduleType: "economy",
      decisions: { resourceComplexity: "simple", resourceCount: 1, rationale: "test" },
      strategy: {
        resourceTypes: [{ id: "gold", name: "金币", isPremium: false, sinks: [], sources: [] }],
        itemTypes: [],
      },
      consumptionSplit: { progression: 0.5, gacha: 0.3, social: 0.1, other: 0.1 },
      anchors: {
        dailyBudget: {},
        productionConsumptionRatio: {},
      },
    });
    const gold = balanceRows(result)[0];
    expect(gold.dailyProductionAverage).toBe(300); // default [100, 500] midpoint
  });

  it("preserves item types", () => {
    const result = computeEconomyFromIntent(makeEconomyIntent());
    expect(result.itemTypes.length).toBe(1);
    expect(result.itemTypes[0].id).toBe("sword_01");
  });

  it("preserves production/consumption ratio", () => {
    const result = computeEconomyFromIntent(makeEconomyIntent());
    expect(result.productionConsumptionRatio.gold).toBe(1.2);
  });

  it("balanceStatus is surplus when all net flows are positive", () => {
    const result = computeEconomyFromIntent(makeEconomyIntent());
    const gold = result.dailyBudgetTable.find((r) => r.resourceId === "gold")!;
    // gold: casual=200, avg=500, hardcore=800, consumption=Math.round(500/1.2)=417
    // casual net = 200-417 = -217 (negative)
    // so gold should NOT be surplus
    expect(gold.balanceStatus).toBe("healthy");
  });

  it("balanceStatus is surplus when ratio > 1 for all tiers", () => {
    const result = computeEconomyFromIntent(makeEconomyIntent({
      anchors: {
        dailyBudget: { gold: [200, 800], gem: [10, 50] },
        productionConsumptionRatio: { gold: 3.0, gem: 3.0 },
      },
    }));
    const gold = result.dailyBudgetTable.find((r) => r.resourceId === "gold")!;
    // consumption = Math.round(500/3.0) = 167; all net flows positive
    expect(gold.balanceStatus).toBe("surplus");
  });

  it("balanceStatus is deficit when ratio < 1 for casual tier", () => {
    const result = computeEconomyFromIntent(makeEconomyIntent({
      anchors: {
        dailyBudget: { gold: [200, 800], gem: [10, 50] },
        productionConsumptionRatio: { gold: 0.3, gem: 1.0 },
      },
    }));
    const gold = result.dailyBudgetTable.find((r) => r.resourceId === "gold")!;
    // consumption = Math.round(500/0.3) = 1667; all net flows negative
    expect(gold.balanceStatus).toBe("deficit");
  });

  it("generates exchangeRates between free and premium resources", () => {
    const result = computeEconomyFromIntent(makeEconomyIntent());
    expect(result.valueChain.exchangeRates.length).toBeGreaterThan(0);
    const rate = result.valueChain.exchangeRates[0];
    expect(rate.fromResource).toBe("gold");
    expect(rate.toResource).toBe("gem");
    expect(rate.direction).toBe("one_way");
    // gold cap=800, gem cap=50, rate = 800/50 = 16
    expect(rate.rate).toBeCloseTo(16, 10);
  });

  it("exchangeRates is empty when no premium resources exist", () => {
    const result = computeEconomyFromIntent({
      moduleType: "economy",
      decisions: { resourceComplexity: "simple", resourceCount: 1, rationale: "test" },
      strategy: {
        resourceTypes: [{ id: "gold", name: "金币", isPremium: false, sinks: [], sources: [] }],
        itemTypes: [],
      },
      consumptionSplit: { progression: 0.5, gacha: 0.3, social: 0.1, other: 0.1 },
      anchors: { dailyBudget: { gold: [100, 500] }, productionConsumptionRatio: {} },
    });
    expect(result.valueChain.exchangeRates).toEqual([]);
  });
});

describe("computeDailyBudget", () => {
  const resourceTypes = [
    { id: "gold", name: "金币", isPremium: false },
    { id: "gem", name: "宝石", isPremium: true },
  ];

  it("computes daily budget rows independently", () => {
    const rows = computeDailyBudget(
      resourceTypes,
      { gold: [200, 800], gem: [10, 50] },
      { gold: 1.2, gem: 1.0 },
    );
    expect(rows).toHaveLength(2);
    const gold = rows.find((r) => r.resourceId === "gold")!;
    expect(gold.dailyProductionAverage).toBe(500);
    expect(gold.dailyProductionCasual).toBe(200);
    expect(gold.dailyProductionHardcore).toBe(800);
    expect(gold.dailyConsumption).toBe(Math.round(500 / 1.2));
  });

  it("includes balanceStatus in each row", () => {
    const rows = computeDailyBudget(
      resourceTypes,
      { gold: [200, 800], gem: [10, 50] },
      { gold: 1.2, gem: 1.0 },
    );
    for (const row of rows) {
      expect(row).toHaveProperty("balanceStatus");
      expect(["healthy", "deficit", "surplus"]).toContain(row.balanceStatus);
    }
  });

  it("uses defaults when budget and ratio are empty", () => {
    const rows = computeDailyBudget(
      [{ id: "wood", name: "木材", isPremium: false }],
      {},
      {},
    );
    const wood = rows[0];
    expect(wood.dailyProductionAverage).toBe(300); // default [100, 500] midpoint
    expect(wood.dailyConsumption).toBe(300); // ratio defaults to 1.0
  });
});

describe("EconomyComputeResult type export", () => {
  it("can be used as a type annotation", () => {
    const result: EconomyComputeResult = computeEconomyFromIntent(makeEconomyIntent());
    expect(result.dailyBudgetTable).toBeDefined();
    expect(result.valueChain).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Boundary tests
// ═══════════════════════════════════════════════════════════════════════════

describe("computeDailyBudget – boundary: NaN inputs", () => {
  const resources = [{ id: "gold", name: "金币", isPremium: false }];

  it("NaN budget range values propagate as NaN without crash", () => {
    const rows = computeDailyBudget(
      resources,
      { gold: [NaN, 800] },
      { gold: 1.2 },
    );
    expect(rows).toHaveLength(1);
    // NaN propagates through Math.round => NaN
    expect(Number.isNaN(rows[0].dailyProductionCasual)).toBe(true);
  });

  it("NaN productionConsumptionRatio falls back to 1.0 (falsy guard)", () => {
    const rows = computeDailyBudget(
      resources,
      { gold: [100, 500] },
      { gold: NaN },
    );
    expect(rows).toHaveLength(1);
    // NaN is falsy, so `NaN || 1.0` => 1.0, consumption = Math.round(300 / 1.0) = 300
    expect(rows[0].dailyConsumption).toBe(300);
  });
});

describe("computeDailyBudget – boundary: negative inputs", () => {
  const resources = [{ id: "gold", name: "金币", isPremium: false }];

  it("negative budget range produces negative production values", () => {
    const rows = computeDailyBudget(
      resources,
      { gold: [-200, -100] },
      { gold: 1.2 },
    );
    expect(rows[0].dailyProductionCasual).toBe(-200);
    expect(rows[0].dailyProductionHardcore).toBe(-100);
    expect(rows[0].dailyProductionAverage).toBe(-150);
  });

  it("negative ratio produces negative consumption", () => {
    const rows = computeDailyBudget(
      resources,
      { gold: [100, 500] },
      { gold: -1.0 },
    );
    expect(rows[0].dailyConsumption).toBe(-300);
  });
});

describe("computeDailyBudget – boundary: zero inputs", () => {
  const resources = [{ id: "gold", name: "金币", isPremium: false }];

  it("zero budget range produces zero production", () => {
    const rows = computeDailyBudget(
      resources,
      { gold: [0, 0] },
      { gold: 1.0 },
    );
    expect(rows[0].dailyProductionCasual).toBe(0);
    expect(rows[0].dailyProductionAverage).toBe(0);
    expect(rows[0].dailyConsumption).toBe(0);
    expect(rows[0].netFlowAverage).toBe(0);
  });

  it("zero ratio falls back to 1.0 (falsy guard)", () => {
    const rows = computeDailyBudget(
      resources,
      { gold: [100, 500] },
      { gold: 0 },
    );
    // 0 is falsy, so `0 || 1.0` => 1.0, consumption = Math.round(300 / 1.0) = 300
    expect(rows[0].dailyConsumption).toBe(300);
  });
});

describe("computeDailyBudget – boundary: Infinity inputs", () => {
  const resources = [{ id: "gold", name: "金币", isPremium: false }];

  it("Infinity budget range produces Infinity production", () => {
    const rows = computeDailyBudget(
      resources,
      { gold: [Infinity, Infinity] },
      { gold: 1.0 },
    );
    expect(rows[0].dailyProductionAverage).toBe(Infinity);
  });

  it("Infinity ratio produces zero consumption", () => {
    const rows = computeDailyBudget(
      resources,
      { gold: [100, 500] },
      { gold: Infinity },
    );
    expect(rows[0].dailyConsumption).toBe(0);
  });
});

describe("computeEconomyFromIntent – boundary: extreme configs", () => {
  it("empty resource types produces empty budget table", () => {
    const result = computeEconomyFromIntent({
      moduleType: "economy",
      decisions: { resourceComplexity: "simple", resourceCount: 0, rationale: "test" },
      strategy: { resourceTypes: [], itemTypes: [] },
      consumptionSplit: { progression: 0.5, gacha: 0.3, social: 0.1, other: 0.1 },
      anchors: { dailyBudget: {}, productionConsumptionRatio: {} },
    });
    expect(result.dailyBudgetTable).toHaveLength(0);
    expect(result.valueChain.exchangeRates).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// consumptionSplit 回显修复（V6-W9 §2.2，风险 1）
//
// EconomyDesignIntent.consumptionSplit 是 intent 根级字段，不在
// _strategy/_anchors/decisions 三件套 → 修复前 B 形态 computedData 完全没有此键，
// parseFeatureKeys:31（strategy?.consumptionSplit）不出 consumption_distribution 卡。
// 修复：economy.ts 顶层输出 + index.ts 并入 _strategy 回显（对齐 C 形态 seed）。
// ═══════════════════════════════════════════════════════════════════════════

describe("consumptionSplit 根级回显（V6-W9 → E1-2）", () => {
  it("computeEconomyFromIntent 输出含顶层 consumptionSplit", () => {
    const result = computeEconomyFromIntent(makeEconomyIntent());
    expect(result.consumptionSplit).toEqual({ progression: 0.4, gacha: 0.3, social: 0.2, other: 0.1 });
  });

  it("computeFromIntent 根级直拷回显（E1-2），_strategy 不再并入，parseFeatureKeys 出卡条件转绿", () => {
    const computed = computeFromIntent(makeEconomyIntent());
    // 顶层（唯一回显位，mapper / parseFeatureKeys 双读主源）
    expect(computed.consumptionSplit).toEqual({ progression: 0.4, gacha: 0.3, social: 0.2, other: 0.1 });
    // _strategy 不再携带该键（E1-2 新产物纯净；存量 _strategy 形态由读点双读兜底）
    const strategy = computed._strategy as Record<string, unknown>;
    expect(strategy.consumptionSplit).toBeUndefined();
    // 出卡条件（根级命中）
    expect(parseFeatureKeys(computed, "economy")).toContainEqual({
      key: "consumption_distribution",
      name: "消耗分布",
    });
  });

  it("_strategy 回显仍保留 strategy 原有键（resourceTypes/itemTypes 不丢失）", () => {
    const computed = computeFromIntent(makeEconomyIntent());
    const strategy = computed._strategy as Record<string, unknown>;
    expect(Array.isArray(strategy.resourceTypes)).toBe(true);
    expect(Array.isArray(strategy.itemTypes)).toBe(true);
  });
});
