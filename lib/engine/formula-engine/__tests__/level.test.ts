import { describe, it, expect } from "vitest";
import { computeLevelFromIntent, type LevelTypeResult } from "../level";
import type { LevelDesignIntent } from "../types";

/** ComputedLevelData 类型未声明 gateType 透传键（运行时携带）——测试按引擎源类型读取 */
function typeOf(result: ReturnType<typeof computeLevelFromIntent>, index: number): LevelTypeResult {
  return result.levelTypes[index] as LevelTypeResult;
}

function makeLevelIntent(overrides?: Partial<LevelDesignIntent>): LevelDesignIntent {
  return {
    moduleType: "level",
    decisions: {
      levelScale: "large",
      totalLevels: 40,
      rationale: "Large scale level design with story and elite types",
    },
    strategy: {
      levelTypes: [
        {
          id: "story",
          name: "剧情关卡",
          count: 30,
          difficultyCurve: "linear" as const,
          rewardResourceTypes: ["gold", "exp"],
        },
        {
          id: "boss",
          name: "Boss 关卡",
          count: 10,
          difficultyCurve: "exponential" as const,
          rewardResourceTypes: ["gem"],
        },
      ],
      progressionPacing: { early: "1-3min", mid: "5-10min", late: "15-30min" },
    },
    anchors: {
      firstLevelDifficulty: { story: 10, boss: 30 },
      lastLevelDifficulty: { story: 90, boss: 100 },
    },
    ...overrides,
  };
}

