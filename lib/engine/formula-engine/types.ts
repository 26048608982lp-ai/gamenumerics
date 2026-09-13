import type { PlanningModuleType, GameType } from "@/lib/types/project";
// Re-export CurveType from canonical source for backward compatibility
export type { CurveType } from "@/lib/types/common";
import type { CurveType } from "@/lib/types/common";
// Re.E1-1 单源收敛：DesignReasoning / KeyMilestone / EconomyConsumptionSplit 的
// 形状权威在 lib/types/planning.ts，此处 re-export 保留原导出名（消费方零改动）
export type {
  DesignReasoning,
  KeyMilestone,
  EconomyConsumptionSplit,
} from "@/lib/types/planning";
import type { DesignReasoning, KeyMilestone, EconomyConsumptionSplit } from "@/lib/types/planning";
// V8 W2 阶段化引擎（层 1 + 层 2）形状单源：
// MatrixColumn 引擎侧在 battle.ts（types.ts ← battle.ts 为类型引用，方向按
// 「battle.ts 侧定义再导出」处理）；LineSchedule / StageFocus / 派生纯函数在 stages.ts
import type { MatrixColumn } from "./battle";
import type { LineSchedule, StageFocus } from "./stages";

export interface AnchorPoints {
  [levelOrPosition: string]: Record<string, number>;
}

export interface DesignIntentBase {
  moduleType: PlanningModuleType;
}

// ==================== 战斗模块 ====================

/**
 * 属性投放矩阵阶段化（V8 W2-T2 层 1）：偏置是乘数而非绝对占比——
 * LLM/意图只表达 early/late 偏置方向与强度（值域 [0.5,2]，引擎侧 clamp），
 * 引擎对 base × bias 归一化回 Σ=100，结构上不可能破坏投放矩阵契约。
 * biases 空（无任何偏置值）或含非有限数 → 引擎整键忽略 = 恒等（不写 stageMatrices）。
 */
export interface StageAllocation {
  /** 阶段边界（等级占比，升序）——与 stages 互斥（Zod 约束 W3 波次；引擎按裁决 A2 取值） */
  stageBounds?: [number, number];
  /** 阶段重点线序列（段数自由；恰 3 段时 stageMatrices 边界取 deriveStageBounds 两切点） */
  stages?: StageFocus[];
  biases: {
    early?: Partial<Record<MatrixColumn, number>>;
    late?: Partial<Record<MatrixColumn, number>>;
  };
}

export interface BattleDesignIntent extends DesignIntentBase {
  moduleType: "battle";
  decisions: {
    attributeStyle: "simple" | "standard" | "complex";
    attributeCount: number;
    skillTypeCombo: "simple" | "standard" | "complex";
    rationale: string;
  };
  /**
   * 战斗结构决策（原框架层 decisions 下沉，planning-module-refactor Spec R2）：
   * 问卷回显保真 + FU2 确定性覆写（修订 3）。
   * 可选——LLM 无问卷路径合法缺省，引擎按 DEFAULT_STRUCTURAL_DECISIONS 兜底计算，
   * 输出形状恒定含 4 结构字段；S8 旧数据降级发生在 display 层（存量 confirmedData 不进引擎）。
   */
  structuralDecisions?: {
    formationSize: number;
    battlePace: "realtime" | "semi-realtime" | "turn-based" | "idle-auto";
    heroStarEnabled: boolean;
    equipmentEnabled: boolean;
    equipmentCategories: number;
    petEnabled: boolean;
    skillDepth: "none" | "upgrade" | "upgrade-star";
    attributeScheme: "classic-4" | "extended-6" | "special-flow";
    specialAttrFocus: "equipment" | "skill" | "pet" | "none";
    /**
     * 属性投放矩阵阶段化（V8 W2-T2 层 1，第 10 键，可选——缺省恒等）：
     * 声明且 biases 合法时引擎产出 computed.stageMatrices（early/mid/late 三段矩阵）。
     */
    stageAllocation?: StageAllocation;
    /**
     * 养成线调度（V8 W2-T6a 层 2，第 11 键，可选——缺省恒等）：
     * 声明时引擎产出 computed.lineScheduleEcho（回显 + derivedKeyNodes / derivedStageBounds）。
     */
    lineSchedule?: LineSchedule;
  };
  strategy: {
    combatType: "realtime" | "turnbased" | "auto";
    combatPacing: "fast" | "standard" | "slow";
    attributeDesign: {
      primary: string[];
      secondary: string[];
      growthModels: Record<string, CurveType>;
    };
    damageFormula: {
      type: "reduction" | "multiplicative" | "hybrid";
      baseFormula: string;
      coefficients: Record<string, number>;
    };
    skillFramework: {
      skillTypes: string[];
      maxSkillsPerCharacter: number;
      cooldownRange: [number, number];
      skillDetails?: Array<{
        type: string;
        count: number;
        cooldownRange: [number, number];
        avgMultiplier: number;
        description: string;
      }>;
    };
    expectedCombatDuration: [number, number];
  };
  anchors: {
    level_1: Record<string, number>;
    level_max: Record<string, number>;
    maxLevel: number;
    attributeBudgets: Record<string, number>;
    combatDurationTarget?: [number, number];
    hpAtkRatio?: number;
    /**
     * 敌人强度基准乘数（questionnaire-ia W2 深档题，数值形态存锚点）：
     * 问卷 lenient=0.75 / standard=1.0 / oppressive=1.2（rogue-fighter 实证：
     * settings/设定.json 敌人系数 普通 0.75 / 强力 1.2）。
     * 引擎不消费此值参与计算，仅透传 ComputedBattleData——难度镜像 tiers 的
     * 全局乘数基准由展示层（DifficultyMirrorBlock）消费。缺省 = 未作答（乘数 1.0）。
     */
    enemyStrengthBaseline?: number;
    /**
     * 曲线里程碑锚点（V8 W2-T3，可选——缺省恒等）：锚点序 [1, m₁…, max] 分段插值，
     * 段内 v₀ + (v₁−v₀) × curveShape(t)（curves.ts interpolateFromAnchors 多锚点能力）。
     * 畸形（非升序 / 段内与两端点不同向单调 / 值非有限数）→ 引擎整键忽略 = 恒等。
     */
    milestones?: Array<{ level: number; values: Record<string, number> }>;
  };
  reasoning?: DesignReasoning;
  summary?: string;
}

