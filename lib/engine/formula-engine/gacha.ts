// 抽卡系统引擎 — 保底概率模拟和成本计算

import type { GachaDesignIntent } from "./types";
import type { ComputedGachaData } from "@/lib/types/planning";

/**
 * 付费资源兑 RMB 折算率的统一兜底（P1-5 汇率单源化口径锚定点）：
 * exchangeRate 语义 = 1 RMB 可兑换的付费资源数量（resource_per_RMB），
 * RMB = 资源总量 / exchangeRate。取 10 对齐 gacha 引擎原硬编码现行为
 * （保留现值减少行为突变）。
 */
export const DEFAULT_CURRENCY_EXCHANGE_RATE = 10;

/**
 * 汇率单源解析（P1-5）：paidResources 按 currencyType 命中优先，
 * 未命中 / 空表 / 非法汇率（≤0、NaN）统一走兜底 10。
 * gacha 与 monetization 两引擎共同消费，防双口径漂移
 * （monetization 原兜底 1 已收敛至此）。
 */
export function resolveCurrencyRMB(
  paidResources:
    | Array<{ resourceTypeId: string; exchangeRate: number }>
    | undefined,
  currencyType: string,
): number {
  const hit = paidResources?.find(
    (pr) => pr.resourceTypeId === currencyType,
  );
  return hit && Number.isFinite(hit.exchangeRate) && hit.exchangeRate > 0
    ? hit.exchangeRate
    : DEFAULT_CURRENCY_EXCHANGE_RATE;
}

export interface PityConfig {
  hardPity: number;
  softPityStart: number;
  softPityIncrement: number;
}

/**
 * 模拟从第1抽到hardPity抽的SSR概率递增
 * 返回每抽的实际SSR概率数组
 */
export function simulatePityRates(
  baseRate: number,
  config: PityConfig,
): number[] {
  const rates: number[] = [];
  for (let pull = 1; pull <= config.hardPity; pull++) {
    if (pull === config.hardPity) {
      rates.push(1.0);
    } else if (pull >= config.softPityStart) {
      const increments = pull - config.softPityStart + 1;
      rates.push(Math.min(baseRate + increments * config.softPityIncrement, 1.0));
    } else {
      rates.push(baseRate);
    }
  }
  return rates;
}

/**
 * 计算到第N抽时的累计SSR获得概率
 * 使用 1 - ∏(1 - rate_i) 计算
 */
export function cumulativeProbabilities(rates: number[]): number[] {
  const cumulative: number[] = [];
  let noSSR = 1.0;
  for (const rate of rates) {
    noSSR *= (1 - rate);
    cumulative.push(1 - noSSR);
  }
  return cumulative;
}

/**
 * 计算期望出SSR的抽数（加权平均）
 */
export function expectedPullsForRarity(rates: number[]): number {
  const cumulative = cumulativeProbabilities(rates);
  const hardPity = rates.length;

  let expectedPulls = 0;
  let prevProb = 0;
  for (let i = 0; i < cumulative.length; i++) {
    const probAtThisPull = cumulative[i] - prevProb;
    expectedPulls += (i + 1) * probAtThisPull;
    prevProb = cumulative[i];
  }

  return Math.round(expectedPulls * 10) / 10;
}

/**
 * 计算期望RMB成本
 */
export function expectedCostPerRarity(
  costPerPull: number,
  exchangeRate: number,
  rates: number[],
): { rmb: number; pulls: number } {
  const pulls = expectedPullsForRarity(rates);
  const totalCurrency = pulls * costPerPull;
  const rmb = Math.round(totalCurrency / exchangeRate);
  return { rmb, pulls: Math.round(pulls) };
}

/**
 * 计算每月免费抽数
 */
export function monthlyFreePulls(
  dailyFreeIncome: number,
  costPerPull: number,
): number {
  return Math.floor((dailyFreeIncome * 30) / costPerPull);
}

export interface GachaConfig {
  baseRate: number;
  pity: PityConfig;
  rarities?: string[];
}

