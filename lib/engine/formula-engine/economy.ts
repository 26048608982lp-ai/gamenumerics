import type { EconomyDesignIntent } from "./types";
import type { ComputedEconomyData } from "@/lib/types/planning";

/**
 * 每日预算表行（type alias 而非 interface：ComputedEconomyData.dailyBudgetTable 为
 * Array<Record<string, unknown>>，type alias 对象形状带隐式索引签名方可赋入）
 */
export type DailyBudgetRow = {
  resourceId: string;
  resourceName: string;
  isPremium: boolean;
  dailyProductionCasual: number;
  dailyProductionAverage: number;
  dailyProductionHardcore: number;
  dailyConsumption: number;
  netFlowCasual: number;
  netFlowAverage: number;
  netFlowHardcore: number;
  balanceStatus: "healthy" | "deficit" | "surplus";
};

export interface ValueChainResult {
  exchangeRates: Array<{
    fromResource: string;
    toResource: string;
    rate: number;
    direction: "one_way" | "two_way";
    description: string;
  }>;
  valueHierarchy: Array<{
    tier: number;
    resources: string[];
    description: string;
  }>;
  inflationControl: {
    dailyCapByResource: Record<string, number>;
    sinkEfficiencyTarget: Record<string, number>;
  };
}

/**
 * 计算结果类型 = lib/types 单源别名（Re.E1-1）：形状权威在 ComputedEconomyData
 * （含 moduleType 判别键 + resourceBalanceTable/consumptionSplit 可选回显键），
 * 此名仅为消费方可读性保留（导出名不变，消费方零改动）。
 */
export type EconomyComputeResult = ComputedEconomyData;

function computeBalanceStatus(
  netFlowCasual: number,
  netFlowAverage: number,
  netFlowHardcore: number,
): "healthy" | "deficit" | "surplus" {
  const flows = [netFlowCasual, netFlowAverage, netFlowHardcore];
  if (flows.every((f) => f > 0)) return "surplus";
  if (flows.every((f) => f < 0)) return "deficit";
  return "healthy";
}

export function computeDailyBudget(
  resourceTypes: Array<{ id: string; name: string; isPremium: boolean }>,
  dailyBudget: Record<string, [number, number]>,
  productionConsumptionRatio: Record<string, number>,
): DailyBudgetRow[] {
  return resourceTypes.map((rt) => {
    const budgetRange = dailyBudget[rt.id] || [100, 500];
    const targetRatio = productionConsumptionRatio[rt.id] || 1.0;

    const dailyProductionAverage = Math.round((budgetRange[0] + budgetRange[1]) / 2);
    const dailyProductionCasual = Math.round(budgetRange[0]);
    const dailyProductionHardcore = Math.round(budgetRange[1]);
    const dailyConsumption = Math.round(dailyProductionAverage / targetRatio);

    const netFlowCasual = dailyProductionCasual - dailyConsumption;
    const netFlowAverage = dailyProductionAverage - dailyConsumption;
    const netFlowHardcore = dailyProductionHardcore - dailyConsumption;

    return {
      resourceId: rt.id,
      resourceName: rt.name,
      isPremium: rt.isPremium,
      dailyProductionCasual,
      dailyProductionAverage,
      dailyProductionHardcore,
      dailyConsumption,
      netFlowCasual,
      netFlowAverage,
      netFlowHardcore,
      balanceStatus: computeBalanceStatus(netFlowCasual, netFlowAverage, netFlowHardcore),
    };
  });
}

export function computeEconomyFromIntent(
  intent: EconomyDesignIntent
): EconomyComputeResult {
  const { strategy, anchors } = intent;
  const { resourceTypes, itemTypes } = strategy;
  const { dailyBudget, productionConsumptionRatio } = anchors;

  const dailyBudgetTable = computeDailyBudget(resourceTypes, dailyBudget, productionConsumptionRatio);

  // 生成价值链
  const freeResources = resourceTypes.filter((rt) => !rt.isPremium);
  const premiumResources = resourceTypes.filter((rt) => rt.isPremium);
  const valueChain = computeValueChain(freeResources, premiumResources, dailyBudget);

  return {
    moduleType: "economy" as const,
    resourceTypes: resourceTypes.map((rt) => ({
      ...rt,
      dailyBudgetRange: dailyBudget[rt.id] || [100, 500],
    })),
    itemTypes: strategy.itemTypes ?? [],
    dailyBudgetTable,
    productionConsumptionRatio,
    valueChain,
    // intent 根级字段回显（V6-W9 §2.2：修复 B 形态 computedData 丢失 consumptionSplit；
    // E1-2 起为唯一回显位——index.ts 不再并入 _strategy）
    consumptionSplit: intent.consumptionSplit,
  };
}

function computeValueChain(
  freeResources: Array<{ id: string; name: string }>,
  premiumResources: Array<{ id: string; name: string }>,
  dailyBudget: Record<string, [number, number]>,
): ValueChainResult {
  const allResources = [...freeResources, ...premiumResources];

  // 价值层级
  const valueHierarchy: ValueChainResult["valueHierarchy"] = [];
  if (freeResources.length > 0) {
    valueHierarchy.push({ tier: 1, resources: freeResources.map((r) => r.id), description: "基础免费资源" });
  }
  if (premiumResources.length > 0) {
    valueHierarchy.push({ tier: 2, resources: premiumResources.map((r) => r.id), description: "高级付费资源" });
  }

  // 日产出上限和消耗效率
  const dailyCapByResource: Record<string, number> = {};
  const sinkEfficiencyTarget: Record<string, number> = {};
  for (const res of allResources) {
    const range = dailyBudget[res.id] || [100, 500];
    dailyCapByResource[res.id] = range[1];
    sinkEfficiencyTarget[res.id] = premiumResources.some((p) => p.id === res.id) ? 0.85 : 0.9;
  }

  // 生成跨层级汇率：free -> premium
  const exchangeRates: ValueChainResult["exchangeRates"] = [];
  if (freeResources.length > 0 && premiumResources.length > 0) {
    for (const free of freeResources) {
      const freeCap = dailyCapByResource[free.id] || 500;
      for (const premium of premiumResources) {
        const premiumCap = dailyCapByResource[premium.id] || 500;
        const rate = Math.round((freeCap / premiumCap) * 1000) / 1000;
        exchangeRates.push({
          fromResource: free.id,
          toResource: premium.id,
          rate,
          direction: "one_way",
          description: `${free.id} → ${premium.id} (购买力平价: ${rate})`,
        });
      }
    }
  }

  return {
    exchangeRates,
    valueHierarchy,
    inflationControl: { dailyCapByResource, sinkEfficiencyTarget },
  };
}
