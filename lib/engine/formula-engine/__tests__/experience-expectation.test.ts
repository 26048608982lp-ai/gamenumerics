import { describe, it, expect } from "vitest";
import {
  computeExperienceExpectation,
  buildExperienceExpectationInput,
  type ExperienceExpectationInput,
  type ExperienceExpectationSources,
  type ComputedExperienceExpectation,
} from "../experience-expectation";
import { computeBattleFromIntent } from "../battle";
import { computeProgressionFromIntent } from "../progression";
import { computeLevelFromIntent } from "../level";
import { computeEconomyFromIntent } from "../economy";
import { deriveConfigTableDrafts } from "../config-table-export";
import { computeGrowthProjection, HORIZON_DAY } from "../growth-projection";
import {
  BATTLE_INTENT,
  PROGRESSION_INTENT,
  LEVEL_INTENT,
  ECONOMY_INTENT,
} from "./fixtures";
import type {
  ComputedEconomyData,
  ComputedLevelData,
} from "@/lib/types/planning";

/**
 * 玩家体验预期总表（planning-four-expectation R4 / W3-A）：四模块 confirmed 产物
 * 聚合 → 锚点时间轴推演。断言基于真链路 fixture（引擎 computed 产物喂总表引擎）
 * + 参考实现重算期望值（growth-projection.test 先例）。
 */

const DEFAULT_ANCHORS = [1, 3, 7, 14, 30, 60, 90, 120, 180];

// ==================== 真链路 fixture ====================

const battleData = computeBattleFromIntent(BATTLE_INTENT);
const progressionData = computeProgressionFromIntent(PROGRESSION_INTENT);
const levelData = computeLevelFromIntent(LEVEL_INTENT);

function makeInput(
  overrides?: Partial<ExperienceExpectationInput>
): ExperienceExpectationInput {
  return {
    battle: battleData,
    progression: {
      progressionModules: progressionData.progressionModules,
      tierDifferentiation: progressionData.tierDifferentiation,
    },
    economy: {
      dailyBudget: ECONOMY_INTENT.anchors.dailyBudget,
      consumptionSplitProgression: ECONOMY_INTENT.consumptionSplit.progression,
    },
    level: {
      totalLevels: levelData.totalLevels,
      expectedDailyClears: levelData.expectedDailyClears,
      enemyDifficultyFactors: levelData.enemyDifficultyFactors,
      levelTypes: levelData.levelTypes,
    },
    ...overrides,
  };
}

function anchorOf(
  result: ComputedExperienceExpectation,
  day: number
): ComputedExperienceExpectation["anchors"][number] {
  const anchor = result.anchors.find((a) => a.day === day);
  if (!anchor) throw new Error(`anchor day=${day} not found`);
  return anchor;
}

// ==================== 参考实现（测试内重算，独立于被测实现） ====================

/** growth-projection 薄镜像：standard 档线进度率（hero 渐近 / 其余 log-progress） */
const HERO_K_STD = 0.025;
const rHero = (day: number) => Math.min(1, 1 - Math.exp(-HERO_K_STD * day));
const rLog = (day: number) =>
  Math.min(1, Math.pow(Math.log(day) / Math.log(HORIZON_DAY), 1));

/** progression 线当前等级 = 进度率 × maxLevel 取整（fixture 线均匹配不到 battle 线 → fallback hero 渐近） */
const lineLevelAt = (day: number, maxLevel: number) =>
  Math.min(maxLevel, Math.max(0, Math.round(rHero(day) * maxLevel)));

/** 区间 [prev, day) 跨线累计资源消耗 ÷ 区间天数（引擎口径：整数合计后统一除） */
function expectedDailyConsumption(
  prevDay: number,
  day: number
): Record<string, number> {
  const span = day - prevDay;
  const sums: Record<string, number> = {};
  for (const mod of progressionData.progressionModules) {
    const from = lineLevelAt(prevDay, mod.maxLevel);
    const to = lineLevelAt(day, mod.maxLevel);
    for (const row of mod.resourceCostTable) {
      if (row.level > from && row.level <= to) {
        for (const [rid, cost] of Object.entries(row.resourceCost)) {
          sums[rid] = (sums[rid] ?? 0) + cost;
        }
      }
    }
  }
  const result: Record<string, number> = {};
  for (const [rid, sum] of Object.entries(sums)) result[rid] = sum / span;
  return result;
}

/** equipment 品质连续值 → tier 线性映射（maxQuality=6 默认口径） */
const EQUIPMENT_MAX_QUALITY = 6;
const tierOf = (quality: number, tierCount: number) =>
  Math.min(
    tierCount,
    Math.max(1, Math.round(1 + ((quality - 1) / (EQUIPMENT_MAX_QUALITY - 1)) * (tierCount - 1)))
  );

