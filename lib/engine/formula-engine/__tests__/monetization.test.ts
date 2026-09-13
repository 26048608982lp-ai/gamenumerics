import { describe, it, expect } from "vitest";
import { computeMonetizationFromIntent } from "../monetization";
import {
  computeGachaFromIntent,
  expectedPullsForRarity,
  simulatePityRates,
} from "../gacha";
import type { MonetizationDesignIntent, GachaDesignIntent } from "../types";

function makeMonetizationIntent(overrides?: Partial<MonetizationDesignIntent>): MonetizationDesignIntent {
  return {
    moduleType: "monetization",
    decisions: {
      monetizationModel: "mixed",
      primaryModel: "gacha",
      rationale: "Mixed monetization model with gacha as primary",
    },
    strategy: {
      // exchangeRate: 1 RMB 可兑换的资源数量（resource_per_RMB）
      // 月卡30元含3000宝石 -> exchangeRate = 100 (gems per RMB)
      // stamina exchangeRate 仅为测试用，不代表真实定价
      paidResources: [
        { resourceTypeId: "gem", exchangeRate: 100 },
        { resourceTypeId: "stamina", exchangeRate: 10 },
      ],
      paymentProducts: [
        {
          id: "monthly_card",
          name: "月卡",
          category: "monthly" as const,
          priceRMB: 30,
          contents: { gem: 3000, stamina: 100 },
        },
        {
          id: "gacha_10",
          name: "十连抽",
          category: "gacha" as const,
          priceRMB: 68,
          contents: { gem: 680 },
        },
      ],
    },
    anchors: {
      powerGap: { freeVsWhale: 5.0, freeVsLight: 2.0 },
      paymentDepth: { minSpendForCompetitiveness: 100, maxEffectiveSpend: 5000 },
      paymentRatios: { freeToPaidRatio: 0.95, lightSpenderShare: 0.035, whaleShare: 0.015 },
    },
    ...overrides,
  };
}

