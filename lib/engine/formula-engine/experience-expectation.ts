import type {
  ComputedBattleData,
  ComputedEconomyData,
  ComputedLevelData,
  ComputedProgressionData,
} from "@/lib/types/planning";
import {
  computeGrowthProjection,
  HORIZON_DAY,
  type GrowthProjectionBattle,
  type ProjectionPace,
} from "./growth-projection";
import {
  estimateProgressionCompletionDays,
  isValidResourceCostRow,
  type ProgressionModuleResult,
} from "./progression";
import { deriveConfigTableDrafts, type ConfigTableRefs } from "./config-table-export";

/** 配置表关联契约类型单源再导出（config-table-export.ts，下游消费免深路径 import） */
export type {
  ConfigTableRefs,
  ConfigTableRefEntry,
  ConfigTableUnavailableEntry,
  ConfigTableDraft,
  ConfigTableSources,
} from "./config-table-export";

/**
 * 玩家体验预期总表引擎（planning-four-expectation R4 / W3-A）。
 *
 * 第五类产物而非第五模块（决策 D4）：battle/economy/progression/level 四模块
 * confirmed 后的聚合推演，无 LLM 生成步骤——因此不入 ComputedPlanningData 联合、
 * 不注册 computeFromIntent 路由与 INTENT_VALIDATORS（growth-projection /
 * difficulty-mirror 独立导出先例），由面板层直调。
 *
 * 复用清单（禁止复刻）：
 * - computeGrowthProjection / HORIZON_DAY（growth-projection.ts）：线进度
 *   （heroStage 渐近 / equipmentStage 品质插值+档内强化 / skill、pet 深度）、
 *   属性供给插值、computePowerStats 战力、pace 三档形变——逐锚点整体复用
 * - estimateProgressionCompletionDays / isValidResourceCostRow（progression.ts）：
 *   瓶颈资源估算（average 档未取整均值 × consumptionSplit 分摊）与行级守卫
 * - 薄封装同口径实现（关键常量/函数未导出，注明来源行号，总量 < 30 行）：
 *   SHAPE_FACTOR / HERO_K / logProgress / lineRatio（growth-projection.ts L89-L117、L162-L165）
 *
 * 纯函数：无 LLM、无随机、无 Date.now，相同输入产出相同输出。
 */

// ==================== 契约类型（下游 ui/pages 单元按此并行开发，签名一字不差） ====================

/**
 * 四模块 confirmed 产物源（buildExperienceExpectationInput 装配入口的输入形状）：
 * battle 全量消费，progression/economy/level 由装配函数 Pick 提炼。
 */
export interface ExperienceExpectationSources {
  battle: ComputedBattleData;
  progression: ComputedProgressionData;
  economy: ComputedEconomyData;
  level: ComputedLevelData;
}

export interface ExperienceExpectationInput {
  battle: GrowthProjectionBattle;
  progression: Pick<ComputedProgressionData, "progressionModules" | "tierDifferentiation">;
  economy: { dailyBudget?: Record<string, [number, number]>; consumptionSplitProgression?: number };
  level: Pick<ComputedLevelData, "totalLevels" | "expectedDailyClears" | "enemyDifficultyFactors" | "levelTypes">;
  framework?: { experienceAnchors?: { expectedMaxLevelDays?: number } };
  options?: { anchors?: number[]; pace?: ProjectionPace };
}

export interface ExperienceExpectationAnchor {
  day: number;
  heroLevel: number;
  totalPower: number;
  lines: Array<{ id: string; name: string; type: string; progress: number; stage: string; tier: number }>;
  attributes: Array<{ id: string; name: string; value: number; sharePct: number }>;
  productionConsumption: { dailyProduction: Record<string, number>; dailyConsumption: Record<string, number>; dailyNet: Record<string, number> };
  difficulty: { levelIndex: number; difficultyScore: number; recommendedPower: number; enemyFactors: { normal: number; elite: number; boss: number } };
}

export interface ComputedExperienceExpectation {
  moduleType: "experience-expectation";
  anchors: ExperienceExpectationAnchor[];
  pace: ProjectionPace;
  meta: { expectedMaxLevelDays?: number; bottleneckResourceId?: string; totalWavesNote?: string };
  /**
   * 配置表关联（V10-W3 T2 起非空）：level/battle confirmed 在场时填表草稿真实引用
   * （表名 + 工作区路径，deriveConfigTableDrafts 单源派生）；未开通模块
   * （economy/progression/gacha）显式 unavailable + 原因（最小版纪律，全模块铺开进 V11）。
   * 类型与派生逻辑单源在 config-table-export.ts。
   */
  configTableRefs: ConfigTableRefs;
}

