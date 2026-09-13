import { describe, it, expect } from "vitest";
import {
  simulatePityRates,
  cumulativeProbabilities,
  expectedPullsForRarity,
  expectedCostPerRarity,
  monthlyFreePulls,
  generateProbabilityTable,
  computeGachaFromIntent,
  buildGachaConfigFromIntent,
  runGachaSimulation,
  resolveCurrencyRMB,
  DEFAULT_CURRENCY_EXCHANGE_RATE,
} from "../gacha";
import type { PityConfig } from "../gacha";
import type { GachaDesignIntent } from "../types";

function makeConfig(overrides?: Partial<PityConfig>): PityConfig {
  return {
    hardPity: 90,
    softPityStart: 74,
    softPityIncrement: 0.06,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// simulatePityRates
// ---------------------------------------------------------------------------
describe("simulatePityRates", () => {
  const baseRate = 0.006;

  it("returns array of length equal to hardPity", () => {
    const config = makeConfig();
    const rates = simulatePityRates(baseRate, config);
    expect(rates).toHaveLength(config.hardPity);
  });

  it("first pull equals baseRate", () => {
    const rates = simulatePityRates(baseRate, makeConfig());
    expect(rates[0]).toBe(baseRate);
  });

  it("last pull (hardPity) is always 1.0", () => {
    const rates = simulatePityRates(baseRate, makeConfig());
    expect(rates[rates.length - 1]).toBe(1.0);
  });

  it("rates before softPityStart are all baseRate", () => {
    const config = makeConfig({ hardPity: 90, softPityStart: 74, softPityIncrement: 0.06 });
    const rates = simulatePityRates(baseRate, config);
    for (let i = 0; i < config.softPityStart - 1; i++) {
      expect(rates[i]).toBe(baseRate);
    }
  });

  it("rates increase monotonically from softPityStart onward", () => {
    const config = makeConfig();
    const rates = simulatePityRates(baseRate, config);
    for (let i = config.softPityStart - 1; i < rates.length - 1; i++) {
      expect(rates[i + 1]).toBeGreaterThanOrEqual(rates[i]);
    }
  });

  it("rate at softPityStart equals baseRate + 1 * softPityIncrement", () => {
    const config = makeConfig({ softPityIncrement: 0.06 });
    const rates = simulatePityRates(baseRate, config);
    // pull=74 (index 73), increments = 74 - 74 + 1 = 1
    expect(rates[73]).toBe(baseRate + 1 * 0.06);
  });

  it("rate at softPityStart+1 equals baseRate + 2 * softPityIncrement", () => {
    const config = makeConfig({ softPityIncrement: 0.06 });
    const rates = simulatePityRates(baseRate, config);
    // pull=75 (index 74), increments = 75 - 74 + 1 = 2
    expect(rates[74]).toBe(baseRate + 2 * 0.06);
  });

  it("rates never exceed 1.0 even with large increment", () => {
    const config = makeConfig({ hardPity: 100, softPityStart: 50, softPityIncrement: 0.1 });
    const rates = simulatePityRates(0.3, config);
    for (const rate of rates) {
      expect(rate).toBeLessThanOrEqual(1.0);
    }
  });

  it("works with very small hardPity", () => {
    const config = makeConfig({ hardPity: 2, softPityStart: 2, softPityIncrement: 0.1 });
    const rates = simulatePityRates(baseRate, config);
    expect(rates).toHaveLength(2);
    expect(rates[0]).toBe(baseRate);
    expect(rates[1]).toBe(1.0);
  });

  it("works when softPityStart equals hardPity (no soft pity phase)", () => {
    const config = makeConfig({ hardPity: 10, softPityStart: 10, softPityIncrement: 0.05 });
    const rates = simulatePityRates(baseRate, config);
    // pull 1-9: baseRate, pull 10: 1.0
    for (let i = 0; i < 9; i++) {
      expect(rates[i]).toBe(baseRate);
    }
    expect(rates[9]).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// cumulativeProbabilities
// ---------------------------------------------------------------------------
describe("cumulativeProbabilities", () => {
  it("returns same length as input", () => {
    const rates = [0.1, 0.2, 0.3];
    const cum = cumulativeProbabilities(rates);
    expect(cum).toHaveLength(3);
  });

  it("is monotonically non-decreasing", () => {
    const rates = [0.01, 0.01, 0.05, 0.1, 0.5, 1.0];
    const cum = cumulativeProbabilities(rates);
    for (let i = 1; i < cum.length; i++) {
      expect(cum[i]).toBeGreaterThanOrEqual(cum[i - 1]);
    }
  });

  it("all values are between 0 and 1", () => {
    const rates = [0.1, 0.3, 0.5, 0.8, 1.0];
    const cum = cumulativeProbabilities(rates);
    for (const c of cum) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
    }
  });

  it("single rate 1.0 gives cumulative = [1.0]", () => {
    const cum = cumulativeProbabilities([1.0]);
    expect(cum[0]).toBeCloseTo(1.0, 10);
  });

  it("single rate 0.0 gives cumulative = [0.0]", () => {
    const cum = cumulativeProbabilities([0.0]);
    expect(cum[0]).toBeCloseTo(0.0, 10);
  });

  it("constant rate produces correct cumulative at step N", () => {
    const rate = 0.5;
    const rates = [rate, rate, rate];
    const cum = cumulativeProbabilities(rates);
    // cum[i] = 1 - (1-rate)^(i+1)
    expect(cum[0]).toBeCloseTo(1 - 0.5, 10);
    expect(cum[1]).toBeCloseTo(1 - 0.25, 10);
    expect(cum[2]).toBeCloseTo(1 - 0.125, 10);
  });

  it("empty input returns empty array", () => {
    const cum = cumulativeProbabilities([]);
    expect(cum).toHaveLength(0);
  });

  it("last cumulative value equals 1 - ∏(1 - rate_i)", () => {
    const rates = [0.1, 0.2, 0.3];
    const cum = cumulativeProbabilities(rates);
    const expected = 1 - (1 - 0.1) * (1 - 0.2) * (1 - 0.3);
    expect(cum[cum.length - 1]).toBeCloseTo(expected, 10);
  });
});

// ---------------------------------------------------------------------------
// expectedPullsForRarity
// ---------------------------------------------------------------------------
describe("expectedPullsForRarity", () => {
  it("with guaranteed pity at pull 1, expected is 1", () => {
    // rate[0] = 1.0 means always get SSR on first pull
    const pulls = expectedPullsForRarity([1.0]);
    expect(pulls).toBe(1.0);
  });

  it("returns positive number for typical gacha rates", () => {
    const config = makeConfig();
    const rates = simulatePityRates(0.006, config);
    const pulls = expectedPullsForRarity(rates);
    expect(pulls).toBeGreaterThan(0);
    expect(pulls).toBeLessThan(config.hardPity);
  });

  it("result is rounded to 1 decimal place", () => {
    const rates = simulatePityRates(0.006, makeConfig());
    const pulls = expectedPullsForRarity(rates);
    const decimals = pulls.toString().split(".")[1];
    expect(decimals ? decimals.length : 0).toBeLessThanOrEqual(1);
  });

  it("higher baseRate gives lower expected pulls", () => {
    const config = makeConfig();
    const low = expectedPullsForRarity(simulatePityRates(0.003, config));
    const high = expectedPullsForRarity(simulatePityRates(0.01, config));
    expect(high).toBeLessThan(low);
  });

  it("shorter hardPity gives lower expected pulls", () => {
    const shortPity = expectedPullsForRarity(
      simulatePityRates(0.006, makeConfig({ hardPity: 50, softPityStart: 40, softPityIncrement: 0.06 })),
    );
    const longPity = expectedPullsForRarity(
      simulatePityRates(0.006, makeConfig({ hardPity: 90, softPityStart: 74, softPityIncrement: 0.06 })),
    );
    expect(shortPity).toBeLessThan(longPity);
  });
});

// ---------------------------------------------------------------------------
// expectedCostPerRarity
// ---------------------------------------------------------------------------
describe("expectedCostPerRarity", () => {
  const rates = simulatePityRates(0.006, makeConfig());

  it("returns rmb and pulls fields", () => {
    const result = expectedCostPerRarity(160, 10, rates);
    expect(result).toHaveProperty("rmb");
    expect(result).toHaveProperty("pulls");
  });

  it("rmb = round(rawPulls * costPerPull / exchangeRate)", () => {
    const costPerPull = 160;
    const exchangeRate = 10;
    const result = expectedCostPerRarity(costPerPull, exchangeRate, rates);
    // expectedCostPerRarity 用未取整的 pulls 计算 rmb
    const rawPulls = expectedPullsForRarity(rates);
    const expectedRmb = Math.round((rawPulls * costPerPull) / exchangeRate);
    expect(result.rmb).toBe(expectedRmb);
  });

  it("higher exchangeRate gives lower rmb cost", () => {
    const cheap = expectedCostPerRarity(160, 1, rates);
    const expensive = expectedCostPerRarity(160, 10, rates);
    expect(expensive.rmb).toBeLessThan(cheap.rmb);
  });

  it("higher costPerPull gives higher rmb cost", () => {
    const cheap = expectedCostPerRarity(100, 10, rates);
    const expensive = expectedCostPerRarity(200, 10, rates);
    expect(expensive.rmb).toBeGreaterThan(cheap.rmb);
  });

  it("zero exchangeRate yields Infinity (division by zero)", () => {
    // Math.round(Infinity) = Infinity
    const result = expectedCostPerRarity(160, 0, rates);
    expect(result.rmb).toBe(Infinity);
  });
});

// ---------------------------------------------------------------------------
// resolveCurrencyRMB（P1-5 汇率单源化：两引擎共享解析 + 统一兜底）
// ---------------------------------------------------------------------------
describe("resolveCurrencyRMB", () => {
  it("paidResources 命中 currencyType → 返回该行 exchangeRate", () => {
    const rows = [
      { resourceTypeId: "gold", exchangeRate: 1000 },
      { resourceTypeId: "gem", exchangeRate: 100 },
    ];
    expect(resolveCurrencyRMB(rows, "gem")).toBe(100);
  });

  it("未命中 / 空表 / undefined → 统一兜底 10（锚定 gacha 原硬编码现行为）", () => {
    expect(resolveCurrencyRMB([{ resourceTypeId: "gem", exchangeRate: 100 }], "diamond")).toBe(10);
    expect(resolveCurrencyRMB([], "gem")).toBe(10);
    expect(resolveCurrencyRMB(undefined, "gem")).toBe(10);
  });

  it("命中但 exchangeRate 非法（≤0 / NaN）→ 走兜底不产生除零/NaN", () => {
    expect(resolveCurrencyRMB([{ resourceTypeId: "gem", exchangeRate: 0 }], "gem")).toBe(10);
    expect(
      resolveCurrencyRMB([{ resourceTypeId: "gem", exchangeRate: NaN }], "gem")
    ).toBe(10);
  });

  it("DEFAULT_CURRENCY_EXCHANGE_RATE 常量 = 10（口径锚定点）", () => {
    expect(DEFAULT_CURRENCY_EXCHANGE_RATE).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// monthlyFreePulls
// ---------------------------------------------------------------------------
describe("monthlyFreePulls", () => {
  it("calculates floor(dailyIncome * 30 / costPerPull)", () => {
    expect(monthlyFreePulls(100, 10)).toBe(300);
    expect(monthlyFreePulls(50, 160)).toBe(Math.floor((50 * 30) / 160));
  });

  it("returns 0 when daily income is less than one pull per day", () => {
    expect(monthlyFreePulls(1, 160)).toBe(0);
  });

  it("returns 0 when daily income is 0", () => {
    expect(monthlyFreePulls(0, 160)).toBe(0);
  });

  it("handles large daily income", () => {
    expect(monthlyFreePulls(10000, 10)).toBe(30000);
  });

  it("floors the result (truncates fractional pulls)", () => {
    // 15 * 30 = 450, 450 / 160 = 2.8125 -> floor = 2
    expect(monthlyFreePulls(15, 160)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// generateProbabilityTable
// ---------------------------------------------------------------------------
describe("generateProbabilityTable", () => {
  const baseRate = 0.006;
  const config = makeConfig();

  it("uses default checkpoints when none provided", () => {
    const table = generateProbabilityTable(baseRate, config);
    // default checkpoints filtered by <= hardPity(90)
    const defaultCheckpoints = [1, 10, 20, 50, 60, 73, 74, 75, 76, 77, 78, 79, 80, 85, 90];
    expect(table).toHaveLength(defaultCheckpoints.length);
    expect(table.map((r) => r.pulls)).toEqual(defaultCheckpoints);
  });

  it("uses custom checkpoints", () => {
    const table = generateProbabilityTable(baseRate, config, [1, 30, 60, 90]);
    expect(table).toHaveLength(4);
    expect(table.map((r) => r.pulls)).toEqual([1, 30, 60, 90]);
  });

  it("filters out checkpoints exceeding hardPity", () => {
    const table = generateProbabilityTable(baseRate, config, [1, 90, 91, 100]);
    expect(table).toHaveLength(2);
    expect(table.map((r) => r.pulls)).toEqual([1, 90]);
  });

  it("ssrRate at pull 1 equals baseRate (rounded)", () => {
    const table = generateProbabilityTable(baseRate, config, [1]);
    expect(table[0].ssrRate).toBe(Math.round(baseRate * 10000) / 10000);
  });

  it("ssrRate at hardPity equals 1.0", () => {
    const table = generateProbabilityTable(baseRate, config, [config.hardPity]);
    expect(table[0].ssrRate).toBe(1.0);
  });

  it("cumulativeChance is monotonically non-decreasing", () => {
    const table = generateProbabilityTable(baseRate, config);
    for (let i = 1; i < table.length; i++) {
      expect(table[i].cumulativeChance).toBeGreaterThanOrEqual(table[i - 1].cumulativeChance);
    }
  });

  it("cumulativeChance at hardPity is 1.0", () => {
    const table = generateProbabilityTable(baseRate, config, [config.hardPity]);
    expect(table[0].cumulativeChance).toBe(1.0);
  });

  it("ssrRate increases at soft pity boundary", () => {
    const table = generateProbabilityTable(baseRate, config, [73, 74]);
    // pull 73: still baseRate, pull 74: baseRate + increment
    expect(table[0].ssrRate).toBe(baseRate);
    expect(table[1].ssrRate).toBeGreaterThan(baseRate);
  });

  it("all cumulativeChance values are between 0 and 1", () => {
    const table = generateProbabilityTable(baseRate, config);
    for (const row of table) {
      expect(row.cumulativeChance).toBeGreaterThanOrEqual(0);
      expect(row.cumulativeChance).toBeLessThanOrEqual(1);
    }
  });

  it("values are rounded to 4 decimal places", () => {
    const table = generateProbabilityTable(baseRate, config, [75]);
    const row = table[0];
    // 检查最多4位小数
    const ssrDecimals = row.ssrRate.toString().split(".")[1]?.length ?? 0;
    const cumDecimals = row.cumulativeChance.toString().split(".")[1]?.length ?? 0;
    expect(ssrDecimals).toBeLessThanOrEqual(4);
    expect(cumDecimals).toBeLessThanOrEqual(4);
  });

  it("returns empty array when all checkpoints exceed hardPity", () => {
    const table = generateProbabilityTable(baseRate, config, [91, 100, 200]);
    expect(table).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Boundary tests
// ═══════════════════════════════════════════════════════════════════════════

describe("simulatePityRates – boundary: NaN config", () => {
  const baseRate = 0.006;

  it("NaN hardPity produces empty rates array", () => {
    const config = makeConfig({ hardPity: NaN, softPityStart: 74, softPityIncrement: 0.06 });
    const rates = simulatePityRates(baseRate, config);
    // for loop with NaN upper bound: 1 <= NaN is always false → empty array
    expect(rates).toHaveLength(0);
  });

  it("NaN softPityIncrement produces NaN rates in soft pity range", () => {
    const config = makeConfig({ hardPity: 90, softPityStart: 74, softPityIncrement: NaN });
    const rates = simulatePityRates(baseRate, config);
    // Pulls 1-73 are baseRate; pulls 74+ are NaN (baseRate + NaN)
    for (let i = 0; i < 73; i++) {
      expect(rates[i]).toBe(baseRate);
    }
    expect(Number.isNaN(rates[73])).toBe(true);
  });

  it("NaN baseRate produces NaN rates", () => {
    const config = makeConfig({ hardPity: 10, softPityStart: 10, softPityIncrement: 0 });
    const rates = simulatePityRates(NaN, config);
    for (let i = 0; i < rates.length - 1; i++) {
      expect(Number.isNaN(rates[i])).toBe(true);
    }
    expect(rates[rates.length - 1]).toBe(1.0); // hardPity always 1.0
  });
});

describe("simulatePityRates – boundary: negative config", () => {
  const baseRate = 0.006;

  it("negative hardPity produces empty rates array", () => {
    const config = makeConfig({ hardPity: -10, softPityStart: 74, softPityIncrement: 0.06 });
    const rates = simulatePityRates(baseRate, config);
    expect(rates).toHaveLength(0);
  });

  it("negative softPityIncrement produces decreasing rates (but capped at baseRate)", () => {
    const config = makeConfig({ hardPity: 90, softPityStart: 74, softPityIncrement: -0.001 });
    const rates = simulatePityRates(baseRate, config);
    // Pull 74: baseRate + 1*(-0.001) = 0.005
    expect(rates[73]).toBeCloseTo(0.005, 10);
  });

  it("negative baseRate produces negative rates in non-soft-pity range", () => {
    const config = makeConfig({ hardPity: 10, softPityStart: 10, softPityIncrement: 0 });
    const rates = simulatePityRates(-0.5, config);
    expect(rates[0]).toBe(-0.5);
  });
});

describe("simulatePityRates – boundary: zero inputs", () => {
  const baseRate = 0.006;

  it("hardPity=0 produces empty array", () => {
    const config = makeConfig({ hardPity: 0, softPityStart: 0, softPityIncrement: 0 });
    const rates = simulatePityRates(baseRate, config);
    expect(rates).toHaveLength(0);
  });

  it("softPityIncrement=0 keeps rates at baseRate throughout soft pity", () => {
    const config = makeConfig({ hardPity: 90, softPityStart: 74, softPityIncrement: 0 });
    const rates = simulatePityRates(baseRate, config);
    for (let i = 0; i < 89; i++) {
      expect(rates[i]).toBe(baseRate);
    }
    expect(rates[89]).toBe(1.0);
  });

  it("baseRate=0 still gets hardPity guarantee at last pull", () => {
    const config = makeConfig({ hardPity: 90, softPityStart: 74, softPityIncrement: 0.06 });
    const rates = simulatePityRates(0, config);
    expect(rates[0]).toBe(0);
    expect(rates[rates.length - 1]).toBe(1.0);
  });
});

describe("simulatePityRates – boundary: Infinity inputs", () => {
  it("Infinity hardPity is not reachable in finite time (test with large number)", () => {
    // Infinity causes infinite loop — test with a large finite number instead
    const config = makeConfig({ hardPity: 1000, softPityStart: 74, softPityIncrement: 0.06 });
    const rates = simulatePityRates(0.006, config);
    expect(rates).toHaveLength(1000);
    expect(rates[rates.length - 1]).toBe(1.0);
  });

  it("Infinity softPityIncrement produces all 1.0 rates from softPity onward", () => {
    const config = makeConfig({ hardPity: 90, softPityStart: 74, softPityIncrement: Infinity });
    const rates = simulatePityRates(0.006, config);
    // Math.min(baseRate + 1*Infinity, 1.0) = Math.min(Infinity, 1.0) = 1.0
    expect(rates[73]).toBe(1.0);
  });
});

describe("monthlyFreePulls – boundary: NaN and Infinity", () => {
  it("NaN daily income produces NaN result", () => {
    expect(Number.isNaN(monthlyFreePulls(NaN, 10))).toBe(true);
  });

  it("NaN costPerPull produces NaN result", () => {
    expect(Number.isNaN(monthlyFreePulls(100, NaN))).toBe(true);
  });

  it("Infinity daily income with finite cost produces Infinity", () => {
    expect(monthlyFreePulls(Infinity, 10)).toBe(Infinity);
  });

  it("finite daily income with zero costPerPull produces Infinity", () => {
    expect(monthlyFreePulls(100, 0)).toBe(Infinity);
  });

  it("negative daily income produces negative pulls", () => {
    expect(monthlyFreePulls(-100, 10)).toBeLessThanOrEqual(0);
  });
});

describe("cumulativeProbabilities – boundary: NaN and Infinity", () => {
  it("NaN rates produce NaN cumulative values", () => {
    const cum = cumulativeProbabilities([0.5, NaN, 0.5]);
    expect(cum[0]).toBeCloseTo(0.5, 10);
    expect(Number.isNaN(cum[1])).toBe(true);
  });

  it("Infinity rate clamps cumulative to 1 after that point", () => {
    const cum = cumulativeProbabilities([0.1, Infinity, 0.5]);
    // noSSR after rate 0.1: 0.9; after rate Infinity: 0.9 * (1 - Infinity) = -Infinity
    // 1 - (-Infinity) = Infinity
    expect(cum[1]).toBe(Infinity);
  });
});

describe("expectedCostPerRarity – boundary: NaN", () => {
  const rates = simulatePityRates(0.006, makeConfig());

  it("NaN costPerPull produces NaN rmb", () => {
    const result = expectedCostPerRarity(NaN, 10, rates);
    expect(Number.isNaN(result.rmb)).toBe(true);
  });

  it("NaN exchangeRate produces NaN rmb", () => {
    const result = expectedCostPerRarity(160, NaN, rates);
    expect(Number.isNaN(result.rmb)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// computeGachaFromIntent
// ---------------------------------------------------------------------------

describe("computeGachaFromIntent", () => {
  const intent: GachaDesignIntent = {
    moduleType: "gacha",
    decisions: {
      guaranteeType: "soft",
      targetRarity: "ssr",
      rationale: "标准软保底策略",
    },
    strategy: {
      poolDesign: {
        rarities: [
          { id: "r", name: "R", color: "#aaa", rate: 0.9 },
          { id: "sr", name: "SR", color: "#f0f", rate: 0.09 },
          { id: "ssr", name: "SSR", color: "#ff0", rate: 0.01 },
        ],
      },
      guarantee: {
        type: "soft",
        targetRarity: "ssr",
        hardCount: 90,
        softStart: 74,
        softIncrement: 0.06,
      },
      cost: {
        singleCost: 160,
        tenCost: 1440,
        currency: "gem",
      },
    },
  };

  it("returns non-empty probabilityTable", () => {
    const result = computeGachaFromIntent(intent);
    expect(result.probabilityTable).toBeDefined();
    expect(result.probabilityTable.length).toBeGreaterThan(0);
  });

  it("returns simulation with averagePulls > 0", () => {
    const result = computeGachaFromIntent(intent);
    expect(result.simulation).toBeDefined();
    expect(result.simulation.averagePulls).toBeGreaterThan(0);
  });

  // 主链路保持单只目标（K=1），
  // 10000 次模拟输出自然获得 percentiles，无接口变更
  it("returns simulation with percentiles (p50/p90) at default K=1", () => {
    const result = computeGachaFromIntent(intent);
    expect(result.simulation.percentiles).toBeDefined();
    // p50 与 medianPulls 一致（线性插值 type-7 在 q=0.5 与奇偶分支定义相同，
    // 整数抽数样本下无浮点误差）
    expect(result.simulation.percentiles.p50).toBe(result.simulation.medianPulls);
    // K=1 时总抽数 ∈ (0, hardPity]，分位不应越界
    expect(result.simulation.percentiles.p50).toBeGreaterThan(0);
    expect(result.simulation.percentiles.p90).toBeLessThanOrEqual(90);
    expect(result.simulation.percentiles.p90).toBeGreaterThanOrEqual(
      result.simulation.percentiles.p50,
    );
  });

  it("preserves decisions and strategy from intent", () => {
    const result = computeGachaFromIntent(intent);
    expect(result.decisions).toEqual(intent.decisions);
    expect(result.strategy).toEqual(intent.strategy);
  });

  it("returns expectedPulls within (0, hardPity]", () => {
    const result = computeGachaFromIntent(intent);
    expect(result.expectedPulls).toBeGreaterThan(0);
    expect(result.expectedPulls).toBeLessThanOrEqual(90);
  });

  it("returns costExpectation with positive rmb", () => {
    const result = computeGachaFromIntent(intent);
    expect(result.costExpectation).toBeDefined();
    expect(result.costExpectation.perRarity.rmb).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // P1-5 汇率单源化：gacha intent 无 paidResources 表 → 恒走统一兜底 10
  //（原硬编码 10 现行为锁定，monetization 侧原兜底 1 收敛至此同口径）
  // -----------------------------------------------------------------------
  it("costExpectation 汇率锁定统一兜底 10（P1-5 单源口径）", () => {
    const result = computeGachaFromIntent(intent);
    const rates = simulatePityRates(
      buildGachaConfigFromIntent(intent).config.baseRate,
      buildGachaConfigFromIntent(intent).config.pity,
    );
    const expectedRmb = Math.round(
      (expectedPullsForRarity(rates) * intent.strategy.cost.singleCost) / 10,
    );
    expect(result.costExpectation.perRarity.rmb).toBe(expectedRmb);
  });

  it("handles guaranteeType 'none' without throwing", () => {
    const noGuaranteeIntent: GachaDesignIntent = {
      ...intent,
      decisions: {
        guaranteeType: "none",
        targetRarity: "ssr",
        rationale: "无保底",
      },
      strategy: {
        ...intent.strategy,
        guarantee: {
          type: "none",
          targetRarity: "ssr",
          hardCount: 1,
        },
      },
    };
    const result = computeGachaFromIntent(noGuaranteeIntent);
    expect(result.probabilityTable.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// computeGachaFromIntent – tenCost 缺省派生（引擎独占计算量输出，T2）
// ---------------------------------------------------------------------------

describe("computeGachaFromIntent – tenCost derivation", () => {
  // cost 不含 tenCost：引擎应按 singleCost × 10 × 0.9 派生（十连抽行业惯例 9 折）
  const intentWithoutTenCost: GachaDesignIntent = {
    moduleType: "gacha",
    decisions: {
      guaranteeType: "soft",
      targetRarity: "ssr",
      rationale: "标准软保底策略",
    },
    strategy: {
      poolDesign: {
        rarities: [
          { id: "r", name: "R", color: "#aaa", rate: 0.9 },
          { id: "sr", name: "SR", color: "#f0f", rate: 0.09 },
          { id: "ssr", name: "SSR", color: "#ff0", rate: 0.01 },
        ],
      },
      guarantee: {
        type: "soft",
        targetRarity: "ssr",
        hardCount: 90,
        softStart: 74,
        softIncrement: 0.06,
      },
      cost: {
        singleCost: 160,
        currency: "gem",
      },
    },
  };

  it("derives tenCost = round(singleCost × 10 × 0.9) when absent (160 → 1440)", () => {
    const result = computeGachaFromIntent(intentWithoutTenCost);
    expect(result.strategy.cost.tenCost).toBe(1440);
  });

  it("preserves explicit tenCost (1280 stays 1280, no override)", () => {
    const intentWithTenCost: GachaDesignIntent = {
      ...intentWithoutTenCost,
      strategy: {
        ...intentWithoutTenCost.strategy,
        cost: { ...intentWithoutTenCost.strategy.cost, tenCost: 1280 },
      },
    };
    const result = computeGachaFromIntent(intentWithTenCost);
    expect(result.strategy.cost.tenCost).toBe(1280);
  });

  it("does not mutate the input intent when deriving tenCost", () => {
    const snapshot = structuredClone(intentWithoutTenCost);
    computeGachaFromIntent(intentWithoutTenCost);
    expect(intentWithoutTenCost).toEqual(snapshot);
    expect(intentWithoutTenCost.strategy.cost.tenCost).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildGachaConfigFromIntent（T2 v6w4：从 computeGachaFromIntent 提取 export——
// TD-2026-08-24-10 单源收敛；
// 与原内联提参行为等价由 T=1 恰 82 抽间接锚定 + 提参三分支锁定）
// ---------------------------------------------------------------------------

describe("buildGachaConfigFromIntent", () => {
  // 标准 82 抽 config：baseRate=0.006 +
  // softPityStart=74 + softIncrement=0.06 + hardPity=90，rng=()=>0.5 时每只恰 82 抽
  // （pull=82: rate = 0.006 + 9×0.06 = 0.546，0.5 < 0.546 → 命中）
  const RARITIES_82 = [
    { id: "r", name: "普通", color: "#9e9e9e", rate: 0.9 },
    { id: "sr", name: "史诗", color: "#a335ee", rate: 0.05 },
    { id: "ssr", name: "传说", color: "#ff8000", rate: 0.006 },
  ];

  function makeIntent82(targetRarity: string): GachaDesignIntent {
    return {
      moduleType: "gacha",
      decisions: { guaranteeType: "soft", targetRarity, rationale: "test" },
      strategy: {
        poolDesign: { rarities: RARITIES_82 },
        guarantee: {
          type: "soft",
          targetRarity: "ssr",
          hardCount: 90,
          softStart: 74,
          softIncrement: 0.06,
        },
        cost: { singleCost: 160, currency: "gems" },
      },
    };
  }

  it("branch 1: targetRarity 按 id 匹配 → baseRate=0.006 config + singleCost；T=1 恰 82 抽（间接锚定与原内联提参等价）", () => {
    const { config, singleCost } = buildGachaConfigFromIntent(makeIntent82("ssr"));
    expect(singleCost).toBe(160);
    expect(config.baseRate).toBe(0.006);
    expect(config.pity).toEqual({
      hardPity: 90,
      softPityStart: 74,
      softPityIncrement: 0.06,
    });
    // 间接锚定：产出的 config 喂 runGachaSimulation（rng=()=>0.5, K=1），
    // 每只恰 82 抽（手算锚定）
    expect(runGachaSimulation(config, 1, () => 0.5, 1).averagePulls).toBe(82);
  });

  it("branch 2: targetRarity 按 name 匹配「传说」→ 同为 baseRate=0.006", () => {
    const { config } = buildGachaConfigFromIntent(makeIntent82("传说"));
    expect(config.baseRate).toBe(0.006);
  });

  it("branch 3: 无 id/name 匹配 → 兜底最高 rate 0.9 → 每只恰 1 抽", () => {
    const { config } = buildGachaConfigFromIntent(makeIntent82("不存在的稀有度"));
    expect(config.baseRate).toBe(0.9);
    // 0.5 < 0.9 → 第一抽命中，T=1 → 恰 1 抽
    expect(runGachaSimulation(config, 1, () => 0.5, 1).averagePulls).toBe(1);
  });
});