// ==================== 经济模块 ====================

export interface EconomyDesignIntent extends DesignIntentBase {
  moduleType: "economy";
  decisions: {
    resourceComplexity: "simple" | "moderate" | "complex";
    resourceCount: number;
    rationale: string;
  };
  strategy: {
    resourceTypes: Array<{
      id: string;
      name: string;
      isPremium: boolean;
      sinks: string[];
      sources: string[];
    }>;
    itemTypes?: Array<{
      id: string;
      name: string;
      rarity: string;
      primarySource: string;
    }>;
  };
  consumptionSplit: EconomyConsumptionSplit;
  anchors: {
    dailyBudget: Record<string, [number, number]>;
    productionConsumptionRatio: Record<string, number>;
  };
  reasoning?: DesignReasoning;
  summary?: string;
}

// ==================== 养成模块 ====================

export interface ProgressionModuleIntent {
  id: string;
  name: string;
  focus: string;
  curveType: CurveType;
  maxLevel: number;
  contributionToAttributes: Record<string, number>;
  level_1_cost: Record<string, number>;
  maxLevel_cost: Record<string, number>;
  isCore?: boolean;
}

// KeyMilestone 形状已收敛至 lib/types/planning.ts（Re.E1-1），本文件头部 re-export

export interface ProgressionDesignIntent extends DesignIntentBase {
  moduleType: "progression";
  decisions: {
    progressionDepth: "light" | "moderate" | "deep";
    moduleCount: number;
    coreProgressionAxis: string;
    rationale: string;
    /**
     * 档位差异（planning-four-expectation R3，可选——旧 intent 合法缺省）：
     * 档数 + 档间属性/消耗倍差（语义对应外包 xlsx 品质系数梯子）。
     * 约束：两数组长度 === tierCount、两数组首元素 === 1；畸形输入引擎整档回退缺省。
     */
    tierDifferentiation?: {
      tierCount: number;
      attributeMultipliers: number[];
      costMultipliers: number[];
    };
  };
  strategy: {
    modules: ProgressionModuleIntent[];
  };
  anchors: {
    totalMaxLevel: number;
  };
  /** 关键养成节点（可选扩展，intent 未提供时引擎输出不含对应键） */
  keyMilestones?: KeyMilestone[];
  reasoning?: DesignReasoning;
  summary?: string;
}

// ==================== 关卡模块 ====================

export interface LevelDesignIntent extends DesignIntentBase {
  moduleType: "level";
  decisions: {
    levelScale: "small" | "medium" | "large";
    totalLevels: number;
    rationale: string;
    /**
     * 每日通关数量（planning-four-expectation R2 体验锚，可选——旧 intent 合法缺省）：
     * int 1-20；引擎缺省 3，越界钳制 [1,20] 取整。
     */
    expectedDailyClears?: number;
    /**
     * 敌人难度因素差异（R2，可选）：普通/强力/Boss 三档系数，各 0.1-10；
     * 引擎缺省 { normal: 0.75, elite: 1.2, boss: 2 }，越界逐档钳制 [0.1,10]。
     */
    enemyDifficultyFactors?: {
      normal: number;
      elite: number;
      boss: number;
    };
  };
  strategy: {
    levelTypes: Array<{
      id: string;
      name: string;
      count: number;
      difficultyCurve: CurveType | "step";
      rewardResourceTypes: string[];
      gateType?: "clear_only" | "power_gate" | "time_gate";
    }>;
    progressionPacing: {
      early: string;
      mid: string;
      late: string;
    };
  };
  anchors: {
    firstLevelDifficulty: Record<string, number>;
    lastLevelDifficulty: Record<string, number>;
  };
  reasoning?: DesignReasoning;
  summary?: string;
}

// ==================== 商业化模块 ====================

