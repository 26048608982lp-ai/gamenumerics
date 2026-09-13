import type { CurveType, LevelDesignIntent } from "../formula-engine/types";

// ==================== 参数档位定义 ====================
// 三题档位正交组合，全部合法组合均命中。
// 数值锚点对标选项 desc 中的成熟产品，且满足验收区间：
//   总关数 ∈ [30, 500]、每类关卡难度单调递增（引擎逐关插值后复检）。

type LevelGateType = NonNullable<
  LevelDesignIntent["strategy"]["levelTypes"][number]["gateType"]
>;

/** levelVariety 档位：关卡规模与关卡类型结构 */
interface LevelVarietyTier {
  scale: "small" | "medium" | "large";
  totalLevels: number;
  label: string;
  types: Array<{ id: string; name: string; count: number }>;
}

const VARIETY_TIERS: Record<string, LevelVarietyTier> = {
  // 咸鱼之王/寻道大千式：相似关卡快速堆量，效率导向
  template: {
    scale: "large",
    totalLevels: 200,
    label: "模板化批量",
    types: [
      { id: "normal", name: "普通关卡", count: 180 },
      { id: "elite", name: "精英关卡", count: 20 },
    ],
  },
  // 原神地区/明日方舟章节式：每段有不同主题和机制变化
  themed: {
    scale: "medium",
    totalLevels: 120,
    label: "主题分区",
    types: [
      { id: "normal", name: "普通关卡", count: 70 },
      { id: "themed", name: "主题关卡", count: 30 },
      { id: "boss", name: "首领关卡", count: 20 },
    ],
  },
  // 杀戮尖塔/哈迪斯式：每个关卡都有专属设计，量少质高
  unique: {
    scale: "small",
    totalLevels: 60,
    label: "每关独特",
    types: [
      { id: "signature", name: "精编关卡", count: 45 },
      { id: "boss", name: "首领关卡", count: 15 },
    ],
  },
};

/** difficultyCurve 档位：曲线类型与首末难度锚点（gate 类 = 各结构中最高挑战的关卡类型） */
interface LevelCurveTier {
  curve: CurveType;
  /** 普通类关卡 [首关难度, 末关难度] */
  mainAnchors: [number, number];
  /** 最高挑战类关卡 [首关难度, 末关难度] */
  gateAnchors: [number, number];
  label: string;
}

const CURVE_TIERS: Record<string, LevelCurveTier> = {
  // 原神大世界式：线性平滑上升
  gradual: {
    curve: "linear",
    mainAnchors: [10, 90],
    gateAnchors: [25, 110],
    label: "缓慢递增",
  },
  // 明日方舟突袭式：指数曲线，前期慢后期跳
  spike: {
    curve: "exponential",
    mainAnchors: [8, 95],
    gateAnchors: [20, 115],
    label: "阶梯式跳跃",
  },
  // 杀戮尖塔/以撒式：普通关天花板压低，最高挑战关难度骤升形成瓶颈
  boss_gate: {
    curve: "linear",
    mainAnchors: [10, 60],
    gateAnchors: [45, 130],
    label: "BOSS 关卡瓶颈",
  },
};

/** progressionGate 档位：解锁门槛类型（value 与 intent gateType 枚举同源直映） */
const GATE_TIERS: Record<string, { gateType: LevelGateType; label: string }> = {
  clear_only: { gateType: "clear_only", label: "纯通关即解锁（原神魔神任务式）" },
  power_gate: { gateType: "power_gate", label: "战力门槛（明日方舟推荐等级式）" },
  time_gate: { gateType: "time_gate", label: "时间/体力限制（FGO AP 系统式）" },
};

// ==================== 深档题：mainlinePacing（主线与满级时点关系） ====================