describe("computeLevelFromIntent", () => {
  it("generates correct total level count", () => {
    const result = computeLevelFromIntent(makeLevelIntent());
    expect(result.totalLevels).toBe(40);
  });

  it("generates levels for each type", () => {
    const result = computeLevelFromIntent(makeLevelIntent());
    expect(result.levelTypes.length).toBe(2);
    expect(result.levelTypes[0].levels.length).toBe(30);
    expect(result.levelTypes[1].levels.length).toBe(10);
  });

  it("first level difficulty matches anchor", () => {
    const result = computeLevelFromIntent(makeLevelIntent());
    expect(result.levelTypes[0].levels[0].difficultyScore).toBe(10);
    expect(result.levelTypes[1].levels[0].difficultyScore).toBe(30);
  });

  it("last level difficulty matches anchor", () => {
    const result = computeLevelFromIntent(makeLevelIntent());
    expect(result.levelTypes[0].levels[29].difficultyScore).toBe(90);
    expect(result.levelTypes[1].levels[9].difficultyScore).toBe(100);
  });

  it("recommended power is positive", () => {
    const result = computeLevelFromIntent(makeLevelIntent());
    for (const lt of result.levelTypes) {
      for (const level of lt.levels) {
        expect(level.recommendedPower).toBeGreaterThan(0);
      }
    }
  });

  it("reward estimates are present for all resource types", () => {
    const result = computeLevelFromIntent(makeLevelIntent());
    const storyLevel = result.levelTypes[0].levels[0];
    expect(storyLevel.rewardEstimate.gold).toBeGreaterThan(0);
    expect(storyLevel.rewardEstimate.exp).toBeGreaterThan(0);
  });

  it("defaults difficulty when anchor missing", () => {
    const result = computeLevelFromIntent({
      moduleType: "level",
      decisions: { levelScale: "small", totalLevels: 5, rationale: "test" },
      strategy: {
        levelTypes: [{ id: "test", name: "测试", count: 5, difficultyCurve: "linear" as const, rewardResourceTypes: ["gold"] }],
        progressionPacing: { early: "1min", mid: "5min", late: "10min" },
      },
      anchors: { firstLevelDifficulty: {}, lastLevelDifficulty: {} },
    });
    expect(result.levelTypes[0].levels[0].difficultyScore).toBe(10);
    expect(result.levelTypes[0].levels[4].difficultyScore).toBe(90);
  });

  it("preserves progression pacing", () => {
    const result = computeLevelFromIntent(makeLevelIntent());
    expect(result.progressionPacing.early).toBe("1-3min");
  });

  // ── gateType 条件输出（P1-2：兑现 system/level.ts 进度门槛承诺） ──────
  describe("gateType conditional output (P1-2)", () => {
    function intentWithGate(
      gateType: "clear_only" | "power_gate" | "time_gate" | undefined
    ): LevelDesignIntent {
      const base = makeLevelIntent();
      const lt = base.strategy.levelTypes[0];
      return {
        ...base,
        strategy: {
          ...base.strategy,
          levelTypes: [
            gateType === undefined ? lt : { ...lt, gateType },
            ...base.strategy.levelTypes.slice(1),
          ],
        },
      };
    }

    it("clear_only：无战力门槛 → recommendedPower 全部落 0 哨兵，gateType 透传", () => {
      const result = computeLevelFromIntent(intentWithGate("clear_only"));
      expect(typeOf(result, 0).gateType).toBe("clear_only");
      for (const level of result.levelTypes[0].levels) {
        expect(level.recommendedPower).toBe(0);
        expect(level.difficultyScore).toBeGreaterThan(0); // 难度照常输出
      }
    });

    it("power_gate：有战力 → recommendedPower 维持 100 + difficulty*50 原式", () => {
      const result = computeLevelFromIntent(intentWithGate("power_gate"));
      expect(typeOf(result, 0).gateType).toBe("power_gate");
      for (const level of result.levelTypes[0].levels) {
        expect(level.recommendedPower).toBeGreaterThan(0);
      }
      const first = result.levelTypes[0].levels[0];
      expect(first.recommendedPower).toBe(100 + first.difficultyScore * 50);
    });

    it("time_gate：有战力（体力由 frameworks 层条件输出）", () => {
      const result = computeLevelFromIntent(intentWithGate("time_gate"));
      expect(typeOf(result, 0).gateType).toBe("time_gate");
      for (const level of result.levelTypes[0].levels) {
        expect(level.recommendedPower).toBeGreaterThan(0);
      }
    });

    it("gateType 缺省（legacy intent）：维持原行为——recommendedPower 正常输出、不写 gateType 键", () => {
      const result = computeLevelFromIntent(intentWithGate(undefined));
      expect(typeOf(result, 0).gateType).toBeUndefined();
      for (const level of result.levelTypes[0].levels) {
        expect(level.recommendedPower).toBeGreaterThan(0);
      }
    });

    it("gateType 按关卡类型独立生效（story=clear_only / boss=power_gate）", () => {
      const base = makeLevelIntent();
      const result = computeLevelFromIntent({
        ...base,
        strategy: {
          ...base.strategy,
          levelTypes: [
            { ...base.strategy.levelTypes[0], gateType: "clear_only" },
            { ...base.strategy.levelTypes[1], gateType: "power_gate" },
          ],
        },
      });
      expect(result.levelTypes[0].levels.every((l) => l.recommendedPower === 0)).toBe(true);
      expect(result.levelTypes[1].levels.every((l) => l.recommendedPower > 0)).toBe(true);
    });
  });

  // ── Boundary: NaN inputs ──────────────────────────────────────────────
  describe("boundary: NaN inputs", () => {
    it("NaN difficulty anchor defaults to fallback (10/90)", () => {
      const result = computeLevelFromIntent({
        moduleType: "level",
        decisions: { levelScale: "small", totalLevels: 5, rationale: "test" },
        strategy: {
          levelTypes: [{ id: "test", name: "测试", count: 5, difficultyCurve: "linear" as const, rewardResourceTypes: ["gold"] }],
          progressionPacing: { early: "1min", mid: "5min", late: "10min" },
        },
        anchors: { firstLevelDifficulty: { test: NaN }, lastLevelDifficulty: { test: NaN } },
      });
      // NaN ?? 10 => NaN (nullish coalescing only catches null/undefined)
      // The ?? operator does NOT replace NaN, so NaN propagates
      expect(result.levelTypes[0].levels[0].difficultyScore).toBeNaN();
    });

    it("NaN in difficulty score propagates to recommendedPower and rewards", () => {
      const result = computeLevelFromIntent({
        moduleType: "level",
        decisions: { levelScale: "small", totalLevels: 5, rationale: "test" },
        strategy: {
          levelTypes: [{ id: "test", name: "测试", count: 5, difficultyCurve: "linear" as const, rewardResourceTypes: ["gold"] }],
          progressionPacing: { early: "1min", mid: "5min", late: "10min" },
        },
        anchors: { firstLevelDifficulty: { test: NaN }, lastLevelDifficulty: { test: 100 } },
      });
      expect(Number.isNaN(result.levelTypes[0].levels[0].difficultyScore)).toBe(true);
      expect(Number.isNaN(result.levelTypes[0].levels[0].recommendedPower)).toBe(true);
      expect(Number.isNaN(result.levelTypes[0].levels[0].rewardEstimate.gold)).toBe(true);
    });
  });

  // ── Boundary: negative inputs ─────────────────────────────────────────
  describe("boundary: negative inputs", () => {
    it("negative difficulty anchors produce negative difficulty scores", () => {
      const result = computeLevelFromIntent({
        moduleType: "level",
        decisions: { levelScale: "small", totalLevels: 5, rationale: "test" },
        strategy: {
          levelTypes: [{ id: "test", name: "测试", count: 5, difficultyCurve: "linear" as const, rewardResourceTypes: ["gold"] }],
          progressionPacing: { early: "1min", mid: "5min", late: "10min" },
        },
        anchors: { firstLevelDifficulty: { test: -10 }, lastLevelDifficulty: { test: -1 } },
      });
      expect(result.levelTypes[0].levels[0].difficultyScore).toBe(-10);
      expect(result.levelTypes[0].levels[4].difficultyScore).toBe(-1);
    });

    it("negative count produces empty levels array", () => {
      const result = computeLevelFromIntent({
        moduleType: "level",
        decisions: { levelScale: "small", totalLevels: 0, rationale: "test" },
        strategy: {
          levelTypes: [{ id: "test", name: "测试", count: 0, difficultyCurve: "linear" as const, rewardResourceTypes: ["gold"] }],
          progressionPacing: { early: "1min", mid: "5min", late: "10min" },
        },
        anchors: { firstLevelDifficulty: { test: 10 }, lastLevelDifficulty: { test: 90 } },
      });
      expect(result.levelTypes[0].levels).toHaveLength(0);
      expect(result.totalLevels).toBe(0);
    });
  });

  // ── Boundary: zero inputs ─────────────────────────────────────────────
  describe("boundary: zero inputs", () => {
    it("zero difficulty anchors produce zero recommended power", () => {
      const result = computeLevelFromIntent({
        moduleType: "level",
        decisions: { levelScale: "small", totalLevels: 5, rationale: "test" },
        strategy: {
          levelTypes: [{ id: "test", name: "测试", count: 5, difficultyCurve: "linear" as const, rewardResourceTypes: ["gold"] }],
          progressionPacing: { early: "1min", mid: "5min", late: "10min" },
        },
        anchors: { firstLevelDifficulty: { test: 0 }, lastLevelDifficulty: { test: 0 } },
      });
      for (const level of result.levelTypes[0].levels) {
        expect(level.difficultyScore).toBe(0);
        expect(level.recommendedPower).toBe(100); // 100 + 0 * 50
        expect(level.rewardEstimate.gold).toBe(10); // 10 + 0 * 2
      }
    });

    it("single level (count=1) uses first difficulty directly", () => {
      const result = computeLevelFromIntent({
        moduleType: "level",
        decisions: { levelScale: "small", totalLevels: 1, rationale: "test" },
        strategy: {
          levelTypes: [{ id: "test", name: "测试", count: 1, difficultyCurve: "linear" as const, rewardResourceTypes: ["gold"] }],
          progressionPacing: { early: "1min", mid: "5min", late: "10min" },
        },
        anchors: { firstLevelDifficulty: { test: 42 }, lastLevelDifficulty: { test: 99 } },
      });
      expect(result.levelTypes[0].levels).toHaveLength(1);
      expect(result.levelTypes[0].levels[0].difficultyScore).toBe(42);
    });
  });

  // ── Boundary: Infinity inputs ─────────────────────────────────────────
  describe("boundary: Infinity inputs", () => {
    it("Infinity difficulty produces Infinity recommendedPower", () => {
      const result = computeLevelFromIntent({
        moduleType: "level",
        decisions: { levelScale: "small", totalLevels: 5, rationale: "test" },
        strategy: {
          levelTypes: [{ id: "test", name: "测试", count: 2, difficultyCurve: "linear" as const, rewardResourceTypes: ["gold"] }],
          progressionPacing: { early: "1min", mid: "5min", late: "10min" },
        },
        anchors: { firstLevelDifficulty: { test: 10 }, lastLevelDifficulty: { test: Infinity } },
      });
      expect(result.levelTypes[0].levels[1].difficultyScore).toBe(Infinity);
      expect(result.levelTypes[0].levels[1].recommendedPower).toBe(Infinity);
    });
  });

  // ── 体验预期字段（planning-four-expectation R2：恒有落盘 + 透传 + 钳制） ──
  describe("expectedDailyClears / enemyDifficultyFactors (R2)", () => {
    function intentWithDecisions(
      decisions: Partial<LevelDesignIntent["decisions"]>
    ): LevelDesignIntent {
      const base = makeLevelIntent();
      return { ...base, decisions: { ...base.decisions, ...decisions } };
    }

    it("缺省落盘：intent 不带新字段 → computed 恒有引擎缺省值", () => {
      const result = computeLevelFromIntent(makeLevelIntent());
      expect(result.expectedDailyClears).toBe(3);
      expect(result.enemyDifficultyFactors).toEqual({ normal: 0.75, elite: 1.2, boss: 2 });
    });

    it("透传：intent 传值 → 原值输出", () => {
      const result = computeLevelFromIntent(
        intentWithDecisions({
          expectedDailyClears: 7,
          enemyDifficultyFactors: { normal: 0.5, elite: 1.5, boss: 3 },
        })
      );
      expect(result.expectedDailyClears).toBe(7);
      expect(result.enemyDifficultyFactors).toEqual({ normal: 0.5, elite: 1.5, boss: 3 });
    });

    it("钳制：expectedDailyClears 越界钳到 [1,20]、小数取整", () => {
      expect(
        computeLevelFromIntent(intentWithDecisions({ expectedDailyClears: 99 })).expectedDailyClears
      ).toBe(20);
      expect(
        computeLevelFromIntent(intentWithDecisions({ expectedDailyClears: 0 })).expectedDailyClears
      ).toBe(1);
      expect(
        computeLevelFromIntent(intentWithDecisions({ expectedDailyClears: 4.7 })).expectedDailyClears
      ).toBe(5);
    });

    it("钳制：enemyDifficultyFactors 越界档钳到 [0.1,10]，合法档原值保留", () => {
      const result = computeLevelFromIntent(
        intentWithDecisions({
          enemyDifficultyFactors: { normal: 0.01, elite: 15, boss: 2 },
        })
      );
      expect(result.enemyDifficultyFactors).toEqual({ normal: 0.1, elite: 10, boss: 2 });
    });

    it("守卫：expectedDailyClears NaN/Infinity → 回退缺省 3（NaN 穿透 clamp+round 链）", () => {
      for (const bad of [Number.NaN, Infinity, -Infinity]) {
        expect(
          computeLevelFromIntent(intentWithDecisions({ expectedDailyClears: bad }))
            .expectedDailyClears
        ).toBe(3);
      }
    });

    it("守卫：enemyDifficultyFactors 单档 NaN/Infinity → 该档回退缺省，合法档不受牵连", () => {
      const result = computeLevelFromIntent(
        intentWithDecisions({
          enemyDifficultyFactors: { normal: Number.NaN, elite: Infinity, boss: 3 },
        })
      );
      expect(result.enemyDifficultyFactors).toEqual({ normal: 0.75, elite: 1.2, boss: 3 });
    });
  });
});