// ==================== 锚点解析 ====================

describe("computeExperienceExpectation — 锚点解析", () => {
  it("默认锚点 9 个且升序 [1,3,7,14,30,60,90,120,180]", () => {
    const result = computeExperienceExpectation(makeInput());
    expect(result.anchors.map((a) => a.day)).toEqual(DEFAULT_ANCHORS);
    expect(result.moduleType).toBe("experience-expectation");
    expect(result.pace).toBe("standard");
    // configTableRefs（V10-W3 T2 起非空）：fixture level/battle confirmed 在场 → 真实引用
    expect(result.configTableRefs.level).toEqual({
      tables: [
        { tableName: "level/story-等级成长", path: "tables/level/story-等级成长.json" },
        { tableName: "level/elite-等级成长", path: "tables/level/elite-等级成长.json" },
      ],
    });
    expect(result.configTableRefs.battle).toEqual({
      tables: [{ tableName: "battle/属性投放矩阵", path: "tables/battle/属性投放矩阵.json" }],
    });
  });

  it("自定义 anchors（升序去重合法域内）生效", () => {
    const result = computeExperienceExpectation(
      makeInput({ options: { anchors: [5, 20, 60] } })
    );
    expect(result.anchors.map((a) => a.day)).toEqual([5, 20, 60]);
  });

  it("畸形 anchors 回退默认：乱序 / 超界（<1 或 >180）/ 空数组 / 非有限数", () => {
    for (const malformed of [[30, 7], [0, 7], [7, 200], [], [Number.NaN], [-5, 300]]) {
      const result = computeExperienceExpectation(
        makeInput({ options: { anchors: malformed } })
      );
      expect(result.anchors.map((a) => a.day)).toEqual(DEFAULT_ANCHORS);
    }
  });

  it("pace 透传：relaxed 档回显", () => {
    const result = computeExperienceExpectation(
      makeInput({ options: { pace: "relaxed" } })
    );
    expect(result.pace).toBe("relaxed");
  });
});

// ==================== 线进度 / 属性 / 战力（growth-projection 同源复用） ====================

describe("computeExperienceExpectation — growth-projection 同源复用", () => {
  const result = computeExperienceExpectation(makeInput());
  const projection = computeGrowthProjection(battleData, {
    anchors: DEFAULT_ANCHORS,
  });

  it("totalPower / attributes 与 computeGrowthProjection 同 day 输出深度相等", () => {
    expect(result.anchors).toHaveLength(projection.anchors.length);
    for (let i = 0; i < result.anchors.length; i++) {
      const a = result.anchors[i];
      const p = projection.anchors[i];
      expect(a.day).toBe(p.day);
      expect(a.totalPower).toBe(p.totalPower);
      expect(a.attributes).toEqual(p.attributes);
    }
  });

  it("lines 保留 id/name/type/progress/stage（与 projection 一致）且不含 power 键、含 tier 键", () => {
    for (const anchor of result.anchors) {
      const p = projection.anchors.find((x) => x.day === anchor.day)!;
      expect(anchor.lines).toHaveLength(p.lines.length);
      for (const line of anchor.lines) {
        const src = p.lines.find((l) => l.id === line.id)!;
        expect(line.name).toBe(src.name);
        expect(line.type).toBe(src.type);
        expect(line.progress).toBe(src.progress);
        expect(line.stage).toBe(src.stage);
        expect("power" in line).toBe(false);
        expect("tier" in line).toBe(true);
      }
    }
  });

  it("totalPower 随锚点 day 非降（供给模型单调，宽松允许等号）", () => {
    for (let i = 1; i < result.anchors.length; i++) {
      expect(result.anchors[i].totalPower).toBeGreaterThanOrEqual(
        result.anchors[i - 1].totalPower
      );
    }
  });
});

// ==================== heroLevel ====================

describe("computeExperienceExpectation — heroLevel", () => {
  it("heroLevel = round(50 × (1 - e^(-0.025·day)))（heroStage 展示口径同源，battle 产物自描述 50 级域）", () => {
    const result = computeExperienceExpectation(makeInput());
    for (const anchor of result.anchors) {
      // V8 W3-T3：heroLevel 派生自 hero 线 progress（= 产物自描述 maxLevel × r），
      // BATTLE_INTENT maxLevel=50 → round(50×r)（旧 60 域在 maxLevel≠60 产物上分叉）
      const expected = Math.round(50 * (1 - Math.exp(-HERO_K_STD * anchor.day)));
      expect(anchor.heroLevel, `day=${anchor.day}`).toBe(expected);
    }
    expect(anchorOf(result, 1).heroLevel).toBe(1);
  });
});

