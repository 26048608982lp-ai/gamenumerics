import type { MonetizationDesignIntent } from "./types";
import {
  simulatePityRates,
  expectedPullsForRarity,
  generateProbabilityTable,
  resolveCurrencyRMB,
} from "./gacha";
import type { PityConfig } from "./gacha";
import type { ComputedMonetizationData } from "@/lib/types/planning";

/**
 * 产品性价比行 / 抽卡成本行（type alias 而非 interface：
 * ComputedMonetizationData 对应字段为 Array<Record<string, unknown>>，
 * type alias 对象形状带隐式索引签名方可赋入）
 */
type ProductValueRow = {
  productId: string;
  productName: string;
  category: string;
  priceRMB: number;
  totalResourceValue: number;
  valuePerRMB: number;
  contents: Record<string, number>;
};

type GachaCostRow = {
  poolId: string;
  poolName: string;
  baseSSRRate: number;
  hardPity: number;
  expectedPulls: number;
  expectedCostRMB: number;
  guaranteedCostRMB: number;
  probabilityCheckpoints: Array<{ pulls: number; ssrRate: number; cumulativeChance: number }>;
};

/** 计算结果类型 = lib/types 单源别名（Re.E1-1，含 moduleType 判别键） */
type MonetizationComputeResult = ComputedMonetizationData;

export function computeMonetizationFromIntent(
  intent: MonetizationDesignIntent
): MonetizationComputeResult {
  const { strategy, anchors } = intent;
  const { paidResources, paymentProducts } = strategy;
  const { powerGap, paymentDepth, paymentRatios } = anchors;

  // 构建汇率映射
  const exchangeMap: Record<string, number> = {};
  for (const pr of paidResources) {
    exchangeMap[pr.resourceTypeId] = pr.exchangeRate;
  }

  // 产品性价比分析
  const productValueAnalysis: ProductValueRow[] = paymentProducts.map((pp) => {
    let totalResourceValue = 0;
    for (const [resourceId, amount] of Object.entries(pp.contents)) {
      const rate = exchangeMap[resourceId] || 1;
      // exchangeRate: 1 RMB 可兑换的资源数量（resource_per_RMB）
      totalResourceValue += amount * rate;
    }

    const valuePerRMB = pp.priceRMB > 0 ? totalResourceValue / pp.priceRMB : 0;

    return {
      productId: pp.id,
      productName: pp.name,
      category: pp.category,
      priceRMB: pp.priceRMB,
      totalResourceValue: Math.round(totalResourceValue * 100) / 100,
      valuePerRMB: Math.round(valuePerRMB * 100) / 100,
      contents: pp.contents,
    };
  });

  // Gacha cost analysis — integrate gacha.ts engine
  const gachaCostAnalysis: GachaCostRow[] = [];
  if (strategy.gachaProducts && strategy.gachaProducts.length > 0) {
    for (const gp of strategy.gachaProducts) {
      const baseRate = gp.baseSSRRate ?? 0.015;
      const pityConfig: PityConfig = gp.pity
        ? {
            hardPity: gp.pity.hardPity,
            softPityStart: gp.pity.softPityStart,
            softPityIncrement: gp.pity.softPityIncrement,
          }
        : { hardPity: 90, softPityStart: 74, softPityIncrement: 0.06 };

      const rates = simulatePityRates(baseRate, pityConfig);
      const expectedPulls = expectedPullsForRarity(rates);
      // 汇率单源化（P1-5）：paidResources 命中优先、统一兜底 10（原兜底 1 收敛，
      // 与 gacha 引擎 costExpectation 共享 resolveCurrencyRMB，防双口径漂移）
      const currencyExchangeRate = resolveCurrencyRMB(paidResources, gp.currencyType);
      const expectedCostRMB = Math.round((expectedPulls * gp.costPerPull) / currencyExchangeRate);
      const guaranteedCostRMB = Math.round((pityConfig.hardPity * gp.costPerPull) / currencyExchangeRate);

      const probabilityCheckpoints = generateProbabilityTable(baseRate, pityConfig);

      gachaCostAnalysis.push({
        poolId: gp.id,
        poolName: gp.name,
        baseSSRRate: baseRate,
        hardPity: pityConfig.hardPity,
        expectedPulls,
        expectedCostRMB,
        guaranteedCostRMB,
        probabilityCheckpoints,
      });
    }
  }

  return {
    moduleType: "monetization" as const,
    paidResources,
    paymentProducts,
    productValueAnalysis,
    gachaCostAnalysis,
    paymentRatios: paymentRatios || {
      freeToPaidRatio: 0.97,
      lightSpenderShare: 0.02,
      whaleShare: 0.01,
    },
    paymentDepth,
    powerGap,
  };
}
