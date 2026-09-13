import { STAGE_BOUNDS_DEFAULT } from "./stages";
import type { LevelTypeResult } from "./level";

export interface RewardScheduleInput {
  levelTypes: LevelTypeResult[];
  progressionPacing: { early: string; mid: string; late: string };
  economyDailyBudget?: Record<string, [number, number]>;
  economyResourceNames?: Record<string, string>;
  repeatRewardRatio?: number;
  sweepPerDay?: number;
}

export interface PhaseScheduleRow {
  phase: string;
  levelRange: Record<string, string>;
  firstClearRewards: Record<string, number>;
  repeatRewards: Record<string, number>;
  estimatedSweepPerDay: number;
  dailyIncomeFromPhase: Record<string, number>;
}

export interface BudgetValidationRow {
  resourceId: string;
  resourceName: string;
  dailyLevelIncome: number;
  dailyBudgetAverage: number;
  ratio: number;
  status: "healthy" | "low" | "high" | "no_economy_data";
}

export interface ContributionRank {
  resourceId: string;
  ranking: Array<{
    levelTypeId: string;
    levelTypeName: string;
    totalReward: number;
    contributionPct: number;
  }>;
}

export interface RewardScheduleResult {
  phaseSchedule: PhaseScheduleRow[];
  dailyBudgetValidation: BudgetValidationRow[];
  typeContributionRanking: ContributionRank[];
}

export function computeRewardSchedule(
  input: RewardScheduleInput
): RewardScheduleResult {
  const {
    levelTypes,
    economyDailyBudget,
    economyResourceNames = {},
    repeatRewardRatio = 0.3,
    sweepPerDay = 3,
  } = input;

  // 1. Phase schedule: early=[1, count*earlyEnd], mid=(count*earlyEnd, count*lateStart], late=(count*lateStart, count]
  // 阶段边界消费 STAGE_BOUNDS_DEFAULT 单源（V8 W2-T1）——0.2/0.7 恰为迁入前现值，输出恒等
  const [earlyEnd, lateStart] = STAGE_BOUNDS_DEFAULT;
  const phaseSchedule: PhaseScheduleRow[] = [];
  const phases = [
    { label: "前期", startFrac: 0, endFrac: earlyEnd },
    { label: "中期", startFrac: earlyEnd, endFrac: lateStart },
    { label: "后期", startFrac: lateStart, endFrac: 1.0 },
  ];

  // Collect all resource IDs across level types
  const allResourceIds: string[] = [];
  const seenRids = new Set<string>();
  for (const lt of levelTypes) {
    for (const lvl of lt.levels) {
      for (const rid of Object.keys(lvl.rewardEstimate)) {
        if (!seenRids.has(rid)) {
          seenRids.add(rid);
          allResourceIds.push(rid);
        }
      }
    }
  }

  for (const phase of phases) {
    const levelRange: Record<string, string> = {};
    const firstClearRewards: Record<string, number> = {};
    const repeatRewards: Record<string, number> = {};
    const dailyIncomeFromPhase: Record<string, number> = {};

    // Initialize
    for (const rid of allResourceIds) {
      firstClearRewards[rid] = 0;
      repeatRewards[rid] = 0;
      dailyIncomeFromPhase[rid] = 0;
    }

    for (const lt of levelTypes) {
      const effectiveCount = lt.levels.length;
      if (effectiveCount === 0) {
        levelRange[lt.id] = "-";
        continue;
      }

      const startIdx = Math.min(
        Math.floor(effectiveCount * phase.startFrac),
        effectiveCount - 1
      );
      const endIdx = Math.min(effectiveCount, Math.ceil(effectiveCount * phase.endFrac));
      levelRange[lt.id] = `${startIdx + 1}-${endIdx}`;

      const phaseLevelCount = endIdx - startIdx;

      for (let i = startIdx; i < endIdx; i++) {
        const lvl = lt.levels[i];
        for (const [rid, amount] of Object.entries(lvl.rewardEstimate)) {
          firstClearRewards[rid] += Number(amount) || 0;
        }
      }

      // Repeat reward per level (average), then × sweep count
      if (phaseLevelCount > 0) {
        for (const rid of allResourceIds) {
          const avgFirstClear = firstClearRewards[rid] / phaseLevelCount;
          const repeatPerLevel = Math.round(avgFirstClear * repeatRewardRatio);
          repeatRewards[rid] += repeatPerLevel * phaseLevelCount;
          dailyIncomeFromPhase[rid] += repeatPerLevel * sweepPerDay;
        }
      }
    }

    phaseSchedule.push({
      phase: phase.label,
      levelRange,
      firstClearRewards,
      repeatRewards,
      estimatedSweepPerDay: sweepPerDay,
      dailyIncomeFromPhase,
    });
  }

  // 2. Daily budget validation
  const dailyBudgetValidation: BudgetValidationRow[] = [];

  // Total daily level income across all phases
  const totalDailyLevelIncome: Record<string, number> = {};
  for (const rid of allResourceIds) {
    totalDailyLevelIncome[rid] = 0;
  }
  for (const ps of phaseSchedule) {
    for (const [rid, amount] of Object.entries(ps.dailyIncomeFromPhase)) {
      totalDailyLevelIncome[rid] = (totalDailyLevelIncome[rid] || 0) + amount;
    }
  }

  for (const rid of allResourceIds) {
    const budgetRange = economyDailyBudget?.[rid];
    if (!budgetRange) {
      dailyBudgetValidation.push({
        resourceId: rid,
        resourceName: economyResourceNames[rid] || rid,
        dailyLevelIncome: totalDailyLevelIncome[rid] || 0,
        dailyBudgetAverage: 0,
        ratio: 0,
        status: "no_economy_data",
      });
      continue;
    }

    const avgBudget = (budgetRange[0] + budgetRange[1]) / 2;
    const levelIncome = totalDailyLevelIncome[rid] || 0;
    const ratio = avgBudget > 0 ? levelIncome / avgBudget : 0;

    let status: BudgetValidationRow["status"];
    if (ratio < 0.3) status = "low";
    else if (ratio > 0.7) status = "high";
    else status = "healthy";

    dailyBudgetValidation.push({
      resourceId: rid,
      resourceName: economyResourceNames[rid] || rid,
      dailyLevelIncome: levelIncome,
      dailyBudgetAverage: Math.round(avgBudget),
      ratio: Math.round(ratio * 100) / 100,
      status,
    });
  }

  // 3. Type contribution ranking by resource
  const typeContributionRanking: ContributionRank[] = [];

  for (const rid of allResourceIds) {
    const ranking: ContributionRank["ranking"] = [];
    let totalForResource = 0;

    for (const lt of levelTypes) {
      let totalReward = 0;
      for (const lvl of lt.levels) {
        totalReward += lvl.rewardEstimate[rid] || 0;
      }
      totalForResource += totalReward;
      ranking.push({
        levelTypeId: lt.id,
        levelTypeName: lt.name,
        totalReward,
        contributionPct: 0,
      });
    }

    // Normalize to sum = 1.0
    for (const r of ranking) {
      r.contributionPct = totalForResource > 0
        ? Math.round((r.totalReward / totalForResource) * 1000) / 1000
        : 0;
    }

    // Sort by contribution descending
    ranking.sort((a, b) => b.totalReward - a.totalReward);

    typeContributionRanking.push({
      resourceId: rid,
      ranking,
    });
  }

  return {
    phaseSchedule,
    dailyBudgetValidation,
    typeContributionRanking,
  };
}