export interface SimulationResult {
  averagePulls: number;
  medianPulls: number;
  stdDev: number;
  distribution: Map<number, number>;
  /** 总抽数分布（抽满 K 只目标）的经验分位 */
  percentiles: { p50: number; p90: number };
}

/**
 * 经验分位数 — 线性插值法（Hyndman & Fan type 7，numpy/R 默认）：
 * index = q × (n-1)，在相邻两个次序统计量之间线性插值。
 * q=0.5 时与 medianPulls 的奇偶分支定义精确一致（样本为整数抽数，
 * 两条计算路径均无浮点误差）。
 */
function empiricalPercentile(sorted: number[], q: number): number {
  const n = sorted.length;
  const index = q * (n - 1);
  const lower = Math.floor(index);
  const upper = Math.min(lower + 1, n - 1);
  const frac = index - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * frac;
}

/**
 * Monte Carlo 模拟抽卡
 * 执行 iterations 次抽卡模拟，每次连续抽中第 K（targetCount）只目标才停止，
 * 收集每次的总抽数，返回统计数据和分布
 *
 * 数学依据：保底计数器在每次命中后归零并从 rates[0] 重走（rates 按"距上次
 * 命中"索引），因此每次获取目标的抽数分布完全相同且相互独立（i.i.d.），
 * 故 E[第 K 只总抽数] = K × E[单只] 精确成立，软保底交互不影响该恒等式。
 *
 * @param random 随机数生成器，默认 Math.random。
 *   可注入确定性函数以实现可复现的测试。
 * @param targetCount 目标获取只数 K（默认 1，向后兼容）。
 *   必须为正整数，否则抛出错误（防止上游错误值静默产出"0 抽"结果）。
 *
 * 注意：使用 Math.random() 而非 crypto.getRandomValues()
 * 因为 Monte Carlo 模拟不需要密码学安全的随机数，
 * Math.random() 的性能优势更重要
 */
export function runGachaSimulation(
  config: GachaConfig,
  iterations: number,
  random: () => number = Math.random,
  targetCount: number = 1,
): SimulationResult {
  if (!Number.isInteger(targetCount) || targetCount <= 0) {
    throw new Error(
      `runGachaSimulation: targetCount must be a positive integer, received ${targetCount}`,
    );
  }

  const rates = simulatePityRates(config.baseRate, config.pity);
  const hardPity = config.pity.hardPity;
  const pulls: number[] = [];

  for (let i = 0; i < iterations; i++) {
    let pullCount = 0;
    for (let hit = 0; hit < targetCount; hit++) {
      // 单只获取循环：pity 计数器由 0 起步，每次命中后归零重走 rates
      let pityPulls = 0;
      while (pityPulls < hardPity) {
        pityPulls++;
        pullCount++;
        if (random() < rates[pityPulls - 1]) {
          break;
        }
      }
    }
    pulls.push(pullCount);
  }

  // 计算平均值
  const sum = pulls.reduce((a, b) => a + b, 0);
  const averagePulls = sum / iterations;

  // 计算中位数
  const sorted = [...pulls].sort((a, b) => a - b);
  const mid = Math.floor(iterations / 2);
  const medianPulls = iterations % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];

  // 计算标准差
  const squaredDiffs = pulls.map(p => Math.pow(p - averagePulls, 2));
  const avgSquaredDiff = squaredDiffs.reduce((a, b) => a + b, 0) / iterations;
  const stdDev = Math.sqrt(avgSquaredDiff);

  // 计算分布 (Map<抽数, 频率>)
  const distMap = new Map<number, number>();
  for (const p of pulls) {
    distMap.set(p, (distMap.get(p) || 0) + 1);
  }
  // 转换为频率
  const distribution = new Map<number, number>();
  for (const [k, v] of distMap) {
    distribution.set(k, v / iterations);
  }

  // 经验分位（复用 sorted，线性插值法见 empiricalPercentile 注释）
  const percentiles = {
    p50: empiricalPercentile(sorted, 0.5),
    p90: empiricalPercentile(sorted, 0.9),
  };

  return { averagePulls, medianPulls, stdDev, distribution, percentiles };
}

