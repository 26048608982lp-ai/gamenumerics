import { interpolateFromAnchors } from "./curves";
import { STAGE_BOUNDS_DEFAULT } from "./stages";
import { stageBoundsToLevels } from "./stages";
import type {
  KeyMilestone,
  ProgressionDesignIntent,
  ProgressionModuleIntent,
} from "./types";
import type { CurveType } from "@/lib/types/common";
import type { ComputedProgressionData } from "@/lib/types/planning";

export interface ProgressionLevelRow {
  level: number;
  resourceCost: Record<string, number>;
  /** 类型可选对齐 lib/types 单源（Re.E1-1）；引擎运行时逐行恒写该键 */
  attributeContribution?: Record<string, number>;
  cumulativeCost: Record<string, number>;
}

export interface ProgressionModuleResult {
  id: string;
  name: string;
  focus: string;
  maxLevel: number;
  curveType: CurveType;
  contributionToAttributes: Record<string, number>;
  resourceCostTable: ProgressionLevelRow[];
}

/**
 * 计算结果类型 = lib/types 单源别名（Re.E1-1）：形状权威在 ComputedProgressionData
 * （含 moduleType 判别键 + keyMilestones 透传键）。
 */
type ProgressionComputeResult = ComputedProgressionData;

/**
 * 档位差异引擎缺省（planning-four-expectation R3）：ComputedProgressionData 恒有字段，
 * intent 未提供或畸形时整档回退此缺省（不部分采纳畸形输入）。
 */
const DEFAULT_TIER_DIFFERENTIATION: ComputedProgressionData["tierDifferentiation"] = {
  tierCount: 3,
  attributeMultipliers: [1, 2, 4],
  costMultipliers: [1, 1.5, 2.5],
};

/**
 * 档位差异解析：intent 缺省/畸形 → 整档回退缺省；合法 → 透传（数组拷贝防外部引用篡改）。
 * 合法域：2 ≤ tierCount ≤ 8、两数组长度 === tierCount、两数组首元素 === 1。
 */
function resolveTierDifferentiation(
  raw: ProgressionDesignIntent["decisions"]["tierDifferentiation"]
): ComputedProgressionData["tierDifferentiation"] {
  const isValid =
    raw !== undefined &&
    raw.tierCount >= 2 &&
    raw.tierCount <= 8 &&
    Array.isArray(raw.attributeMultipliers) &&
    Array.isArray(raw.costMultipliers) &&
    raw.attributeMultipliers.length === raw.tierCount &&
    raw.costMultipliers.length === raw.tierCount &&
    raw.attributeMultipliers[0] === 1 &&
    raw.costMultipliers[0] === 1;

  if (!isValid) {
    return {
      tierCount: DEFAULT_TIER_DIFFERENTIATION.tierCount,
      attributeMultipliers: [...DEFAULT_TIER_DIFFERENTIATION.attributeMultipliers],
      costMultipliers: [...DEFAULT_TIER_DIFFERENTIATION.costMultipliers],
    };
  }

  return {
    tierCount: raw.tierCount,
    attributeMultipliers: [...raw.attributeMultipliers],
    costMultipliers: [...raw.costMultipliers],
  };
}

export function computeProgressionFromIntent(
  intent: ProgressionDesignIntent
): ProgressionComputeResult {
  const { strategy } = intent;
  const { modules } = strategy;

  const progressionModules: ProgressionModuleResult[] = [];
  const totalAttributeContribution: Record<string, number> = {};

  for (const mod of modules) {
    const levelTable = computeModuleLevelTable(mod);
    progressionModules.push({
      id: mod.id,
      name: mod.name,
      focus: mod.focus,
      maxLevel: mod.maxLevel,
      curveType: mod.curveType,
      contributionToAttributes: mod.contributionToAttributes,
      resourceCostTable: levelTable,
    });

    // 累加属性贡献
    for (const [attr, contrib] of Object.entries(mod.contributionToAttributes)) {
      totalAttributeContribution[attr] = (totalAttributeContribution[attr] || 0) + contrib;
    }
  }

  // F1：关键养成节点透传 + 引擎内近似资源引用检查
  // （跨 economy 的完整校验由 cross-validator 规则 6 承担）
  let keyMilestones: ProgressionComputeResult["keyMilestones"];
  if (intent.keyMilestones) {
    const moduleResourceIds = new Set<string>();
    for (const mod of modules) {
      for (const rid of Object.keys(mod.level_1_cost)) moduleResourceIds.add(rid);
      for (const rid of Object.keys(mod.maxLevel_cost)) moduleResourceIds.add(rid);
    }
    keyMilestones = intent.keyMilestones.map((m) => ({
      ...m,
      missingResources: Object.keys(m.costResources).filter(
        (rid) => !moduleResourceIds.has(rid)
      ),
    }));
  }

  return {
    moduleType: "progression" as const,
    progressionModules,
    totalAttributeContribution,
    tierDifferentiation: resolveTierDifferentiation(
      intent.decisions.tierDifferentiation
    ),
    ...(keyMilestones ? { keyMilestones } : {}),
  };
}