/**
 * mainlinePacing（主线关卡与养成满级的时点关系）→ decisions 覆写档（值域映射层）：
 * 问卷侧 before_max/sync/after_max 三档映射到引擎枚举 small/medium/large，
 * totalLevels 取 50/150/400 基准值（满级前推完主线→精简约 50 关；与养成同步走完
 * →标准约 150；满级后仍有长主线→海量约 400）。缺省（题未答/直接 3 参调用）不覆写
 * = 现版本行为（向后兼容）。
 */
const LEVEL_SCALE_TIERS: Record<
  string,
  { scale: "small" | "medium" | "large"; totalLevels: number }
> = {
  before_max: { scale: "small", totalLevels: 50 },
  sync: { scale: "medium", totalLevels: 150 },
  after_max: { scale: "large", totalLevels: 400 },
};

/**
 * 关卡类型 counts 等比缩放到目标总关数（最大余数法取整）。
 * 引擎口径 totalLevels = Σ levelTypes[].count（formula-engine/level.ts），
 * 覆写 totalLevels 时必须同步缩放各类型 count 保持 Σ === 目标值；
 * 每类 count 下限 1（levelIntentSchema count.min(1)）。
 * 纯函数：不变异入参。preset 构建器与 route 覆写分派共用（单一副本）。
 *
 * 病态边界取舍（review 修复波 P2-1 声明）：类别数 > targetTotal 时
 * 「每类≥1」与「Σ=target」数学不可兼得（Σ ≥ 类别数 > target），本函数
 * 选择保前者——每类 count 下限 1 优先（不可产出 0 关的类型），Σ 偏离
 * target 是该病态输入下的有意让步（回收循环 floors[index] > 1 条件
 * 全不满足，cursor 耗尽退出）。preset 档位域类型数 ≤ 3、target ≥ 50
 * 不可达；applyLevelDeepTierOverrides 消费 LLM intent 的 levelTypes
 * 理论可达（LLM 产出超多类），此声明兼作该路径的防回归锚。
 */