// ==================== 默认参数与薄封装（来源注明） ====================

/** 默认锚点（D5 锚点加密版：约 9~12 锚点） */
const DEFAULT_ANCHORS = [1, 3, 7, 14, 30, 60, 90, 120, 180];

/** 装备品质上限（growth-projection.ts L84 DEFAULT_EQUIPMENT_MAX_QUALITY=6，未导出；
 *  总表与 computeGrowthProjection 默认展示口径保持一致） */
const EQUIPMENT_MAX_QUALITY = 6;

/** 日预算默认档（progression.ts L243-L248 resolveDailyBudget 的 [100,500] 缺省） */
const DEFAULT_DAILY_BUDGET: [number, number] = [100, 500];

/** 养成分摊份额缺省 0.5（progression.ts computeTimeBudget / estimateProgressionCompletionDays
 *  的 consumptionSplitProgression ?? 0.5 同引擎默认口径） */
const DEFAULT_PROGRESSION_SPLIT = 0.5;

/** tierCount 合法域 2~8 越界回退 3 档（progression.ts L38-L42 DEFAULT_TIER_DIFFERENTIATION 缺省） */
const DEFAULT_TIER_COUNT = 3;

/** 每日通关数量缺省 3（level.ts L34 DEFAULT_EXPECTED_DAILY_CLEARS） */
const DEFAULT_EXPECTED_DAILY_CLEARS = 3;

/** 敌人难度三档系数缺省（level.ts L35 DEFAULT_ENEMY_DIFFICULTY_FACTORS） */
const DEFAULT_ENEMY_FACTORS = { normal: 0.75, elite: 1.2, boss: 2 };

/** 节奏幂形变因子（薄封装来源：growth-projection.ts L89-L93 SHAPE_FACTOR，未导出） */
const SHAPE_FACTOR: Record<ProjectionPace, number> = {
  aggressive: 0.7,
  standard: 1,
  relaxed: 1.4,
};

/** hero 渐近曲线速率 k 随 pace（薄封装来源：growth-projection.ts L96-L100 HERO_K，未导出） */
const HERO_K: Record<ProjectionPace, number> = {
  aggressive: 0.04,
  standard: 0.025,
  relaxed: 0.015,
};

/** log-progress 进度 0→1（薄封装来源：growth-projection.ts L115-L117 logProgress，未导出；
 *  HORIZON_DAY 为其导出常量，day=180 精确收敛 1） */
function logProgress(day: number, shapeFactor: number): number {
  return Math.min(1, Math.pow(Math.log(day) / Math.log(HORIZON_DAY), shapeFactor));
}

/** 线进度率 r_line(day) ∈ [0,1]（薄封装来源：growth-projection.ts L162-L165 lineRatio，
 *  按 battle 线 type 路由：hero 渐近 / 其余 log-progress） */
function lineRatio(type: string, day: number, pace: ProjectionPace): number {
  if (type === "hero") return Math.min(1, 1 - Math.exp(-HERO_K[pace] * day));
  return logProgress(day, SHAPE_FACTOR[pace]);
}

// ==================== 输入解析（缺字段走契约缺省，不抛错） ====================