function computeModuleLevelTable(
  mod: ProgressionModuleIntent
): ProgressionLevelRow[] {
  const rows: ProgressionLevelRow[] = [];
  // 资源键集 = 两表并集（progression-P2a）：schema 层已要求 level_1_cost /
  // maxLevel_cost 键集一致，此处并集兜底防旧数据/绕过路径下独有键被静默丢弃
  //（旧行为只扫 level_1_cost，maxLevel 独有键整列消失）。单侧缺键走 ?? 默认锚
  const resourceIds = Array.from(
    new Set([...Object.keys(mod.level_1_cost), ...Object.keys(mod.maxLevel_cost)])
  );
  const cumulativeCost: Record<string, number> = {};

  for (const rid of resourceIds) {
    cumulativeCost[rid] = 0;
  }

  for (let lvl = 1; lvl <= mod.maxLevel; lvl++) {
    const resourceCost: Record<string, number> = {};

    for (const rid of resourceIds) {
      const startCost = mod.level_1_cost[rid] ?? 10;
      const endCost = mod.maxLevel_cost[rid] ?? 1000;

      // 逐级消耗：基于曲线类型从首级到末级插值
      if (lvl === 1) {
        resourceCost[rid] = startCost;
      } else if (lvl === mod.maxLevel) {
        resourceCost[rid] = endCost;
      } else {
        const anchors: Record<number, number> = {
          0: startCost,
          [mod.maxLevel - 1]: endCost,
        };
        const values = interpolateFromAnchors(
          anchors,
          mod.curveType,
          mod.maxLevel
        );
        resourceCost[rid] = Math.max(1, Math.round(values[lvl - 1]));
      }

      cumulativeCost[rid] = (cumulativeCost[rid] || 0) + resourceCost[rid];
    }

    // 属性贡献按等级线性分配
    const levelRatio = mod.maxLevel > 1 ? (lvl - 1) / (mod.maxLevel - 1) : 1;
    const attributeContribution: Record<string, number> = {};
    for (const [attr, totalContrib] of Object.entries(
      mod.contributionToAttributes
    )) {
      attributeContribution[attr] = Math.round(totalContrib * levelRatio * 1000) / 1000;
    }

    rows.push({
      level: lvl,
      resourceCost,
      attributeContribution,
      cumulativeCost: { ...cumulativeCost },
    });
  }

  return rows;
}

export interface TimeBudgetRow {
  level: number;
  daysToNext: { casual: number; average: number; hardcore: number };
  cumulativeDays: { casual: number; average: number; hardcore: number };
}

export interface TimeBudgetModule {
  moduleId: string;
  moduleName: string;
  maxLevel: number;
  totalDays: { casual: number; average: number; hardcore: number };
  milestones: Array<{
    label: string;
    levelRange: string;
    days: { casual: number; average: number; hardcore: number };
  }>;
  levelTable: TimeBudgetRow[];
}

export interface TimeBudgetResult {
  modules: TimeBudgetModule[];
  speedComparison: Array<{
    phase: string;
    casualDaysPerLevel: number;
    averageDaysPerLevel: number;
    hardcoreDaysPerLevel: number;
  }>;
  /** 关键养成节点时间线（第 4 参数未提供时键不出现） */
  keyMilestoneTimeline?: KeyMilestoneTimelineEntry[];
}