// ==================== tier 映射（equipment 品质 → 档位） ====================

describe("computeExperienceExpectation — tier 映射", () => {
  it("全锚点 equipment 线 tier = round(1+(q-1)/(maxQ-1)×(tierCount-1))，fixture 默认 tierCount=3", () => {
    const result = computeExperienceExpectation(makeInput());
    for (const anchor of result.anchors) {
      const q = 1 + (EQUIPMENT_MAX_QUALITY - 1) * rLog(anchor.day);
      const expectedTier = tierOf(q, 3);
      for (const line of anchor.lines.filter((l) => l.type === "equipment")) {
        expect(line.tier, `day=${anchor.day} ${line.id}`).toBe(expectedTier);
      }
    }
  });

  it("端点：day=1 → tier=1；day=180 → tier=tierCount", () => {
    const result = computeExperienceExpectation(makeInput());
    const first = anchorOf(result, 1);
    const last = anchorOf(result, 180);
    for (const line of first.lines.filter((l) => l.type === "equipment")) {
      expect(line.tier).toBe(1);
    }
    for (const line of last.lines.filter((l) => l.type === "equipment")) {
      expect(line.tier).toBe(3);
    }
  });

  it("tierDifferentiation.tierCount=4 时 day=180 → tier=4", () => {
    const result = computeExperienceExpectation(
      makeInput({
        progression: {
          progressionModules: progressionData.progressionModules,
          tierDifferentiation: {
            tierCount: 4,
            attributeMultipliers: [1, 2, 3, 4],
            costMultipliers: [1, 1.5, 2, 2.5],
          },
        },
      })
    );
    for (const line of anchorOf(result, 180).lines.filter((l) => l.type === "equipment")) {
      expect(line.tier).toBe(4);
    }
  });

  it("非 equipment 线（hero/skill）tier=0", () => {
    const result = computeExperienceExpectation(makeInput());
    for (const anchor of result.anchors) {
      for (const line of anchor.lines.filter((l) => l.type !== "equipment")) {
        expect(line.tier, `day=${anchor.day} ${line.id}`).toBe(0);
      }
    }
  });
});

// ==================== 产消对照 ====================

