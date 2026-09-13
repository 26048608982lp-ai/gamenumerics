import { interpolateFromAnchors } from "./curves";
import type { LevelDesignIntent } from "./types";
import type { ComputedLevelData } from "@/lib/types/planning";

interface LevelDetailRow {
  levelIndex: number;
  levelName: string;
  difficultyScore: number;
  recommendedPower: number;
  rewardEstimate: Record<string, number>;
}

export interface LevelTypeResult {
  id: string;
  name: string;
  count: number;
  difficultyCurve: string;
  rewardResourceTypes: string[];
  /**
   * 进度门槛类型透传（P1-2）：intent.strategy.levelTypes[].gateType 原样回显，
   * 供 level-frameworks 动态功能卡按门槛条件输出体力消耗（clear_only/power_gate 无）。
   */
  gateType?: "clear_only" | "power_gate" | "time_gate";
  levels: LevelDetailRow[];
}

/** 计算结果类型 = lib/types 单源别名（Re.E1-1，含 moduleType 判别键） */
type LevelComputeResult = ComputedLevelData;

/**
 * 体验预期缺省（planning-four-expectation R2）：ComputedLevelData 两键恒有，
 * intent 未提供时以此落盘；越界值钳制到合法域（防篡改第二道防线，schema 为第一道）。
 */
const DEFAULT_EXPECTED_DAILY_CLEARS = 3;
const DEFAULT_ENEMY_DIFFICULTY_FACTORS = { normal: 0.75, elite: 1.2, boss: 2 };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 每日通关数量：intent 透传 + 钳制 [1,20] 取整；缺省 3。
 * NaN/Infinity 前置守卫回退缺省（REVIEW P2）：Math.max/min 钳制链对 NaN 穿透
 * （clamp(NaN)=NaN），对齐 experience-expectation.ts resolvePositiveInt 先例。
 */
function resolveExpectedDailyClears(
  raw: number | undefined
): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_EXPECTED_DAILY_CLEARS;
  return Math.round(clamp(raw, 1, 20));
}

/** 敌人难度单档系数：透传 + 钳制 [0.1,10]；缺省/NaN/Infinity 回退该档缺省 */
function resolveEnemyFactor(raw: number | undefined, fallback: number): number {
  if (raw === undefined || !Number.isFinite(raw)) return fallback;
  return clamp(raw, 0.1, 10);
}

/** 敌人难度三档系数：intent 逐档透传 + 钳制 [0.1,10]；缺省档 { 0.75, 1.2, 2 } */
function resolveEnemyDifficultyFactors(
  raw: LevelDesignIntent["decisions"]["enemyDifficultyFactors"]
): ComputedLevelData["enemyDifficultyFactors"] {
  return {
    normal: resolveEnemyFactor(raw?.normal, DEFAULT_ENEMY_DIFFICULTY_FACTORS.normal),
    elite: resolveEnemyFactor(raw?.elite, DEFAULT_ENEMY_DIFFICULTY_FACTORS.elite),
    boss: resolveEnemyFactor(raw?.boss, DEFAULT_ENEMY_DIFFICULTY_FACTORS.boss),
  };
}

export function computeLevelFromIntent(
  intent: LevelDesignIntent
): LevelComputeResult {
  const { strategy, anchors } = intent;
  const { firstLevelDifficulty, lastLevelDifficulty } = anchors;

  const levelTypes: LevelTypeResult[] = [];
  let totalLevels = 0;

  for (const lt of strategy.levelTypes) {
    const firstDiff = firstLevelDifficulty[lt.id] ?? 10;
    const lastDiff = lastLevelDifficulty[lt.id] ?? 90;
    const curve = lt.difficultyCurve === "step"
      ? "linear"  // step 退化为线性（逐段常量在关卡引擎层面不适用）
      : (lt.difficultyCurve as "linear" | "exponential" | "sigmoid");

    // gateType 条件输出（P1-2，兑现 system/level.ts 进度门槛承诺）：
    // - clear_only：无战力门槛 → recommendedPower 落 0 哨兵。ComputedLevelData 类型
    //   约束该键必填不可省略，下游（level-frameworks）以 power>0 判定，0 即"不含推荐战力"
    // - power_gate / time_gate / 缺省（legacy intent）：维持 100 + difficulty*50 原行为
    const hasPowerGate = lt.gateType !== "clear_only";

    const levels: LevelDetailRow[] = [];

    for (let i = 0; i < lt.count; i++) {
      // 计算难度分数
      let difficultyScore: number;
      if (lt.count <= 1) {
        difficultyScore = firstDiff;
      } else {
        const anchors_map: Record<number, number> = {
          0: firstDiff,
          [lt.count - 1]: lastDiff,
        };
        const values = interpolateFromAnchors(anchors_map, curve, lt.count);
        difficultyScore = Math.round(values[i]);
      }

      // 推荐战力基于难度分数线性映射（clear_only 落 0 哨兵，见上方注释）
      const recommendedPower = hasPowerGate
        ? Math.round(100 + difficultyScore * 50)
        : 0;

      // 奖励估算：基于难度分数给资源
      const rewardEstimate: Record<string, number> = {};
      for (const rt of lt.rewardResourceTypes) {
        rewardEstimate[rt] = Math.round(10 + difficultyScore * 2);
      }

      levels.push({
        levelIndex: i + 1,
        levelName: `${lt.name} ${i + 1}`,
        difficultyScore,
        recommendedPower,
        rewardEstimate,
      });
    }

    levelTypes.push({
      id: lt.id,
      name: lt.name,
      count: lt.count,
      difficultyCurve: lt.difficultyCurve,
      rewardResourceTypes: lt.rewardResourceTypes,
      ...(lt.gateType !== undefined ? { gateType: lt.gateType } : {}),
      levels,
    });

    totalLevels += lt.count;
  }

  return {
    moduleType: "level" as const,
    levelTypes,
    totalLevels,
    progressionPacing: strategy.progressionPacing,
    expectedDailyClears: resolveExpectedDailyClears(
      intent.decisions.expectedDailyClears
    ),
    enemyDifficultyFactors: resolveEnemyDifficultyFactors(
      intent.decisions.enemyDifficultyFactors
    ),
  };
}