/** 关键养成节点时间线条目（F1，Spec v6w1 §4.1） */
export interface KeyMilestoneTimelineEntry {
  id: string;
  type: KeyMilestone["type"];
  label?: string;
  target: number;
  unlockDescription?: string;
  resourceCost: Record<string, number>;
  days: { casual: number; average: number; hardcore: number };
}

/**
 * 日预算解析（引擎统一口径，computeTimeBudget / computeKeyMilestoneDays /
 * estimateProgressionCompletionDays 三处共享，growth-followups-trio Re3 N3 抽取）：
 * 缺失走 [100,500] 默认档。
 */
function resolveDailyBudget(
  economyDailyBudget: Record<string, [number, number]> | undefined,
  resourceId: string
): [number, number] {
  return economyDailyBudget?.[resourceId] || ([100, 500] as [number, number]);
}

/** 天数换算木桶除零安全口径（三处共享）：每日可用量 ≤0 视为不可获取 → 产 0 天 */
function costToDays(cost: number, dailyAvailable: number): number {
  return dailyAvailable > 0 ? cost / dailyAvailable : 0;
}

// ==================== 产消阶段差异（V8 W2-T4b R5：tierStageFactors） ====================

/**
 * 阶段因子数组防御（R5）：空数组 / 含非有限数 → undefined（视为无因子 = 现行为），
 * 不部分采纳畸形输入——与 resolveTierDifferentiation 的整档回退防御风格一致。
 */
function sanitizeTierStageFactors(
  factors: number[] | undefined
): number[] | undefined {
  if (!factors || factors.length === 0) return undefined;
  return factors.every((f) => Number.isFinite(f)) ? factors : undefined;
}

/**
 * 等级 L 的产消阶段因子（R5）：
 * - 阶段判定消费 stageBoundsToLevels 绝对等级单源（Spec R6：段末含端）：
 *   level ≤ earlyEnd → early s=0；level ≤ lateStart → mid s=0.5；else late s=1
 *   （⌈frac·L⌉ 边界级归属本段，与 stageMatrices / speedComparison 同构念）；
 * - 因子 = 阶段位置 s 在档数组上的归一位置线性插值：pos = s×(n-1)。
 *   tierCount=3 时 pos ∈ {0,1,2} 恰逐档直取（如 [1,2,4] → 1/2/4）；
 *   tierCount≠3 时按 pos 插值（如 n=4、s=0.5 → pos=1.5 → f[1]+(f[2]-f[1])×0.5）。
 * 无因子数组 → 1（现行为）；maxLevel ≤ 0 防御视为满进度（late）。
 */
function stageFactorAtLevel(
  factors: number[] | undefined,
  level: number,
  maxLevel: number
): number {
  if (!factors) return 1;
  const [earlyEnd, lateStart] = stageBoundsToLevels(STAGE_BOUNDS_DEFAULT, maxLevel);
  // maxLevel ≤ 0 防御保留原语义视为满进度（late）；正常路径按绝对等级段末含端判段
  const s =
    maxLevel <= 0
      ? 1
      : level <= earlyEnd
        ? 0
        : level <= lateStart
          ? 0.5
          : 1;
  const n = factors.length;
  if (n === 1) return factors[0];
  const pos = s * (n - 1);
  const i = Math.min(Math.floor(pos), n - 2);
  const frac = pos - i;
  return factors[i] + (factors[i + 1] - factors[i]) * frac;
}

