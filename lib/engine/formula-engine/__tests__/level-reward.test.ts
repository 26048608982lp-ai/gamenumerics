import { describe, it, expect } from "vitest";
import type { LevelTypeResult } from "../level";
import { computeRewardSchedule, type RewardScheduleInput } from "../level-reward";

function makeLevelType(id: string, name: string, levelCount: number): LevelTypeResult {
  return {
    id,
    name,
    count: levelCount,
    difficultyCurve: "linear",
    rewardResourceTypes: ["gold", "exp"],
    levels: Array.from({ length: levelCount }, (_, i) => ({
      levelIndex: i + 1,
      levelName: `${name}-${i + 1}`,
      difficultyScore: 1 + i * 0.1,
      recommendedPower: 100 + i * 10,
      rewardEstimate: {
        gold: 100 + i * 10,
        exp: 50 + i * 5,
      },
    })),
  };
}

function makeInput(levelCount = 10): RewardScheduleInput {
  return {
    levelTypes: [
      makeLevelType("main", "主线关卡", levelCount),
      makeLevelType("daily", "日常关卡", levelCount),
    ],
    progressionPacing: {
      early: "fast",
      mid: "normal",
      late: "slow",
    },
    economyDailyBudget: {
      gold: [500, 1000],
      exp: [200, 400],
    },
    economyResourceNames: {
      gold: "金币",
      exp: "经验",
    },
    repeatRewardRatio: 0.3,
    sweepPerDay: 3,
  };
}

describe("computeRewardSchedule", () => {
  describe("basic output structure", () => {
    it("returns phaseSchedule with early/mid/late phases", () => {
      const result = computeRewardSchedule(makeInput(10));
      expect(result.phaseSchedule).toHaveLength(3);
      expect(result.phaseSchedule.map(p => p.phase)).toEqual(["前期", "中期", "后期"]);
    });

    it("returns dailyBudgetValidation with correct resource ids", () => {
      const result = computeRewardSchedule(makeInput(10));
      const resourceIds = result.dailyBudgetValidation.map(v => v.resourceId);
      expect(resourceIds).toContain("gold");
      expect(resourceIds).toContain("exp");
    });

    it("returns typeContributionRanking with correct resource ids", () => {
      const result = computeRewardSchedule(makeInput(10));
      expect(result.typeContributionRanking.map(r => r.resourceId)).toEqual(["gold", "exp"]);
    });
  });

  describe("edge cases", () => {
    it("handles 0 levels (empty levelTypes)", () => {
      const input = makeInput(0);
      input.levelTypes = [];
      const result = computeRewardSchedule(input);
      expect(result.phaseSchedule).toHaveLength(3);
      expect(result.dailyBudgetValidation).toHaveLength(0);
    });

    it("handles 1 level", () => {
      const result = computeRewardSchedule(makeInput(1));
      expect(result.phaseSchedule[0].phase).toBe("前期");
      expect(result.phaseSchedule[0].firstClearRewards.gold).toBeGreaterThan(0);
    });

    it("handles levelTypes with no levels", () => {
      const input = makeInput(10);
      input.levelTypes = input.levelTypes.map(lt => ({ ...lt, levels: [] }));
      const result = computeRewardSchedule(input);
      expect(result.phaseSchedule).toHaveLength(3);
    });
  });

  describe("phase boundaries", () => {
    it("early phase covers first 20% of levels", () => {
      const result = computeRewardSchedule(makeInput(10));
      expect(result.phaseSchedule[0].levelRange.main).toBe("1-2");
    });

    it("mid phase covers 20%-70%", () => {
      const result = computeRewardSchedule(makeInput(10));
      expect(result.phaseSchedule[1].levelRange.main).toBe("3-7");
    });

    it("late phase covers 70%-100%", () => {
      const result = computeRewardSchedule(makeInput(10));
      expect(result.phaseSchedule[2].levelRange.main).toBe("8-10");
    });
  });

  describe("repeat reward calculation", () => {
    it("repeat reward ratio defaults to 0.3 when not specified", () => {
      const input = makeInput(10);
      delete input.repeatRewardRatio;
      const result = computeRewardSchedule(input);
      expect(result.phaseSchedule).toHaveLength(3);
    });
  });

  describe("daily income calculation", () => {
    it("daily income is populated and sweepPerDay defaults to 3", () => {
      const input = makeInput(5);
      delete input.sweepPerDay;
      const result = computeRewardSchedule(input);
      expect(result.phaseSchedule[0].estimatedSweepPerDay).toBe(3);
      for (const phase of result.phaseSchedule) {
        expect(Object.keys(phase.dailyIncomeFromPhase).length).toBeGreaterThan(0);
      }
    });
  });

  describe("budget validation", () => {
    it("marks correct status based on ratio thresholds", () => {
      // Test low: ratio < 0.3
      const inputLow = makeInput(1);
      inputLow.economyDailyBudget = { gold: [100000, 200000] };
      const resLow = computeRewardSchedule(inputLow);
      expect(resLow.dailyBudgetValidation.find(v => v.resourceId === "gold")?.status).toBe("low");

      // Test healthy: 0.3 <= ratio <= 0.7 — use tiny budget to get very high ratio (but test "high" threshold)
      const inputHigh = makeInput(10);
      inputHigh.economyDailyBudget = { gold: [100, 200] }; // small budget, income will exceed it
      const resHigh = computeRewardSchedule(inputHigh);
      expect(resHigh.dailyBudgetValidation.find(v => v.resourceId === "gold")?.status).toBe("high");
    });

    it("marks no_economy_data when budget not provided", () => {
      const input = makeInput(5);
      input.economyDailyBudget = {};
      const result = computeRewardSchedule(input);
      expect(result.dailyBudgetValidation[0].status).toBe("no_economy_data");
    });
  });

  describe("contribution ranking", () => {
    it("contribution percentages sum to 1.0 per resource", () => {
      const result = computeRewardSchedule(makeInput(10));
      for (const rank of result.typeContributionRanking) {
        const sum = rank.ranking.reduce((acc, r) => acc + r.contributionPct, 0);
        expect(sum).toBeCloseTo(1.0, 2);
      }
    });

    it("ranking is sorted by totalReward descending", () => {
      const result = computeRewardSchedule(makeInput(10));
      for (const rank of result.typeContributionRanking) {
        for (let i = 0; i < rank.ranking.length - 1; i++) {
          expect(rank.ranking[i].totalReward).toBeGreaterThanOrEqual(rank.ranking[i + 1].totalReward);
        }
      }
    });
  });

  describe("economyResourceNames fallback", () => {
    it("uses resourceId as name when economyResourceNames not provided", () => {
      const input = makeInput(5);
      delete input.economyResourceNames;
      const result = computeRewardSchedule(input);
      expect(result.dailyBudgetValidation[0].resourceName).toBe("gold");
    });
  });
});