describe("computeExperienceExpectation — 产消对照", () => {
  it("day=1 首锚点 dailyConsumption 全 0；dailyProduction = 日预算均值 × consumptionSplit（gold [100,500] × 0.4 → 120）", () => {
    const result = computeExperienceExpectation(makeInput());
    const first = anchorOf(result, 1);
    expect(first.productionConsumption.dailyConsumption).toEqual({ gold: 0 });
    expect(first.productionConsumption.dailyProduction).toEqual({ gold: 120 });
    expect(first.productionConsumption.dailyNet).toEqual({ gold: 120 });
  });

  it("资源键集 = progression 各线 resourceCostTable 键并集（fixture 单资源 gold；economy 其余键不混入）", () => {
    const result = computeExperienceExpectation(makeInput());
    for (const anchor of result.anchors) {
      expect(Object.keys(anchor.productionConsumption.dailyProduction)).toEqual(["gold"]);
      expect(Object.keys(anchor.productionConsumption.dailyConsumption)).toEqual(["gold"]);
      expect(Object.keys(anchor.productionConsumption.dailyNet)).toEqual(["gold"]);
    }
  });

  it("多资源并集：两线各含独有资源键时键集 = 并集", () => {
    const twoResourceProgression = {
      progressionModules: [
        progressionData.progressionModules[0], // gold
        {
          ...progressionData.progressionModules[1],
          resourceCostTable: progressionData.progressionModules[1].resourceCostTable.map(
            (row) => ({ ...row, resourceCost: { exp: row.resourceCost.gold } })
          ),
        },
      ],
      tierDifferentiation: progressionData.tierDifferentiation,
    };
    const result = computeExperienceExpectation(
      makeInput({ progression: twoResourceProgression })
    );
    const keys = Object.keys(anchorOf(result, 7).productionConsumption.dailyProduction);
    expect(keys.sort()).toEqual(["exp", "gold"]);
  });

  it("dailyConsumption = 区间 [prev, day) 升级消耗合计 ÷ 区间天数（参考实现重算）", () => {
    const result = computeExperienceExpectation(makeInput());
    for (const day of [3, 7, 14, 30, 60, 90, 120, 180]) {
      const prev = DEFAULT_ANCHORS[DEFAULT_ANCHORS.indexOf(day) - 1];
      const expected = expectedDailyConsumption(prev, day);
      const actual = anchorOf(result, day).productionConsumption.dailyConsumption;
      for (const [rid, value] of Object.entries(expected)) {
        expect(actual[rid], `day=${day} ${rid}`).toBeCloseTo(value, 6);
      }
    }
    // 中段锚点消耗非零（区间内有等级推进）
    expect(anchorOf(result, 3).productionConsumption.dailyConsumption.gold).toBeGreaterThan(0);
    expect(anchorOf(result, 180).productionConsumption.dailyConsumption.gold).toBeGreaterThan(0);
  });

  it("dailyNet = dailyProduction − dailyConsumption（逐资源）", () => {
    const result = computeExperienceExpectation(makeInput());
    for (const anchor of result.anchors) {
      const { dailyProduction, dailyConsumption, dailyNet } = anchor.productionConsumption;
      for (const rid of Object.keys(dailyProduction)) {
        expect(dailyNet[rid], `day=${anchor.day} ${rid}`).toBeCloseTo(
          dailyProduction[rid] - dailyConsumption[rid],
          9
        );
      }
    }
  });

  it("命中分支：progression 线 id 命中 battle 线 id → 产消按该线口径（equipment → log-progress 而非 hero 渐近）", () => {
    // battle fixture 含 equipment-weapon（type=equipment）；改 progression 模块 id 与之命中，
    // 锁定 lineTypeOf id 精确匹配分支（未命中时 fallback hero 渐近，见上方参考实现注释）
    const matched = progressionData.progressionModules.map((mod) =>
      mod.id === "level" ? { ...mod, id: "equipment-weapon" } : mod
    );
    const result = computeExperienceExpectation(
      makeInput({
        progression: {
          progressionModules: matched,
          tierDifferentiation: progressionData.tierDifferentiation,
        },
      })
    );

    // 参考实现重算：命中线走 log-progress，未命中线（equip）维持 hero 渐近
    const lvl = (mod: (typeof matched)[number], day: number) => {
      const r = mod.id === "equipment-weapon" ? rLog(day) : rHero(day);
      return Math.min(mod.maxLevel, Math.max(0, Math.round(r * mod.maxLevel)));
    };
    for (const day of [3, 7, 14, 30, 60, 90, 120, 180]) {
      const prev = DEFAULT_ANCHORS[DEFAULT_ANCHORS.indexOf(day) - 1];
      const span = day - prev;
      const sums: Record<string, number> = {};
      for (const mod of matched) {
        const from = lvl(mod, prev);
        const to = lvl(mod, day);
        for (const row of mod.resourceCostTable) {
          if (row.level > from && row.level <= to) {
            for (const [rid, cost] of Object.entries(row.resourceCost)) {
              sums[rid] = (sums[rid] ?? 0) + cost;
            }
          }
        }
      }
      expect(
        anchorOf(result, day).productionConsumption.dailyConsumption.gold,
        `day=${day}`
      ).toBeCloseTo((sums.gold ?? 0) / span, 6);
    }

    // 行为可分辨：早期窗口 log-progress 推进快于 hero 渐近 → 命中口径消耗 > fallback 口径
    const fallback = computeExperienceExpectation(makeInput());
    expect(anchorOf(result, 3).productionConsumption.dailyConsumption.gold).toBeGreaterThan(
      anchorOf(fallback, 3).productionConsumption.dailyConsumption.gold
    );
  });

  it("economy.dailyBudget / consumptionSplit 缺失 → [100,500] 默认档均值 × 默认分摊 0.5（gold → 150）", () => {
    const result = computeExperienceExpectation(makeInput({ economy: {} }));
    expect(anchorOf(result, 1).productionConsumption.dailyProduction).toEqual({ gold: 150 });
  });
});

// ==================== 难度咬合 ====================