/**
 * 生成关键节点的概率表
 */
export function generateProbabilityTable(
  baseRate: number,
  config: PityConfig,
  checkpoints?: number[],
): Array<{ pulls: number; ssrRate: number; cumulativeChance: number }> {
  const rates = simulatePityRates(baseRate, config);
  const cumulative = cumulativeProbabilities(rates);

  const pulls = checkpoints || [1, 10, 20, 50, 60, 73, 74, 75, 76, 77, 78, 79, 80, 85, 90];

  return pulls
    .filter((p) => p <= config.hardPity)
    .map((p) => ({
      pulls: p,
      ssrRate: Math.round(rates[p - 1] * 10000) / 10000,
      cumulativeChance: Math.round(cumulative[p - 1] * 10000) / 10000,
    }));
}

// ==================== 入口函数 ====================

/**
 * 计算结果类型 = lib/types 单源别名（Re.E1-1）：形状权威在 ComputedGachaData
 * （不入 ComputedPlanningData 联合——distribution 为 Map 不可序列化 quirk，
 * 见 lib/types/planning.ts ComputedGachaData 注释）。导出名保留，消费方零改动。
 */
export type GachaComputeResult = ComputedGachaData;

/**
 * 从 GachaDesignIntent 提取模拟/概率计算所需的 GachaConfig + 单抽成本。
 *
 * 单源实现（TD-2026-08-24-10 收敛，v6w4）：computeGachaFromIntent 消费本函数。
 * 提参口径：targetRarity 按 id/name 匹配 + 最高 rate 兜底；pityConfig 构造。
 */
export function buildGachaConfigFromIntent(
  intent: GachaDesignIntent,
): { config: GachaConfig; singleCost: number } {
  const { decisions, strategy } = intent;
  const rarities = strategy.poolDesign.rarities;

  // 提取目标稀有度的基础概率（按 id 或 name 匹配，取不到则用最高 rate）
  const targetRarity = rarities.find(
    (r) => r.id === decisions.targetRarity || r.name === decisions.targetRarity,
  );
  const baseRate = targetRarity
    ? targetRarity.rate
    : Math.max(...rarities.map((r) => r.rate));

  // 构建 PityConfig；guarantee.type='none' 时 hardPity 设大值等效无保底
  const guarantee = strategy.guarantee;
  const pityConfig: PityConfig =
    guarantee.type === "none"
      ? { hardPity: 9999, softPityStart: 9999, softPityIncrement: 0.06 }
      : {
          hardPity: guarantee.hardCount,
          softPityStart: guarantee.softStart ?? guarantee.hardCount,
          softPityIncrement: guarantee.softIncrement ?? 0.06,
        };

  return { config: { baseRate, pity: pityConfig }, singleCost: strategy.cost.singleCost };
}

/**
 * 从 GachaDesignIntent 计算完整的抽卡数值方案。
 * 组合 simulatePityRates / generateProbabilityTable / runGachaSimulation 等工具函数。
 *
 * @param intent 抽卡设计意图（moduleType: "gacha"）
 * @returns 完整的概率表、模拟结果、成本期望
 */
export function computeGachaFromIntent(intent: GachaDesignIntent): GachaComputeResult {
  const { decisions, strategy } = intent;
  const { config, singleCost } = buildGachaConfigFromIntent(intent);
  const baseRate = config.baseRate;
  const pityConfig = config.pity;

  const rates = simulatePityRates(baseRate, pityConfig);

  // exchangeRate: 游戏币兑换 RMB 比率——gacha intent 无 paidResources 表，
  // 恒走 resolveCurrencyRMB 统一兜底 10（P1-5 单源化，原硬编码 10 行为不变）
  // dailyFreeIncome: 每日免费产出（默认 100）
  const cost = strategy.cost;
  const exchangeRate = resolveCurrencyRMB(undefined, cost.currency);
  const dailyFreeIncome = 100;

  // tenCost 缺省时引擎派生：十连抽行业惯例 9 折 → round(singleCost × 10 × 0.9)。
  // 构建新的 cost/strategy 对象返回，不修改传入的 intent（纯函数非变异）。
  const resolvedStrategy: GachaDesignIntent["strategy"] =
    cost.tenCost === undefined
      ? {
          ...strategy,
          cost: { ...cost, tenCost: Math.round(cost.singleCost * 10 * 0.9) },
        }
      : strategy;

  return {
    moduleType: "gacha" as const,
    probabilityTable: generateProbabilityTable(baseRate, pityConfig),
    simulation: runGachaSimulation(config, 10000),
    cumulativeRates: cumulativeProbabilities(rates),
    expectedPulls: expectedPullsForRarity(rates),
    costExpectation: {
      perRarity: expectedCostPerRarity(singleCost, exchangeRate, rates),
      monthlyFreePulls: monthlyFreePulls(dailyFreeIncome, singleCost),
    },
    decisions,
    strategy: resolvedStrategy,
  };
}