export function computeTimeBudget(
  progressionModules: ProgressionModuleResult[],
  economyDailyBudget?: Record<string, [number, number]>,
  consumptionSplitProgression?: number,
  keyMilestones?: KeyMilestone[],
  /**
   * 产消阶段因子（V8 W2-T4b R5）：档间属性倍差数组（如 [1,2,4]）。
   * dailyAvailable = 日预算 × 分摊 × 阶段因子（阶段按 STAGE_BOUNDS_DEFAULT 判定，
   * 因子在档数组上归一位置插值）；不传 / 空数组 / 畸形 = 现行为（无因子）。
   */
  tierStageFactors?: number[],
  /**
   * 里程碑关键节点（V8 W2-T6c R8）：有值时里程碑节点 = keyNodes 本身（每节点查
   * levelTable 累计天数；节点超该模块 maxLevel 或查不到对应行 → 跳过）；
   * 不传 / 空数组 = 现固定三点（前期 1/3、半程 1/2、满级）零变化。
   */
  keyNodes?: number[]
): TimeBudgetResult {
  const progressionShare = consumptionSplitProgression ?? 0.5;
  const moduleCount = progressionModules.length || 1;
  const sharePerModule = progressionShare / moduleCount;
  const stageFactors = sanitizeTierStageFactors(tierStageFactors);

  const modules: TimeBudgetModule[] = progressionModules.map((mod) => {
    const levelTable: TimeBudgetRow[] = [];
    const cumulativeDays = { casual: 0, average: 0, hardcore: 0 };

    for (const row of mod.resourceCostTable) {
      // 行级守卫（Follow-ups P2 #5）：畸形存量行（resourceCost null/缺失）跳过不抛
      // TypeError；单源复用 estimateProgressionCompletionDays 同款守卫
      if (!isValidResourceCostRow(row)) continue;
      const daysToNext = { casual: 0, average: 0, hardcore: 0 };
      // R5 阶段因子：行等级在该模块等级轴上的阶段（无因子数组 → 1 = 现行为）
      const stageFactor = stageFactorAtLevel(stageFactors, row.level, mod.maxLevel);

      for (const [resourceId, cost] of Object.entries(row.resourceCost)) {
        const budgetRange = resolveDailyBudget(economyDailyBudget, resourceId);
        const avgBudget = (budgetRange[0] + budgetRange[1]) / 2;
        const dailyAvailableCasual = budgetRange[0] * sharePerModule * stageFactor;
        const dailyAvailableAverage = avgBudget * sharePerModule * stageFactor;
        const dailyAvailableHardcore = budgetRange[1] * sharePerModule * stageFactor;

        // 木桶效应：取所有资源中最长天数
        const daysCasual = costToDays(cost, dailyAvailableCasual);
        const daysAverage = costToDays(cost, dailyAvailableAverage);
        const daysHardcore = costToDays(cost, dailyAvailableHardcore);

        daysToNext.casual = Math.max(daysToNext.casual, daysCasual);
        daysToNext.average = Math.max(daysToNext.average, daysAverage);
        daysToNext.hardcore = Math.max(daysToNext.hardcore, daysHardcore);
      }

      cumulativeDays.casual += daysToNext.casual;
      cumulativeDays.average += daysToNext.average;
      cumulativeDays.hardcore += daysToNext.hardcore;

      levelTable.push({
        level: row.level,
        daysToNext: { ...daysToNext },
        cumulativeDays: {
          casual: Math.round(cumulativeDays.casual * 100) / 100,
          average: Math.round(cumulativeDays.average * 100) / 100,
          hardcore: Math.round(cumulativeDays.hardcore * 100) / 100,
        },
      });
    }

    const totalDays = cumulativeDays;

    // 里程碑
    const milestones = buildMilestones(mod.maxLevel, levelTable, keyNodes);

    return {
      moduleId: mod.id,
      moduleName: mod.name,
      maxLevel: mod.maxLevel,
      totalDays: {
        casual: Math.round(totalDays.casual * 10) / 10,
        average: Math.round(totalDays.average * 10) / 10,
        hardcore: Math.round(totalDays.hardcore * 10) / 10,
      },
      milestones,
      levelTable,
    };
  });

  // 前中后期速度对比
  const speedComparison = buildSpeedComparison(modules);

  // F1：关键养成节点时间线（按 intent 顺序透传，不做排序假设）
  let keyMilestoneTimeline: KeyMilestoneTimelineEntry[] | undefined;
  if (keyMilestones) {
    const modulesById = new Map(modules.map((m) => [m.moduleId, m]));
    keyMilestoneTimeline = keyMilestones.map((m) => ({
      id: m.id,
      type: m.type,
      ...(m.label !== undefined ? { label: m.label } : {}),
      target: m.target,
      ...(m.unlockDescription !== undefined
        ? { unlockDescription: m.unlockDescription }
        : {}),
      resourceCost: m.costResources,
      days: computeKeyMilestoneDays(
        m,
        economyDailyBudget,
        sharePerModule,
        modulesById,
        stageFactors
      ),
    }));
  }

  return {
    modules,
    speedComparison,
    ...(keyMilestoneTimeline ? { keyMilestoneTimeline } : {}),
  };
}