describe("computeExperienceExpectation — 难度咬合", () => {
  const result = computeExperienceExpectation(makeInput());
  const storyLevels = levelData.levelTypes[0].levels;

  it("levelIndex = clamp(round(day × expectedDailyClears), 1, totalLevels)", () => {
    // fixture：clears=3（缺省）、totalLevels=150（story 100 + elite 50）
    expect(anchorOf(result, 1).difficulty.levelIndex).toBe(3);
    expect(anchorOf(result, 7).difficulty.levelIndex).toBe(21);
    expect(anchorOf(result, 180).difficulty.levelIndex).toBe(150); // round(540) clamp 到 150
  });

  it("difficultyScore / recommendedPower 取首个类型 levels 表第 clamp(levelIndex,1,count) 行（简化口径）", () => {
    for (const anchor of result.anchors) {
      const idx = Math.min(100, Math.max(1, anchor.difficulty.levelIndex));
      const row = storyLevels[idx - 1];
      expect(anchor.difficulty.difficultyScore, `day=${anchor.day}`).toBe(row.difficultyScore);
      expect(anchor.difficulty.recommendedPower, `day=${anchor.day}`).toBe(row.recommendedPower);
    }
    // day=180：clamp 到 story 末关
    expect(anchorOf(result, 180).difficulty.difficultyScore).toBe(storyLevels[99].difficultyScore);
  });

  it("enemyFactors 透传 level.enemyDifficultyFactors", () => {
    const factors = { normal: 0.5, elite: 1.5, boss: 3 };
    const custom = makeInput({
      level: { ...makeInput().level, enemyDifficultyFactors: factors },
    });
    const customResult = computeExperienceExpectation(custom);
    for (const anchor of customResult.anchors) {
      expect(anchor.difficulty.enemyFactors).toEqual(factors);
    }
    // 原 fixture 引擎缺省值也透传
    expect(anchorOf(result, 7).difficulty.enemyFactors).toEqual(
      levelData.enemyDifficultyFactors
    );
  });
});

// ==================== meta ====================

describe("computeExperienceExpectation — meta", () => {
  it("expectedMaxLevelDays 透传 framework.experienceAnchors", () => {
    const result = computeExperienceExpectation(
      makeInput({ framework: { experienceAnchors: { expectedMaxLevelDays: 45 } } })
    );
    expect(result.meta.expectedMaxLevelDays).toBe(45);
  });

  it("framework 缺失 → expectedMaxLevelDays 键省略", () => {
    const result = computeExperienceExpectation(makeInput());
    expect("expectedMaxLevelDays" in result.meta).toBe(false);
  });

  it("bottleneckResourceId = estimateProgressionCompletionDays 瓶颈资源（fixture 单资源 → gold）", () => {
    const result = computeExperienceExpectation(makeInput());
    expect(result.meta.bottleneckResourceId).toBe("gold");
  });

  it("totalWavesNote 含总关数与按日通关推完天数（150 关 × 每日 3 关 = 50 天）", () => {
    const result = computeExperienceExpectation(makeInput());
    expect(result.meta.totalWavesNote).toBe("全 150 关按每日 3 关约 50 天推完");
  });
});

// ==================== configTableRefs（V10-W3 T2） ====================

describe("computeExperienceExpectation — configTableRefs 填充", () => {
  it("未开通模块（economy/progression/gacha）显式 unavailable + 原因（最小版纪律，含 V11）", () => {
    const result = computeExperienceExpectation(makeInput());
    expect(Object.keys(result.configTableRefs)).toEqual([
      "level",
      "battle",
      "economy",
      "progression",
      "gacha",
    ]);
    for (const moduleKey of ["economy", "progression", "gacha"]) {
      const entry = result.configTableRefs[moduleKey];
      expect(entry).toEqual({ unavailable: true, reason: expect.any(String) });
      expect((entry as { reason: string }).reason).toContain("最小版未开通");
      expect((entry as { reason: string }).reason).toContain("V11");
    }
  });

  it("level.levelTypes 缺失 → level unavailable（confirmed 缺席原因，防御路径不抛错）", () => {
    const { levelTypes: omitted, ...levelRest } = makeInput().level;
    void omitted;
    const result = computeExperienceExpectation(
      makeInput({ level: levelRest as ExperienceExpectationInput["level"] })
    );
    expect(result.configTableRefs.level).toEqual({
      unavailable: true,
      reason: expect.stringContaining("level confirmed 缺席"),
    });
    // battle 不受影响
    expect(result.configTableRefs.battle).toEqual({
      tables: [{ tableName: "battle/属性投放矩阵", path: "tables/battle/属性投放矩阵.json" }],
    });
  });

  it("与 deriveConfigTableDrafts 单源一致（总表 refs 与导出载荷 refs 同源不漂移）", () => {
    const result = computeExperienceExpectation(makeInput());
    expect(result.configTableRefs).toEqual(
      deriveConfigTableDrafts({ battle: battleData, level: levelData }).refs
    );
  });
});

// ==================== 纯函数防御（缺字段走契约缺省，不抛错） ====================