export interface MonetizationDesignIntent extends DesignIntentBase {
  moduleType: "monetization";
  decisions: {
    monetizationModel: "gacha" | "battle_pass" | "cosmetic" | "mixed";
    primaryModel: string;
    rationale: string;
  };
  strategy: {
    paidResources: Array<{
      resourceTypeId: string;
      exchangeRate: number;
    }>;
    paymentProducts: Array<{
      id: string;
      name: string;
      category: "one_time" | "monthly" | "battle_pass" | "gacha";
      priceRMB: number;
      contents: Record<string, number>;
    }>;
    gachaProducts?: Array<{
      id: string;
      name: string;
      currencyType: string;
      costPerPull: number;
      categories: string[];
      baseSSRRate?: number;
      pity?: {
        hardPity: number;
        softPityStart: number;
        softPityIncrement: number;
        guaranteedFeatured?: boolean;
        featuredRate?: number;
      };
    }>;
  };
  anchors: {
    powerGap: {
      freeVsWhale: number;
      freeVsLight: number;
    };
    paymentDepth: {
      minSpendForCompetitiveness: number;
      maxEffectiveSpend: number;
    };
    paymentRatios?: {
      freeToPaidRatio: number;
      lightSpenderShare: number;
      whaleShare: number;
    };
    freeIncomeCeiling?: {
      dailyGem: number;
      monthlyRMBEquivalent: number;
    };
  };
  reasoning?: DesignReasoning;
  summary?: string;
}

// ==================== 抽卡模块 ====================

export interface GachaDesignIntent extends DesignIntentBase {
  moduleType: "gacha";
  decisions: {
    guaranteeType: "none" | "pity" | "soft" | "dual";
    targetRarity: string;
    rationale: string;
  };
  strategy: {
    poolDesign: {
      rarities: Array<{ id: string; name: string; color: string; rate: number }>;
      name?: string;
    };
    guarantee: {
      type: "none" | "pity" | "soft" | "dual";
      targetRarity: string;
      hardCount: number;
      softStart?: number;
      softIncrement?: number;
    };
    cost: {
      singleCost: number;
      tenCost?: number;
      currency: string;
    };
  };
  /** gacha 无传统锚点字段，保留可选以维持联合类型兼容 */
  anchors?: Record<string, unknown>;
  reasoning?: DesignReasoning;
  summary?: string;
}

// ==================== 游戏框架模块 ====================

/**
 * 游戏框架层 Design Intent（planning-module-refactor Spec §4 R1；
 * gf-questionnaire-optimization T4a：contentPace 下沉 monetization 问卷；
 * questionnaire-ia W1-A：基础定位四键 optional 迁入）。
 * 工作流唯一起点：decisions 承载问卷决策（11 必答键：核心定位 / 体验目标 / 商业定位，
 * + 基础定位四键 optional——存量 confirmed 数据 11 键不迁移不报错），
 * 引擎据此确定性派生设定卡 / 核心循环 / 系统构成建议 / 体验锚点 / 模块路线图（0 LLM）。
 */
export interface GameFrameworkDesignIntent extends DesignIntentBase {
  moduleType: "game-framework";
  decisions: {
    // 段一 基础定位（W1-A 自项目基础层 BASE_QUESTIONS 迁移语义；optional；R2 移位后段一余 3 题，benchmarkProduct 归段二）
    market?: "china" | "sea" | "west" | "mena" | "jpkr" | "global";
    platform?: "mobile" | "steam" | "wechat" | "douyin" | "tiktok" | "other";
    benchmarkProduct?: string; // select_with_custom 自由文本
    differentiation?: string;  // select_with_custom 自由文本
    // 段二 核心定位
    gameGenre: GameType; // rpg / slg / roguelike / moba / card / casual（与项目 gameType 同枚举）
    corePillar: "数值成长" | "策略对抗" | "操作技巧" | "收集养成";
    targetPlayer: "碎片化学生党" | "通勤上班族" | "核心深度玩家" | "泛休闲用户";
    // 段三 体验目标（同语义复制自 economy/progression 问卷，键名沿用）
    economyGoal: "generous" | "balanced" | "sink_heavy";
    spendingFocus: "progression" | "gacha" | "social" | "pvp";
    resourceAcquisition: "steady" | "burst" | "quest_driven";
    progressionPace: "fast_then_slow" | "steady" | "milestone";
    progressionFeedback: "immediate" | "milestone" | "gradual";
    progressionBreadth: "deep_few" | "broad_many" | "mixed";
    expectedMaxLevelDays: number;
    // 段四 商业定位
    monetizationModel: "买断制" | "内购中度" | "内购重度" | "广告混合";
  };
  strategy: {
    positioningNotes: string;
    loopNotes: string;
  };
  /** 框架层无数值锚点，anchors 可选空——沿用原框架层模式 */
  anchors?: Record<string, unknown>;
  reasoning?: DesignReasoning;
  summary?: string;
}

// ==================== 联合类型 ====================

export type AnyDesignIntent =
  | BattleDesignIntent
  | EconomyDesignIntent
  | ProgressionDesignIntent
  | LevelDesignIntent
  | MonetizationDesignIntent
  | GachaDesignIntent
  | GameFrameworkDesignIntent;