/**
 * 分层概率池抽取模拟 — 无保底的分层概率结构（rogue 技能三选一池、宝箱品质掉落等）
 *
 * 与 runGachaSimulation（保底模型）互补：本模拟面向「每抽独立、按层概率命中」
 * 的结构，回答「N 次抽取后各层出现次数的分布与分位」。
 */

export interface TieredPoolTier {
  /** 层名（如 技能类型/品质名） */
  name: string;
  /** 该层单次抽取命中率，各层之和必须 ≈ 1 */
  rate: number;
}

export interface TierQuantiles {
  p10: number;
  p50: number;
  p90: number;
}

export interface TieredPoolResult {
  draws: number;
  iterations: number;
  /** 各层期望次数 = rate × draws */
  expected: Record<string, number>;
  /** 各层平均出现次数（模拟口径） */
  observed: Record<string, number>;
  /** 各层出现次数的经验分位 */
  quantiles: Record<string, TierQuantiles>;
}

function quantile(sorted: number[], p: number): number {
  return sorted[Math.round(p * (sorted.length - 1))];
}

export function simulateTieredDraws(
  tiers: TieredPoolTier[],
  draws: number,
  random: () => number = Math.random,
  iterations = 1000,
): TieredPoolResult {
  if (tiers.length === 0) throw new Error("simulateTieredDraws: 层列表不能为空");
  if (!Number.isInteger(draws) || draws <= 0) {
    throw new Error(`simulateTieredDraws: draws 必须为正整数，received ${draws}`);
  }
  if (!Number.isInteger(iterations) || iterations <= 0) {
    throw new Error(`simulateTieredDraws: iterations 必须为正整数，received ${iterations}`);
  }
  const rateSum = tiers.reduce((s, t) => s + t.rate, 0);
  if (Math.abs(rateSum - 1) > 0.001) {
    throw new Error(`simulateTieredDraws: 各层概率之和必须为 1，当前 ${rateSum}`);
  }

  const totalByTier: Record<string, number[]> = {};
  for (const t of tiers) totalByTier[t.name] = [];

  for (let i = 0; i < iterations; i += 1) {
    const counts: Record<string, number> = {};
    for (const t of tiers) counts[t.name] = 0;
    for (let d = 0; d < draws; d += 1) {
      const r = random();
      let acc = 0;
      for (const t of tiers) {
        acc += t.rate;
        if (r < acc) {
          counts[t.name] += 1;
          break;
        }
      }
    }
    for (const t of tiers) totalByTier[t.name].push(counts[t.name]);
  }

  const expected: Record<string, number> = {};
  const observed: Record<string, number> = {};
  const quantiles: Record<string, TierQuantiles> = {};
  for (const t of tiers) {
    const arr = totalByTier[t.name];
    expected[t.name] = Number((t.rate * draws).toFixed(2));
    observed[t.name] = Number((arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(2));
    const sorted = [...arr].sort((a, b) => a - b);
    quantiles[t.name] = {
      p10: quantile(sorted, 0.1),
      p50: quantile(sorted, 0.5),
      p90: quantile(sorted, 0.9),
    };
  }

  return { draws, iterations, expected, observed, quantiles };
}