describe("computeExperienceExpectation — 防御（progression/level 缺字段）", () => {
  it("tierDifferentiation 缺失 → 引擎缺省 3 档（day=180 equipment tier=3）", () => {
    // 运行时旧数据缺键场景（类型层 Pick 恒有，cast 表达防御意图，growth-projection.test 先例）
    const result = computeExperienceExpectation(
      makeInput({
        progression: {
          progressionModules: progressionData.progressionModules,
        } as ExperienceExpectationInput["progression"],
      })
    );
    for (const line of anchorOf(result, 180).lines.filter((l) => l.type === "equipment")) {
      expect(line.tier).toBe(3);
    }
  });

  it("tierDifferentiation.tierCount 越界（9）→ 回退缺省 3 档", () => {
    const result = computeExperienceExpectation(
      makeInput({
        progression: {
          progressionModules: progressionData.progressionModules,
          tierDifferentiation: {
            tierCount: 9,
            attributeMultipliers: [1, 2, 3, 4, 5, 6, 7, 8, 9],
            costMultipliers: [1, 2, 3, 4, 5, 6, 7, 8, 9],
          },
        },
      })
    );
    for (const line of anchorOf(result, 180).lines.filter((l) => l.type === "equipment")) {
      expect(line.tier).toBe(3);
    }
  });

  it("progressionModules 缺失 → 产消三对象为空、bottleneck 省略，不抛错", () => {
    const result = computeExperienceExpectation(
      makeInput({
        progression: {
          tierDifferentiation: progressionData.tierDifferentiation,
        } as ExperienceExpectationInput["progression"],
      })
    );
    for (const anchor of result.anchors) {
      expect(anchor.productionConsumption.dailyProduction).toEqual({});
      expect(anchor.productionConsumption.dailyConsumption).toEqual({});
      expect(anchor.productionConsumption.dailyNet).toEqual({});
    }
    expect("bottleneckResourceId" in result.meta).toBe(false);
  });

  it("level.expectedDailyClears 缺失 → 缺省 3（day=7 → levelIndex 21）", () => {
    const { expectedDailyClears: omitted, ...rest } = makeInput().level;
    void omitted;
    const result = computeExperienceExpectation(
      makeInput({ level: rest as ExperienceExpectationInput["level"] })
    );
    expect(anchorOf(result, 7).difficulty.levelIndex).toBe(21);
  });

  it("level.enemyDifficultyFactors 缺失 → 引擎缺省 { 0.75, 1.2, 2 }", () => {
    const { enemyDifficultyFactors: omitted, ...rest } = makeInput().level;
    void omitted;
    const result = computeExperienceExpectation(
      makeInput({ level: rest as ExperienceExpectationInput["level"] })
    );
    expect(anchorOf(result, 7).difficulty.enemyFactors).toEqual({
      normal: 0.75,
      elite: 1.2,
      boss: 2,
    });
  });

  it("level.levelTypes 缺失 → difficultyScore / recommendedPower 落 0 哨兵", () => {
    const { levelTypes: omitted, ...rest } = makeInput().level;
    void omitted;
    const result = computeExperienceExpectation(
      makeInput({ level: rest as ExperienceExpectationInput["level"] })
    );
    for (const anchor of [anchorOf(result, 1), anchorOf(result, 180)]) {
      expect(anchor.difficulty.difficultyScore).toBe(0);
      expect(anchor.difficulty.recommendedPower).toBe(0);
    }
  });

  it("level.totalLevels 缺失 → levelIndex clamp 到 1", () => {
    const { totalLevels: omitted, ...rest } = makeInput().level;
    void omitted;
    const result = computeExperienceExpectation(
      makeInput({ level: rest as ExperienceExpectationInput["level"] })
    );
    expect(anchorOf(result, 180).difficulty.levelIndex).toBe(1);
  });

  it("battle 结构字段缺失 → 与 growth-projection 同语义抛错（面板层 catch 降级）", () => {
    const legacy = {
      combatPacing: "standard",
      attributeBudgets: {},
    } as unknown as ExperienceExpectationInput["battle"];
    expect(() => computeExperienceExpectation(makeInput({ battle: legacy }))).toThrow(
      /结构层字段/
    );
  });
});

// ==================== 确定性 ====================

describe("computeExperienceExpectation — 确定性", () => {
  it("相同输入两次调用输出深度相等且非同一引用", () => {
    const input = makeInput({ options: { anchors: [1, 7, 90] } });
    const first = computeExperienceExpectation(input);
    const second = computeExperienceExpectation(input);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.anchors[0].lines).not.toBe(second.anchors[0].lines);
    expect(first.anchors[0].attributes).not.toBe(second.anchors[0].attributes);
  });

  it("不变异入参（四模块数据快照对照）", () => {
    const input = makeInput();
    const snapshot = JSON.parse(JSON.stringify(input));
    computeExperienceExpectation(input);
    expect(input).toEqual(snapshot);
  });
});

// ==================== index 独立导出 ====================

describe("computeExperienceExpectation — index 独立导出", () => {
  it("从 formula-engine 入口可导入（不进 computeFromIntent switch）", async () => {
    const index = await import("../index");
    expect(typeof index.computeExperienceExpectation).toBe("function");
    // 总表为第五类产物（非第五模块），不注册 intent 路由
    expect(() =>
      index.computeFromIntent({ moduleType: "experience-expectation" } as never)
    ).toThrow();
  });
});