/**
 * 单个关键养成节点的达成天数（三档）。
 *
 * - star/unlock/breakthrough 型：材料瓶颈 = max over costResources(数量 ÷ (资源日预算 × sharePerModule × 阶段因子))，
 *   与 computeTimeBudget 行级计算同式同参（木桶 + 分摊）；无日预算时沿用 [100,500] fallback。
 * - level 型且 relatedModuleId 可定位：天数 = max(材料瓶颈, 该 module 在 target 等级的 cumulativeDays)；
 *   无法定位（module 不存在或 target 超出等级表）退化为纯材料瓶颈。
 * - 空 costResources 视为"无材料瓶颈"：材料瓶颈取 0，不抛异常（level 型仍可从 cumulativeDays 取值）。
 * - R5 阶段因子等级口径：level 型可定位 → target 在该模块等级轴上的阶段因子（与行级
 *   cumulativeDays@target 同轴对齐，防同函数输出内两套天数口径分裂，Spec R5 裁决）；
 *   其余（非 level 型 / 无法定位）target 无等级轴语义（星数/序号）→ 不虚构因子（1）。
 */
function computeKeyMilestoneDays(
  milestone: KeyMilestone,
  economyDailyBudget: Record<string, [number, number]> | undefined,
  sharePerModule: number,
  modulesById: Map<string, TimeBudgetModule>,
  stageFactors?: number[]
): { casual: number; average: number; hardcore: number } {
  const relatedMod =
    milestone.type === "level" && milestone.relatedModuleId
      ? modulesById.get(milestone.relatedModuleId)
      : undefined;
  const stageFactor = relatedMod
    ? stageFactorAtLevel(stageFactors, milestone.target, relatedMod.maxLevel)
    : 1;

  const materialDays = { casual: 0, average: 0, hardcore: 0 };

  for (const [resourceId, amount] of Object.entries(milestone.costResources)) {
    const budgetRange = resolveDailyBudget(economyDailyBudget, resourceId);
    const avgBudget = (budgetRange[0] + budgetRange[1]) / 2;
    const dailyAvailableCasual = budgetRange[0] * sharePerModule * stageFactor;
    const dailyAvailableAverage = avgBudget * sharePerModule * stageFactor;
    const dailyAvailableHardcore = budgetRange[1] * sharePerModule * stageFactor;

    materialDays.casual = Math.max(
      materialDays.casual,
      costToDays(amount, dailyAvailableCasual)
    );
    materialDays.average = Math.max(
      materialDays.average,
      costToDays(amount, dailyAvailableAverage)
    );
    materialDays.hardcore = Math.max(
      materialDays.hardcore,
      costToDays(amount, dailyAvailableHardcore)
    );
  }

  if (relatedMod) {
    const row = relatedMod.levelTable.find((r) => r.level === milestone.target);
    if (row) {
      return roundDays({
        casual: Math.max(materialDays.casual, row.cumulativeDays.casual),
        average: Math.max(materialDays.average, row.cumulativeDays.average),
        hardcore: Math.max(materialDays.hardcore, row.cumulativeDays.hardcore),
      });
    }
  }

  return roundDays(materialDays);
}

/** 精度对齐行级 cumulativeDays：保留 2 位小数 */
function roundDays(days: { casual: number; average: number; hardcore: number }) {
  return {
    casual: Math.round(days.casual * 100) / 100,
    average: Math.round(days.average * 100) / 100,
    hardcore: Math.round(days.hardcore * 100) / 100,
  };
}

/**
 * 模块里程碑（R8）：keyNodes 有值 → 节点 = keyNodes（每节点查 levelTable 累计天数）；
 * 无 → 现固定三点（前期 1/3、半程 1/2、满级）。
 * 节点超出该模块 maxLevel（多模块各自上限不同）或查不到对应行 → 跳过该节点
 * （非兜底末行——静默映射末行会虚报节点天数，Spec R8 裁决，跳过语义诚实）。
 * 空数组 / 含非有限数视为无 keyNodes（走现固定三点）；升序去重为防御性归一
 * （调用方 deriveKeyNodes 已排序去重，此处幂等）。
 */