export function scaleLevelTypeCounts(
  types: Array<{ count: number }>,
  targetTotal: number
): number[] {
  const baseTotal = types.reduce((sum, t) => sum + t.count, 0);
  if (baseTotal <= 0 || types.length === 0) {
    return types.map(() => Math.max(1, targetTotal));
  }
  const exact = types.map((t) => (t.count / baseTotal) * targetTotal);
  const floors = exact.map((v) => Math.max(1, Math.floor(v)));
  let remainder = targetTotal - floors.reduce((sum, c) => sum + c, 0);
  // 余数按小数部分降序（并列取先出现者）逐个 +1；超配（remainder<0）从最小余数处回收
  const order = exact
    .map((v, index) => ({ index, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index);
  let cursor = 0;
  while (remainder !== 0 && cursor < order.length * 2) {
    const { index } = order[cursor % order.length];
    if (remainder > 0) {
      floors[index] += 1;
      remainder -= 1;
    } else if (floors[index] > 1) {
      floors[index] -= 1;
      remainder += 1;
    }
    cursor += 1;
  }
  return floors;
}

// ==================== intent 构建（纯函数）===================

/**
 * 构建 level 预设 intent。
 * 入参为按题目顺序的问卷值（difficultyCurve / progressionGate / levelVariety
 * + 深档题 mainlinePacing 可选），调用前已由 resolveTemplateIntent 校验值 ∈ 预设 options。
 * mainlinePacing 传入时覆写 decisions.levelScale + totalLevels（枚举映射 small/medium/large，
 * 基准 50/150/400）并等比缩放各类型 counts；缺省时行为与深档题引入前版本完全一致。
 */
export function buildLevelIntent(
  difficultyCurve: string,
  progressionGate: string,
  levelVariety: string,
  mainlinePacing?: string,
): LevelDesignIntent {
  const variety = VARIETY_TIERS[levelVariety];
  const curveTier = CURVE_TIERS[difficultyCurve];
  const gate = GATE_TIERS[progressionGate];
  const scaleTier =
    mainlinePacing !== undefined ? LEVEL_SCALE_TIERS[mainlinePacing] : undefined;
  const scale = scaleTier?.scale ?? variety.scale;
  const totalLevels = scaleTier?.totalLevels ?? variety.totalLevels;

  // 关卡类型：结构由 levelVariety 决定；最后一类（最高挑战）承载 gateAnchors，
  // 其余用 mainAnchors —— boss_gate 档位下两类锚点差被拉大形成"普通关简单、瓶颈关骤升"
  const firstLevelDifficulty: Record<string, number> = {};
  const lastLevelDifficulty: Record<string, number> = {};
  const scaledCounts = scaleTier
    ? scaleLevelTypeCounts(variety.types, scaleTier.totalLevels)
    : variety.types.map((type) => type.count);
  const levelTypes = variety.types.map((type, index) => {
    const [firstDiff, lastDiff] =
      index === variety.types.length - 1 ? curveTier.gateAnchors : curveTier.mainAnchors;
    firstLevelDifficulty[type.id] = firstDiff;
    lastLevelDifficulty[type.id] = lastDiff;
    return {
      id: type.id,
      name: type.name,
      count: scaledCounts[index],
      difficultyCurve: curveTier.curve,
      rewardResourceTypes: ["gold", "exp_potion"],
      gateType: gate.gateType,
    };
  });

  return {
    moduleType: "level",
    decisions: {
      levelScale: scale,
      totalLevels,
      rationale: `${variety.label}关卡体系（共 ${totalLevels} 关），难度节奏为${curveTier.label}；解锁方式为${gate.label}。`,
    },
    strategy: {
      levelTypes,
      progressionPacing: {
        early: "前 1/5 关卡低难度快速推进，建立基础操作认知",
        mid: `中段按${curveTier.label}曲线抬升难度，引导养成投入`,
        late: "末段关卡需要系统养成支撑，形成长线追求目标",
      },
    },
    anchors: { firstLevelDifficulty, lastLevelDifficulty },
    summary: `${totalLevels} 关的${variety.label}关卡体系，${curveTier.label}难度节奏，${gate.label}。`,
  };
}

/**
 * level 深档键 LLM 路径确定性覆写（AI 增强场景）。
 * 仅 level 模块且 mainlinePacing ∈ {before_max,sync,after_max} 时覆写：
 * decisions.levelScale（枚举映射 small/medium/large）+ decisions.totalLevels（基准
 * 50/150/400），并按 scaleLevelTypeCounts 等比缩放 strategy.levelTypes[].count
 * 保持引擎口径 Σcounts === totalLevels 自洽。缺键、值 ∉ 值域（伪造 HTTP body）、
 * 非 level 模块或 strategy.levelTypes 缺失时保守跳过，返回原 intent。
 * 纯函数：不变异入参。供 planning 路由 applyQuestionnaireOverrides 分派消费。
 */
export function applyLevelDeepTierOverrides<T extends { moduleType: string }>(
  intent: T,
  questionnaireAnswers?: Record<string, string>
): T {
  if (intent.moduleType !== "level" || !questionnaireAnswers) {
    return intent;
  }
  const choice = questionnaireAnswers["mainlinePacing"];
  if (typeof choice !== "string" || !(choice in LEVEL_SCALE_TIERS)) {
    return intent;
  }
  const levelIntent = intent as T & {
    decisions: LevelDesignIntent["decisions"];
    strategy: LevelDesignIntent["strategy"];
  };
  if (!levelIntent.decisions || !levelIntent.strategy?.levelTypes?.length) {
    return intent;
  }
  const tier = LEVEL_SCALE_TIERS[choice];
  const scaledCounts = scaleLevelTypeCounts(levelIntent.strategy.levelTypes, tier.totalLevels);
  return {
    ...intent,
    decisions: { ...levelIntent.decisions, levelScale: tier.scale, totalLevels: tier.totalLevels },
    strategy: {
      ...levelIntent.strategy,
      levelTypes: levelIntent.strategy.levelTypes.map((lt, index) => ({
        ...lt,
        count: scaledCounts[index],
      })),
    },
  } as T;
}