// ==================== buildExperienceExpectationInput（T1 单源装配） ====================

/**
 * 四元组 → 引擎输入装配单源（agent-p1-tools T1 / Spec 裁决 4）：UI 面板与
 * agent 工具同源消费，断言锚定 ExperienceExpectationPanel 原装配口径
 * （extractEconomyInput B/C 双读 + useMemo 四元组 Pick），零语义漂移。
 */
const economyData = computeEconomyFromIntent(ECONOMY_INTENT);

/** B 形态四元组源（真链路引擎产物） */
const sources: ExperienceExpectationSources = {
  battle: battleData,
  progression: progressionData,
  economy: economyData,
  level: levelData,
};

/** C 形态存量 economy fixture（历史 LLM 产物直存，_anchors/_strategy 回显 intent） */
const legacyEconomy = {
  ...economyData,
  _anchors: {
    dailyBudget: { legacy: [10, 40] },
    consumptionSplit: { progression: 0.25 },
  },
  _strategy: {
    consumptionSplit: { progression: 0.1 },
  },
} as ComputedEconomyData;

describe("buildExperienceExpectationInput — economy B/C 双读口径", () => {
  it("C 形态存量：_anchors.dailyBudget 非空直读优先（resourceTypes 同有 range 也不覆盖）", () => {
    const input = buildExperienceExpectationInput({ ...sources, economy: legacyEconomy });
    expect(input.economy.dailyBudget).toEqual({ legacy: [10, 40] });
  });

  it("B 形态：无 _anchors → resourceTypes[].dailyBudgetRange 聚合兜底（真链路产物）", () => {
    const input = buildExperienceExpectationInput(sources);
    expect(input.economy.dailyBudget).toEqual({ gold: [100, 500], gem: [5, 20] });
  });

  it("B 形态过滤非法项：无 id / dailyBudgetRange 非二元数组的资源被剔除；全非法 → undefined", () => {
    const dirty = {
      ...economyData,
      resourceTypes: [
        { id: "gold", dailyBudgetRange: [100, 500] },
        { dailyBudgetRange: [1, 2] }, // 无 id → 剔除
        { id: "gem", dailyBudgetRange: [5] }, // 非二元 → 剔除
        { id: "broken", dailyBudgetRange: "x" }, // 非数组 → 剔除
      ],
    } as unknown as ComputedEconomyData;
    expect(
      buildExperienceExpectationInput({ ...sources, economy: dirty }).economy.dailyBudget
    ).toEqual({ gold: [100, 500] });

    const allIllegal = {
      ...economyData,
      resourceTypes: [{ dailyBudgetRange: [1] }],
    } as unknown as ComputedEconomyData;
    expect(
      buildExperienceExpectationInput({ ...sources, economy: allIllegal }).economy.dailyBudget
    ).toBeUndefined();
  });

  it("_anchors.dailyBudget 为空对象 → 视同缺失走 B 形态聚合兜底", () => {
    const emptyAnchored = {
      ...economyData,
      _anchors: { dailyBudget: {} },
    } as ComputedEconomyData;
    expect(
      buildExperienceExpectationInput({ ...sources, economy: emptyAnchored }).economy.dailyBudget
    ).toEqual({ gold: [100, 500], gem: [5, 20] });
  });

  it("两者皆无（空 resourceTypes）→ dailyBudget undefined（键存在值 undefined）", () => {
    const bare = { ...economyData, resourceTypes: [] } as ComputedEconomyData;
    const input = buildExperienceExpectationInput({ ...sources, economy: bare });
    expect(input.economy.dailyBudget).toBeUndefined();
  });
});