function buildMilestones(
  maxLevel: number,
  levelTable: TimeBudgetRow[],
  keyNodes?: number[]
): TimeBudgetModule["milestones"] {
  if (
    keyNodes &&
    keyNodes.length > 0 &&
    keyNodes.every((n) => Number.isFinite(n))
  ) {
    const nodeMilestones: TimeBudgetModule["milestones"] = [];
    const nodes = Array.from(new Set(keyNodes)).sort((a, b) => a - b);
    for (const node of nodes) {
      if (node > maxLevel) continue;
      const row = levelTable.find((r) => r.level === node);
      if (!row) continue;
      nodeMilestones.push({
        label: `节点${nodeMilestones.length + 1}(1-${node}级)`,
        levelRange: `1-${node}`,
        days: { ...row.cumulativeDays },
      });
    }
    return nodeMilestones;
  }

  const milestones: TimeBudgetModule["milestones"] = [];
  const points = [
    { label: "前期", frac: 1 / 3 },
    { label: "半程", frac: 1 / 2 },
    { label: "满级", frac: 1 },
  ];

  for (const { label, frac } of points) {
    const targetLevel = Math.max(1, Math.round(maxLevel * frac));
    const row = levelTable.find((r) => r.level === targetLevel) || levelTable[levelTable.length - 1];
    const endLevel = targetLevel;
    milestones.push({
      label: `${label}(1-${endLevel}级)`,
      levelRange: `1-${endLevel}`,
      days: { ...row.cumulativeDays },
    });
  }

  return milestones;
}

function buildSpeedComparison(
  modules: TimeBudgetModule[],
): TimeBudgetResult["speedComparison"] {
  // 阶段切分消费 STAGE_BOUNDS_DEFAULT 单源（V8 W2-T1，两套口径合一）：
  // 三等分 [1/3, 2/3] → [0.2, 0.7] 为已批准缺省行为变化（Spec 裁决 A1）；
  // speedComparison 是跨模块分数口径聚合，恒消费分数缺省、不接 stages 派生切点（裁决 A3）。
  // V8 W3-T5（Spec R6）：区间组段改为 stageBoundsToLevels 绝对等级单源——
  // 每模块按自身 maxLevel 换算 earlyEnd/lateStart（⌈frac·L⌉ 段末含端，清偿
  // 原 ⌊⌋+1 分数残留），与 stageFactorAtLevel / stageMatrices 同构念。
  const phases = ["前期", "中期", "后期"] as const;

  return phases.map((phase, phaseIdx) => {
    let totalCasual = 0;
    let totalAverage = 0;
    let totalHardcore = 0;
    let totalLevelCount = 0;

    for (const mod of modules) {
      const [earlyEnd, lateStart] = stageBoundsToLevels(
        STAGE_BOUNDS_DEFAULT,
        mod.maxLevel
      );
      // 段末含端组段：early [1..earlyEnd] / mid [earlyEnd+1..lateStart] / late [lateStart+1..maxLevel]
      const [startLevel, endLevel] =
        phaseIdx === 0
          ? [1, earlyEnd]
          : phaseIdx === 1
            ? [earlyEnd + 1, lateStart]
            : [lateStart + 1, mod.maxLevel];

      if (endLevel < startLevel) continue;

      for (const row of mod.levelTable) {
        if (row.level >= startLevel && row.level <= endLevel) {
          totalCasual += row.daysToNext.casual;
          totalAverage += row.daysToNext.average;
          totalHardcore += row.daysToNext.hardcore;
          totalLevelCount++;
        }
      }
    }

    const count = totalLevelCount || 1;
    return {
      phase,
      casualDaysPerLevel: Math.round((totalCasual / count) * 100) / 100,
      averageDaysPerLevel: Math.round((totalAverage / count) * 100) / 100,
      hardcoreDaysPerLevel: Math.round((totalHardcore / count) * 100) / 100,
    };
  });
}

// ==================== 整体满级天数共享估算（growth-followups-trio Re3） ====================