describe("computeMonetizationFromIntent", () => {
  it("generates product value analysis", () => {
    const result = computeMonetizationFromIntent(makeMonetizationIntent());
    expect(result.productValueAnalysis.length).toBe(2);
  });

  it("calculates value per RMB correctly", () => {
    const result = computeMonetizationFromIntent(makeMonetizationIntent());
    const monthly = result.productValueAnalysis.find((p) => p.productId === "monthly_card")!;
    // gem: 3000 * 100 = 300000 (gem-equivalent, exchangeRate=100 gems/RMB)
    // stamina: 100 * 10 = 1000 (gem-equivalent, exchangeRate=10 gems/RMB)
    // total = 301000 gem-equivalents
    // valuePerRMB = 301000 / 30 ≈ 10033.33 gems per RMB
    expect(monthly.totalResourceValue).toBeCloseTo(301000, -2); // rounded to nearest 100
    expect(monthly.valuePerRMB).toBeCloseTo(10033, -2); // rounded to nearest 100
  });

  it("preserves power gap", () => {
    const result = computeMonetizationFromIntent(makeMonetizationIntent());
    expect(result.powerGap.freeVsWhale).toBe(5.0);
    expect(result.powerGap.freeVsLight).toBe(2.0);
  });

  it("preserves payment depth", () => {
    const result = computeMonetizationFromIntent(makeMonetizationIntent());
    expect(result.paymentDepth.minSpendForCompetitiveness).toBe(100);
    expect(result.paymentDepth.maxEffectiveSpend).toBe(5000);
  });

  it("preserves custom payment ratios", () => {
    const result = computeMonetizationFromIntent(makeMonetizationIntent());
    expect(result.paymentRatios.freeToPaidRatio).toBe(0.95);
  });

  it("uses default ratios when not provided", () => {
    const result = computeMonetizationFromIntent({
      moduleType: "monetization",
      decisions: { monetizationModel: "gacha", primaryModel: "gacha", rationale: "test" },
      strategy: {
        paidResources: [{ resourceTypeId: "gem", exchangeRate: 10 }],
        paymentProducts: [],
      },
      anchors: {
        powerGap: { freeVsWhale: 3, freeVsLight: 1.5 },
        paymentDepth: { minSpendForCompetitiveness: 50, maxEffectiveSpend: 2000 },
      },
    });
    expect(result.paymentRatios.freeToPaidRatio).toBe(0.97);
    expect(result.paymentRatios.lightSpenderShare).toBe(0.02);
  });

  it("handles zero price gracefully", () => {
    const result = computeMonetizationFromIntent({
      moduleType: "monetization",
      decisions: { monetizationModel: "gacha", primaryModel: "gacha", rationale: "test" },
      strategy: {
        paidResources: [{ resourceTypeId: "gem", exchangeRate: 10 }],
        paymentProducts: [{ id: "free", name: "免费礼包", category: "one_time" as const, priceRMB: 0, contents: { gem: 100 } }],
      },
      anchors: {
        powerGap: { freeVsWhale: 3, freeVsLight: 1.5 },
        paymentDepth: { minSpendForCompetitiveness: 50, maxEffectiveSpend: 2000 },
      },
    });
    const free = result.productValueAnalysis[0];
    expect(free.valuePerRMB).toBe(0);
  });

  // -----------------------------------------------------------------------
  // gachaCostAnalysis 汇率口径（P1-5 单源化：原兜底 1 收敛为统一兜底 10，
  // 与 gacha 引擎 costExpectation 共享 resolveCurrencyRMB）
  // -----------------------------------------------------------------------
  describe("gachaCostAnalysis exchangeRate (P1-5)", () => {
    const GACHA_PRODUCT = {
      id: "featured",
      name: "限定池",
      currencyType: "gem",
      costPerPull: 160,
      categories: ["character"],
      baseSSRRate: 0.015,
      pity: { hardPity: 90, softPityStart: 74, softPityIncrement: 0.06 },
    };

    function intentWithGachaProduct(
      paidResources: MonetizationDesignIntent["strategy"]["paidResources"]
    ): MonetizationDesignIntent {
      const base = makeMonetizationIntent();
      return {
        ...base,
        strategy: { ...base.strategy, paidResources, gachaProducts: [GACHA_PRODUCT] },
      };
    }

    it("currencyType 命中 paidResources → expectedCostRMB = round(pulls*cost/rate)", () => {
      const result = computeMonetizationFromIntent(intentWithGachaProduct([
        { resourceTypeId: "gem", exchangeRate: 100 },
      ]));
      const row = result.gachaCostAnalysis[0];
      const rates = simulatePityRates(0.015, GACHA_PRODUCT.pity);
      expect(row.expectedCostRMB).toBe(
        Math.round((expectedPullsForRarity(rates) * 160) / 100)
      );
    });

    it("currencyType 未命中 → 统一兜底 10（原兜底 1 收敛，行为变化锁定）", () => {
      const result = computeMonetizationFromIntent(intentWithGachaProduct([
        { resourceTypeId: "stamina", exchangeRate: 10 },
      ]));
      const row = result.gachaCostAnalysis[0];
      const rates = simulatePityRates(0.015, GACHA_PRODUCT.pity);
      expect(row.expectedCostRMB).toBe(
        Math.round((expectedPullsForRarity(rates) * 160) / 10)
      );
    });

    it("两引擎同方案同汇率：未命中兜底时与 gacha 引擎 costExpectation 同 rmb", () => {
      // monetization：currencyType 未命中 paidResources → 兜底 10
      const mon = computeMonetizationFromIntent(intentWithGachaProduct([
        { resourceTypeId: "stamina", exchangeRate: 10 },
      ]));
      // gacha：无 paidResources 表 → 恒兜底 10；同 baseRate/pity/cost 方案
      const gachaIntent: GachaDesignIntent = {
        moduleType: "gacha",
        decisions: { guaranteeType: "dual", targetRarity: "ssr", rationale: "t" },
        strategy: {
          poolDesign: {
            rarities: [
              { id: "ssr", name: "SSR", color: "#ff0", rate: 0.015 },
              { id: "r", name: "R", color: "#ccc", rate: 0.985 },
            ],
          },
          guarantee: {
            type: "dual",
            targetRarity: "ssr",
            hardCount: 90,
            softStart: 74,
            softIncrement: 0.06,
          },
          cost: { singleCost: 160, currency: "gem" },
        },
      };
      const gacha = computeGachaFromIntent(gachaIntent);
      expect(mon.gachaCostAnalysis[0].expectedCostRMB).toBe(
        gacha.costExpectation.perRarity.rmb
      );
    });
  });
});