describe("buildExperienceExpectationInput — consumptionSplitProgression 三级兜底", () => {
  it("根级 consumptionSplit.progression 直拷（B 形态真链路）", () => {
    expect(
      buildExperienceExpectationInput(sources).economy.consumptionSplitProgression
    ).toBe(ECONOMY_INTENT.consumptionSplit.progression);
  });

  it("根级缺失 → _anchors.consumptionSplit.progression 回显", () => {
    const anchored = {
      ...economyData,
      consumptionSplit: undefined,
      _anchors: { consumptionSplit: { progression: 0.25 } },
    } as ComputedEconomyData;
    expect(
      buildExperienceExpectationInput({ ...sources, economy: anchored }).economy
        .consumptionSplitProgression
    ).toBe(0.25);
  });

  it("根级与 _anchors 缺失 → _strategy.consumptionSplit.progression 回显", () => {
    const strategic = {
      ...economyData,
      consumptionSplit: undefined,
      _strategy: { consumptionSplit: { progression: 0.1 } },
    } as ComputedEconomyData;
    expect(
      buildExperienceExpectationInput({ ...sources, economy: strategic }).economy
        .consumptionSplitProgression
    ).toBe(0.1);
  });

  it("三级齐备 → 根级优先（legacy fixture：根级 0.4 胜 _anchors 0.25 / _strategy 0.1）", () => {
    expect(
      buildExperienceExpectationInput({ ...sources, economy: legacyEconomy }).economy
        .consumptionSplitProgression
    ).toBe(0.4);
  });

  it("三级皆缺 → undefined（键存在值 undefined，引擎落缺省分摊 0.5）", () => {
    const bare = { ...economyData, consumptionSplit: undefined } as ComputedEconomyData;
    const input = buildExperienceExpectationInput({ ...sources, economy: bare });
    expect(input.economy.consumptionSplitProgression).toBeUndefined();
    // 引擎行为：缺日预算走 [100,500] 缺省档均值 × 缺分摊 0.5 → gold 150
    expect(computeExperienceExpectation(input).anchors[0].productionConsumption.dailyProduction).toEqual({
      gold: 150,
    });
  });
});

describe("buildExperienceExpectationInput — 四元组装配逐键断言", () => {
  it("battle 全量 / progression Pick 2 / level Pick 4 / economy 经双读，与手写引擎输入逐字段相等", () => {
    const input = buildExperienceExpectationInput(sources);
    expect(input.battle).toEqual(battleData);
    expect(input.progression).toEqual({
      progressionModules: progressionData.progressionModules,
      tierDifferentiation: progressionData.tierDifferentiation,
    });
    expect(input.economy).toEqual({
      dailyBudget: ECONOMY_INTENT.anchors.dailyBudget,
      consumptionSplitProgression: ECONOMY_INTENT.consumptionSplit.progression,
    });
    expect(input.level).toEqual({
      totalLevels: levelData.totalLevels,
      expectedDailyClears: levelData.expectedDailyClears,
      enemyDifficultyFactors: levelData.enemyDifficultyFactors,
      levelTypes: levelData.levelTypes,
    });
  });

  it("装配产物直接喂引擎与手写输入端到端同构（computed 输出深度相等）", () => {
    expect(computeExperienceExpectation(buildExperienceExpectationInput(sources))).toEqual(
      computeExperienceExpectation(makeInput())
    );
  });
});

describe("buildExperienceExpectationInput — framework / options 透传", () => {
  const framework = { experienceAnchors: { expectedMaxLevelDays: 45 } };

  it("framework 显式透传", () => {
    expect(buildExperienceExpectationInput(sources, framework).framework).toEqual(framework);
  });

  it("framework 缺省 → undefined（引擎 meta.expectedMaxLevelDays 键省略）", () => {
    const input = buildExperienceExpectationInput(sources);
    expect(input.framework).toBeUndefined();
    expect("expectedMaxLevelDays" in computeExperienceExpectation(input).meta).toBe(false);
  });

  it("options.pace 显式透传（引擎回显该档）", () => {
    const input = buildExperienceExpectationInput(sources, framework, { pace: "relaxed" });
    expect(input.options).toEqual({ pace: "relaxed" });
    expect(computeExperienceExpectation(input).pace).toBe("relaxed");
  });

  it("options 缺省 → undefined（引擎缺省 standard 档）", () => {
    const input = buildExperienceExpectationInput(sources);
    expect(input.options).toBeUndefined();
    expect(computeExperienceExpectation(input).pace).toBe("standard");
  });
});

describe("buildExperienceExpectationInput — 同构性（口径锚定）", () => {
  it("显式传参：build(src, fw, opts) 逐键 toEqual 手工装配输入对象（面板 useMemo 装配口径）", () => {
    const framework = { experienceAnchors: { expectedMaxLevelDays: 60 } };
    const options = { pace: "relaxed" as const };
    expect(buildExperienceExpectationInput(sources, framework, options)).toEqual({
      battle: battleData,
      progression: {
        progressionModules: progressionData.progressionModules,
        tierDifferentiation: progressionData.tierDifferentiation,
      },
      economy: {
        dailyBudget: { gold: [100, 500], gem: [5, 20] },
        consumptionSplitProgression: 0.4,
      },
      level: {
        totalLevels: levelData.totalLevels,
        expectedDailyClears: levelData.expectedDailyClears,
        enemyDifficultyFactors: levelData.enemyDifficultyFactors,
        levelTypes: levelData.levelTypes,
      },
      framework,
      options,
    });
  });
});