/**
 * 整体满级天数 = max over lines 聚合口径单源（Follow-ups P2 #7）：
 * estimateProgressionCompletionDays 与 ProgressionPlanDisplay 共同消费，
 * 防「UI 侧 Math.max vs 引擎 estimate」双口径漂移。
 * 空数组返回 0（对齐引擎 estimate 现状 overallDays 初始 0：空模块集产 0 天）。
 */
export function overallDaysAcrossLines(lineTotals: number[]): number {
  if (lineTotals.length === 0) return 0;
  return Math.max(...lineTotals);
}

export interface ProgressionCompletionEstimate {
  /** 整体满级天数 = max(各线 Σ行木桶天数)；空模块集 / 无可获取资源产 0 */
  days: number;
  /** 瓶颈资源 id = 单资源粒度贡献最多天数者（并列取先扫描者）；无正贡献时不写键 */
  bottleneckResourceId?: string;
}

/**
 * 资源成本行有效性守卫（Re3 R2 行级过滤单源）：resourceCost 必须为非 null 对象，
 * 否则估算循环内 Object.entries(row.resourceCost) 会抛 TypeError。
 * estimateProgressionCompletionDays 内部逐行消费（坏行 continue 不牵连整线）；
 * 并导出供 cross-validator 与 params/registry 两消费点对齐口径。
 */
export function isValidResourceCostRow(row: unknown): row is ProgressionLevelRow {
  return (
    !!row &&
    typeof row === "object" &&
    typeof (row as ProgressionLevelRow).resourceCost === "object" &&
    (row as ProgressionLevelRow).resourceCost !== null
  );
}

/**
 * 木桶分摊同式的整体满级天数估算（唯一实现，防公式复刻漂移）：
 * 与 computeTimeBudget average 档共享口径（上方 resolveDailyBudget / costToDays
 * 共享子例程承载，Re3 N3 处置）；日预算用未取整 (min+max)/2 引擎口径。
 * 消费方：①cross-validator progression_tempo_vs_expectation 规则 ②params/registry
 * progression 指标提取器。
 *
 * 口径声明（followups-cleanup-stage1 Re.E1-3）：本函数为**设计师期望口径**——
 * 逐级行成本 ÷ 未取整 (min+max)/2 均值 × consumptionSplit 分摊（非表值取整）。
 * 口径快照锁定在 __tests__/estimate-completion-days.test.ts「口径快照」describe。
 *
 * @param splitPerProgression 养成分摊份额（economy consumptionSplit.progression），缺省 0.5 同引擎默认
 */
export function estimateProgressionCompletionDays(
  progressionModules: ProgressionModuleResult[],
  dailyBudgetRange?: Record<string, [number, number]>,
  splitPerProgression?: number
): ProgressionCompletionEstimate {
  const progressionShare = splitPerProgression ?? 0.5;
  const moduleCount = progressionModules.length || 1;
  const sharePerModule = progressionShare / moduleCount;

  // 各线总天数收集后统一聚合（Follow-ups P2 #7）：口径单源 overallDaysAcrossLines
  const lineTotals: number[] = [];
  let worstResourceId: string | undefined;
  let worstResourceDays = 0;

  for (const mod of progressionModules) {
    let lineTotalDays = 0;
    for (const row of mod.resourceCostTable) {
      // 行级守卫（Re3 R2）：残缺行跳过，不抛 TypeError、不用模块级过滤丢整条养成线
      if (!isValidResourceCostRow(row)) continue;
      let rowMaxDays = 0;
      for (const [resourceId, cost] of Object.entries(row.resourceCost)) {
        const budgetRange = resolveDailyBudget(dailyBudgetRange, resourceId);
        const avgBudget = (budgetRange[0] + budgetRange[1]) / 2; // 未取整均值口径
        const daysForThis = costToDays(cost, avgBudget * sharePerModule);
        if (daysForThis > worstResourceDays) {
          worstResourceDays = daysForThis;
          worstResourceId = resourceId;
        }
        rowMaxDays = Math.max(rowMaxDays, daysForThis);
      }
      lineTotalDays += rowMaxDays;
    }
    lineTotals.push(lineTotalDays);
  }
  const overallDays = overallDaysAcrossLines(lineTotals);

  return {
    days: overallDays,
    ...(worstResourceId !== undefined ? { bottleneckResourceId: worstResourceId } : {}),
  };
}