function finiteOr(value: number | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function resolvePositiveInt(value: number | undefined, fallback: number): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

/**
 * 锚点解析：合法输入 = 非空数组、round 后每项在 [1, HORIZON_DAY]（即 clamp 值域）、
 * 非降序（升序未去重的输入由引擎去重）；畸形（乱序/超界/空/非有限数）整组回退默认。
 */
function resolveAnchors(raw: number[] | undefined): number[] {
  if (!Array.isArray(raw) || raw.length === 0) return [...DEFAULT_ANCHORS];
  const days = raw.map((d) => Math.round(Number(d)));
  const inRange = days.every((d) => Number.isFinite(d) && d >= 1 && d <= HORIZON_DAY);
  const ascending = days.every((d, i) => i === 0 || days[i - 1] <= d);
  if (!inRange || !ascending) return [...DEFAULT_ANCHORS];
  return Array.from(new Set(days));
}

/** tierCount 合法域对齐 progression.resolveTierDifferentiation（2 ≤ n ≤ 8） */
function resolveTierCount(raw: number | undefined): number {
  const n = Math.round(Number(raw));
  return Number.isFinite(n) && n >= 2 && n <= 8 ? n : DEFAULT_TIER_COUNT;
}

function resolveEnemyFactors(
  raw: ComputedLevelData["enemyDifficultyFactors"] | undefined
): ComputedLevelData["enemyDifficultyFactors"] {
  return {
    normal: finiteOr(raw?.normal, DEFAULT_ENEMY_FACTORS.normal),
    elite: finiteOr(raw?.elite, DEFAULT_ENEMY_FACTORS.elite),
    boss: finiteOr(raw?.boss, DEFAULT_ENEMY_FACTORS.boss),
  };
}

// ==================== tier 映射（equipment 品质 → 档位） ====================

/** 品质连续值 q∈[1,maxQuality] 线性映射到 [1,tierCount]，clamp 端点；仅 equipment 线有意义 */
function equipmentTier(quality: number, tierCount: number): number {
  if (tierCount <= 1) return 1;
  const t = Math.round(
    1 + ((quality - 1) / (EQUIPMENT_MAX_QUALITY - 1)) * (tierCount - 1)
  );
  return Math.min(tierCount, Math.max(1, t));
}

// ==================== 产消口径（average 档，对齐 computeTimeBudget 语义） ====================

/**
 * progression 线 → growth-projection 进度模型类型匹配：
 * battle.growthLines 按 id 精确匹配 > name 精确匹配；均匹配不上时回退 hero 渐近口径
 * （progression 主轴 coreProgressionAxis=level 的等级线缺省语义）。
 */
function lineTypeOf(
  mod: ProgressionModuleResult,
  battleLines: GrowthProjectionBattle["growthLines"]
): string {
  return (
    battleLines.find((l) => l.id === mod.id)?.type ??
    battleLines.find((l) => l.name === mod.name)?.type ??
    "hero"
  );
}

/** 线当前等级 = 进度率 × maxLevel 取整（heroStage 展示口径同源 Math.round），clamp [0, maxLevel] */
function lineLevelAt(
  mod: ProgressionModuleResult,
  lineType: string,
  day: number,
  pace: ProjectionPace
): number {
  const cap = resolvePositiveInt(mod?.maxLevel, 1);
  return Math.min(cap, Math.max(0, Math.round(lineRatio(lineType, day, pace) * cap)));
}

/** 区间 [prevDay, day) 内该线等级推进段的资源消耗合计（整数累加，除法留给调用方统一口径） */
function segmentCostSums(
  mod: ProgressionModuleResult,
  lineType: string,
  prevDay: number,
  day: number,
  pace: ProjectionPace
): Record<string, number> {
  const sums: Record<string, number> = {};
  const from = lineLevelAt(mod, lineType, prevDay, pace);
  const to = lineLevelAt(mod, lineType, day, pace);
  if (to <= from) return sums;
  for (const row of mod?.resourceCostTable ?? []) {
    if (!isValidResourceCostRow(row)) continue;
    if (row.level > from && row.level <= to) {
      for (const [rid, cost] of Object.entries(row.resourceCost)) {
        const n = Number(cost);
        if (Number.isFinite(n)) sums[rid] = (sums[rid] ?? 0) + n;
      }
    }
  }
  return sums;
}

// ==================== 主函数 ====================

export function computeExperienceExpectation(
  input: ExperienceExpectationInput
): ComputedExperienceExpectation {
  const pace: ProjectionPace = input.options?.pace ?? "standard";
  const days = resolveAnchors(input.options?.anchors);

  // 1. 线进度/属性/战力：growth-projection 同源整体复用（days 全 ≥1 → filter 不丢，
  //    projection.anchors 与 days 一一对应；battle 结构字段缺失由其抛错，面板层 catch 降级）
  const projection = computeGrowthProjection(input.battle, { anchors: days, pace });

  // 2. progression / level 契约缺省解析（旧数据缺字段不阻断渲染）
  const modules: ProgressionModuleResult[] = input.progression?.progressionModules ?? [];
  const tierCount = resolveTierCount(input.progression?.tierDifferentiation?.tierCount);
  const clears = resolvePositiveInt(
    input.level?.expectedDailyClears,
    DEFAULT_EXPECTED_DAILY_CLEARS
  );
  const totalLevels = resolvePositiveInt(input.level?.totalLevels, 1);
  const enemyFactors = resolveEnemyFactors(input.level?.enemyDifficultyFactors);
  /** 简化口径（R4 推演口径 5）：难度咬合取首个 levels 表非空类型的关卡表 */
  const firstLevelType = (input.level?.levelTypes ?? []).find(
    (t) => Array.isArray(t?.levels) && t.levels.length > 0
  );

  // 3. 产出侧（average 档口径）：资源键集 = progression 各线 resourceCostTable 键并集；
  //    日产出 = 各资源日预算未取整均值 × consumptionSplit 养成分摊份额（Spec：产消对照用
  //    economy 日预算×consumptionSplit 口径，与 estimate 满级天数同分摊语义）；
  //    缺失资源走 [100,500] 默认档、缺分摊走 0.5
  const resourceIds: string[] = [];
  const resourceIdSet = new Set<string>();
  for (const mod of modules) {
    for (const row of mod?.resourceCostTable ?? []) {
      if (!isValidResourceCostRow(row)) continue;
      for (const rid of Object.keys(row.resourceCost)) {
        if (!resourceIdSet.has(rid)) {
          resourceIdSet.add(rid);
          resourceIds.push(rid);
        }
      }
    }
  }
  const progressionShare = input.economy?.consumptionSplitProgression ?? DEFAULT_PROGRESSION_SPLIT;
  const dailyProduction: Record<string, number> = {};
  for (const rid of resourceIds) {
    const [lo, hi] = input.economy?.dailyBudget?.[rid] ?? DEFAULT_DAILY_BUDGET;
    dailyProduction[rid] = ((lo + hi) / 2) * progressionShare;
  }

  const battleLines = input.battle.growthLines ?? [];

  // 4. 逐锚点推演
  const anchors: ExperienceExpectationAnchor[] = days.map((day, i) => {
    const pa = projection.anchors[i];

    // heroLevel：hero 线 progress（等级连续值）取整，与 heroStage `Lv.` 展示口径同源
    const heroLine = pa.lines.find((l) => l.type === "hero");
    const heroLevel = heroLine ? Math.round(heroLine.progress) : 0;

    // 线进度 + tier（仅 equipment 线映射品质档位，其余线 tier=0）
    const lines = pa.lines.map((l) => ({
      id: l.id,
      name: l.name,
      type: l.type,
      progress: l.progress,
      stage: l.stage,
      tier: l.type === "equipment" ? equipmentTier(l.progress, tierCount) : 0,
    }));

    // 产消：区间 [d_prev, d) 各线按其当前等级的升级消耗合计 ÷ 区间天数；首锚点全 0
    const dailyConsumption: Record<string, number> = {};
    for (const rid of resourceIds) dailyConsumption[rid] = 0;
    if (i > 0) {
      const prevDay = days[i - 1];
      const span = day - prevDay;
      if (span > 0) {
        const sums: Record<string, number> = {};
        for (const mod of modules) {
          const seg = segmentCostSums(mod, lineTypeOf(mod, battleLines), prevDay, day, pace);
          for (const [rid, v] of Object.entries(seg)) {
            sums[rid] = (sums[rid] ?? 0) + v;
          }
        }
        for (const rid of resourceIds) dailyConsumption[rid] = (sums[rid] ?? 0) / span;
      }
    }
    const dailyNet: Record<string, number> = {};
    for (const rid of resourceIds) {
      dailyNet[rid] = dailyProduction[rid] - dailyConsumption[rid];
    }

    // 难度咬合：levelIndex = clamp(round(day × 每日通关数), 1, totalLevels)；
    // difficultyScore/recommendedPower 取首类型关卡表第 clamp(levelIndex,1,count) 行
    const levelIndex = Math.min(totalLevels, Math.max(1, Math.round(day * clears)));
    let difficultyScore = 0;
    let recommendedPower = 0;
    if (firstLevelType) {
      const row =
        firstLevelType.levels[
          Math.min(firstLevelType.levels.length, Math.max(1, levelIndex)) - 1
        ];
      difficultyScore = finiteOr(row?.difficultyScore, 0);
      recommendedPower = finiteOr(row?.recommendedPower, 0);
    }

    return {
      day,
      heroLevel,
      totalPower: pa.totalPower,
      lines,
      attributes: pa.attributes,
      productionConsumption: { dailyProduction, dailyConsumption, dailyNet },
      difficulty: { levelIndex, difficultyScore, recommendedPower, enemyFactors },
    };
  });

  // 5. meta：体验锚透传 + 瓶颈资源复用 estimate 单源（average 档 + consumptionSplit 分摊）
  const estimate = estimateProgressionCompletionDays(
    modules,
    input.economy?.dailyBudget,
    input.economy?.consumptionSplitProgression
  );
  const expectedMaxLevelDays = Number(input.framework?.experienceAnchors?.expectedMaxLevelDays);
  const meta: ComputedExperienceExpectation["meta"] = {
    ...(Number.isFinite(expectedMaxLevelDays) ? { expectedMaxLevelDays } : {}),
    // 瓶颈资源键必须落在产出键集内才可信（estimate 与产出同源恒成立，此处双保险）
    ...(estimate.bottleneckResourceId && resourceIdSet.has(estimate.bottleneckResourceId)
      ? { bottleneckResourceId: estimate.bottleneckResourceId }
      : {}),
    totalWavesNote: `全 ${totalLevels} 关按每日 ${clears} 关约 ${Math.ceil(totalLevels / clears)} 天推完`,
  };

  return {
    moduleType: "experience-expectation",
    anchors,
    pace,
    meta,
    // 配置表关联（V10-W3 T2）：level/battle confirmed 在场时填表草稿引用，
    // 未开通模块显式 unavailable（单源派生，导出载荷与总表 refs 同源不漂移）
    configTableRefs: deriveConfigTableDrafts({
      battle: input.battle,
      level: input.level,
    }).refs,
  };
}

// ==================== 四元组 → 引擎输入装配（单源：UI 面板与 agent 工具同源消费） ====================

/**
 * economy confirmed 产物 → 引擎 economy 入参（B/C 双读口径，原样迁自
 * ExperienceExpectationPanel 组件私有同名函数（agent-p1-tools T1 单源提取），
 * 对齐 ProgressionPlanDisplay extractEconomyDailyBudget / extractProgressionSplit 先例）：
 * - dailyBudget：C 形态存量 `_anchors.dailyBudget` 直读优先，B 形态引擎产物
 *   `resourceTypes[].dailyBudgetRange` 聚合兜底
 * - consumptionSplitProgression：根级直拷（B 形态）→ `_anchors` → `_strategy`
 *   回显兜底（C 形态存量）
 */
function extractEconomyInput(
  economy: ComputedEconomyData,
): ExperienceExpectationInput["economy"] {
  const anchored = (
    economy as { _anchors?: { dailyBudget?: Record<string, [number, number]> } }
  )._anchors?.dailyBudget;

  let dailyBudget: Record<string, [number, number]> | undefined;
  if (anchored && Object.keys(anchored).length > 0) {
    dailyBudget = anchored;
  } else {
    const mapped: Record<string, [number, number]> = {};
    for (const rt of economy.resourceTypes ?? []) {
      if (
        rt?.id &&
        Array.isArray(rt.dailyBudgetRange) &&
        rt.dailyBudgetRange.length === 2
      ) {
        mapped[rt.id] = [rt.dailyBudgetRange[0], rt.dailyBudgetRange[1]];
      }
    }
    if (Object.keys(mapped).length > 0) dailyBudget = mapped;
  }

  const eco = economy as {
    consumptionSplit?: { progression?: number };
    _anchors?: { consumptionSplit?: { progression?: number } };
    _strategy?: { consumptionSplit?: { progression?: number } };
  };
  const consumptionSplitProgression =
    eco.consumptionSplit?.progression ??
    eco._anchors?.consumptionSplit?.progression ??
    eco._strategy?.consumptionSplit?.progression;

  return { dailyBudget, consumptionSplitProgression };
}

/**
 * 四模块 confirmed 产物 → computeExperienceExpectation 输入（装配单源，Spec 裁决 4）：
 * UI 面板（ExperienceExpectationPanel useMemo）与 agent 工具（experience_expectation）
 * 同源消费，防双份实现漂移——服务端计算与 UI 产物一致性由此单源保障。
 *
 * 装配口径（原面板 useMemo）：battle 全量直传；progression Pick 2 键；
 * economy 走 B/C 双读（extractEconomyInput）；level Pick 4 键；
 * framework / options 透传（缺省 undefined，引擎落缺省——framework 无体验锚时
 * meta.expectedMaxLevelDays 键省略、options 无 pace 时落 standard 档）。
 */
export function buildExperienceExpectationInput(
  confirmed: ExperienceExpectationSources,
  framework?: ExperienceExpectationInput["framework"],
  options?: { pace?: ProjectionPace }
): ExperienceExpectationInput {
  const { battle, progression, economy, level } = confirmed;
  return {
    battle,
    progression: {
      progressionModules: progression.progressionModules,
      tierDifferentiation: progression.tierDifferentiation,
    },
    economy: extractEconomyInput(economy),
    level: {
      totalLevels: level.totalLevels,
      expectedDailyClears: level.expectedDailyClears,
      enemyDifficultyFactors: level.enemyDifficultyFactors,
      levelTypes: level.levelTypes,
    },
    framework,
    options,
  };
}
