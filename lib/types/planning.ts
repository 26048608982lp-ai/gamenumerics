/**
 * ComputedPlanningData — strongly-typed representation of the data
 * produced by the formula engine's computeFromIntent() for each module.
 *
 * Each variant is keyed by moduleType so consumers can narrow the type
 * with a simple switch / if on the discriminant field.
 *
 * 单源声明（followups-cleanup-stage1 Re.E1-1）：本文件是 Computed 形状的唯一
 * 权威源——引擎本地结果类型（EconomyComputeResult 等）一律为下方类型的别名，
 * 引擎输出含 moduleType 判别键。禁止反向（lib/types 引引擎形状）。
 */

import type { PlanningModuleType, GameType } from './project';
import type { CurveType } from './common';

// ==================== 共享子类型（intent 与 computed 复用） ====================

/**
 * 五步拆解建模推理链（intent 内的数值建模推理）。
 * 原 lib/engine/formula-engine/types.ts 本地定义，E1-1 收敛移入本单源，
 * 引擎侧 re-export 保留原导出名。
 *
 * 与 decisions.rationale 的分工：rationale（决策层）记录为何选择当前 decisions
 * 配置；reasoning（建模层）记录"目标→拆解→建模→关联→验证"完整推导。
 * GachaDesignIntent.reasoning 与 gacha-schema.ts 的 Zod schema 形状须与此一致。
 */
export interface DesignReasoning {
  goal: string;            // 1. 目标锚定：本模块服务的游戏目标
  decomposition: string[]; // 2. 机制拆解：可量化子系统/维度列表
  model: string;           // 3. 变量建模：变量关系与约束说明
  relations: string[];     // 4. 跨模块关联：与其他模块的联动点
  verification: string;    // 5. 验证：引擎/模拟/一致性校验方法
}

/**
 * 关键养成节点（F1：星级/解锁/突破/等级四类关键节点一等建模）。
 * 原 lib/engine/formula-engine/types.ts 本地定义，E1-1 收敛移入本单源
 * （progression intent 与 computed keyMilestones 共用），引擎侧 re-export。
 */
export interface KeyMilestone {
  id: string;                              // 如 "star_5"
  type: "star" | "unlock" | "breakthrough" | "level";
  label?: string;                          // 显示名，如 "5星"（中文）
  target: number;                          // star=星数 / level=等级 / unlock|breakthrough=序号
  unlockDescription?: string;              // 解锁能力描述，如 "解锁特殊技能"（中文）
  relatedModuleId?: string;                // 关联养成线 id（level 型建议提供）
  duplicateCount?: number;                 // 所需重复英雄只数（抽卡线，W1 透传，F3 消费）
  costResources: Record<string, number>;   // 达成该节点的累计材料消耗（资源ID→数量）
}

/** economy 消耗分布（intent 根级 consumptionSplit 与 computed 根级回显同形） */
export interface EconomyConsumptionSplit {
  progression: number;
  gacha: number;
  social: number;
  other: number;
}

/**
 * specialAttrFocus 矛盾组合静默丢弃的变更元数据（Re.E1-5）：
 * battle 引擎 resolveEffectiveFocus 判定矛盾（如投放线=装备但装备系统关闭）
 * 强制 none 时写入 computed.focusOverride，UI 据此展示非阻断提示。
 */
export interface BattleFocusOverride {
  from: 'equipment' | 'skill' | 'pet' | 'none';
  to: 'none';
  reason: string;
}

/**
 * 属性投放矩阵行（V8 W2-T2）：allocationMatrix 与 stageMatrices 各段共用的行形状
 * （每行 ΣweightPct = 100；行内 role = 段内数值标注——最大占比 primary）。
 */
export interface BattleAllocationRow {
  growthLineId: string;
  allocations: Array<{
    attributeId: string;
    role: 'primary' | 'secondary' | 'none';
    weightPct: number;
  }>;
}

// ==================== 游戏框架模块计算结果 ====================

/** game-framework 问卷决策（回显保真，AI 不可更改；T4a：contentPace 下沉 monetization 问卷；W1-A：基础定位四键 optional 迁入） */
export interface GameFrameworkDecisions {
  // 段一 基础定位（W1-A 自项目基础层 BASE_QUESTIONS 迁移语义；optional——存量 confirmed 数据 11 键不迁移不报错；R2 移位后段一余 3 题，benchmarkProduct 归段二）
  market?: "china" | "sea" | "west" | "mena" | "jpkr" | "global"; // 目标市场（与 UI 层 BASE_QUESTIONS 值域一字不差）
  platform?: "mobile" | "steam" | "wechat" | "douyin" | "tiktok" | "other"; // 游戏平台
  benchmarkProduct?: string; // 对标产品（select_with_custom 自由文本）
  differentiation?: string;  // 差异化特点（select_with_custom 自由文本）
  // 段二 核心定位
  gameGenre: GameType; // rpg / slg / roguelike / moba / card / casual（与项目 gameType 同枚举）
  corePillar: '数值成长' | '策略对抗' | '操作技巧' | '收集养成';
  targetPlayer: '碎片化学生党' | '通勤上班族' | '核心深度玩家' | '泛休闲用户';
  // 段三 体验目标（同语义复制自 economy/progression 问卷，键名沿用）
  economyGoal: 'generous' | 'balanced' | 'sink_heavy';
  spendingFocus: 'progression' | 'gacha' | 'social' | 'pvp';
  resourceAcquisition: 'steady' | 'burst' | 'quest_driven';
  progressionPace: 'fast_then_slow' | 'steady' | 'milestone';
  progressionFeedback: 'immediate' | 'milestone' | 'gradual';
  progressionBreadth: 'deep_few' | 'broad_many' | 'mixed';
  expectedMaxLevelDays: number;
  // 段四 商业定位
  monetizationModel: '买断制' | '内购中度' | '内购重度' | '广告混合';
}

/**
 * 品类风格卡（Spec genre-style-card R1）——gameGenre 单维静态映射的品类数值语境，
 * 供下游模块 prompt 注入消费（不进 intent/decisions，引擎单侧派生）。
 */
export interface GenreStyleCard {
  genre: GameType;            // 品类回显（rpg/slg/roguelike/moba/card/casual）
  positioning: string;        // 品类数值定位一句
  attributeStyle: string;     // 属性体系典型结构与数量
  progressionStyle: string;   // 养成线典型结构（深广/核心轴）
  levelSemantics: string;     // 关卡在该品类的语义形态
  economyStyle: string;       // 经济复杂度与资源循环特征
  powerCurveStyle: string;    // 战力曲线典型形态
  monetizationNote: string;   // 商业化特征
}

/**
 * ComputedGameFrameworkData — 字段级形状冻结（Spec planning-module-refactor §4 R1，跨波契约）。
 */
export interface ComputedGameFrameworkData {
  moduleType: 'game-framework';
  decisions: GameFrameworkDecisions;            // 回显（11 必答键 + 基础定位四键 optional 透传，W1-A）
  gameProfile: {
    positioning: string;                        // 定位一句话（genre×pillar 拼接）
    targetPlayerDesc: string;                   // 目标玩家描述
    experienceGoals: string[];                  // 体验目标清单（2-4 条）
  };
  coreLoop: {
    summary: string;                            // 核心循环一句话
    phases: Array<{ name: string; desc: string; frequency: string }>; // 循环环节 3-5 个
  };
  systemBlueprint: {
    suggestedLines: Array<{ key: string; name: string; enabled: boolean; reason: string }>;
    // hero 恒 enabled；equipment/skill/pet/heroStar 由 genre×pillar×breadth 映射
  };
  experienceAnchors: {
    expectedMaxLevelDays: number;               // 回显
    dailyPlayMinutes: [number, number];         // 日投入区间（targetPlayer×session 映射）
    monthlySpendDepth: [number, number];        // 月付费深度区间（monetizationModel 映射）
  };
  moduleRoadmap: Array<{ moduleType: string; priority: "high" | "medium" | "low"; note: string }>; // 6 项
  /** 品类风格卡（Spec genre-style-card R1）：gameGenre 单维静态映射，恒有（无缺省分支） */
  genreStyleCard: GenreStyleCard;
  /** intent 根级 provenance 回显（Re.E1-4：intent 存在该键时引擎写入 `_`+原键名） */
  _summary?: string;
  _reasoning?: DesignReasoning;
}

// ==================== 战斗模块计算结果 ====================

export interface ComputedBattleData {
  moduleType: 'battle';
  combatPacing: string;
  expectedCombatDuration: [number, number];
  attributeDesign: {
    primary: string[];
    secondary: string[];
    growthModels: Record<string, CurveType>;
  };
  attributeGrowthTable: Array<Record<string, unknown>>;
  damageSimulations: Array<Record<string, unknown>>;
  damageFormulaFramework: {
    baseFormula: string;
    coefficients: Record<string, number>;
    description: string;
  };
  skillFramework: {
    skillTypes: string[];
    maxSkillsPerCharacter: number;
    cooldownRange: [number, number];
    /** 技能明细（intent.strategy.skillFramework.skillDetails 透传；旧数据无此键）——
     * powerProfile 的技能倍率按 count 加权消费 */
    skillDetails?: Array<{
      type: string;
      count: number;
      cooldownRange: [number, number];
      avgMultiplier: number;
      description: string;
    }>;
  };
  attributeBudgets: Record<string, number>;
  /** W0 战力模型 v2：满级口径战力画像（与成长推演末锚同源单源函数，±0.5 一致） */
  powerProfile: {
    power: number;
    edps: number;
    ehp: number;
    /** 每点属性的战力增量（+1 数值微分）：attack/defense/hp/speed/crit */
    attrMarginalValues: Record<string, number>;
  };
  /** 结构层下沉（原框架层产出，T2b 起引擎派生）：系统开关回显 */
  systemSwitches: {
    formationSize: number;
    battlePace: 'realtime' | 'semi-realtime' | 'turn-based' | 'idle-auto';
    heroStarEnabled: boolean;
    equipmentEnabled: boolean;
    equipmentCategories: number;
    petEnabled: boolean;
    skillDepth: 'none' | 'upgrade' | 'upgrade-star';
    attributeScheme: 'classic-4' | 'extended-6' | 'special-flow';
    specialAttrFocus: 'equipment' | 'skill' | 'pet' | 'none';
  };
  /** 结构层下沉：成长线清单 */
  growthLines: Array<{
    id: string;
    name: string;
    type: 'hero' | 'equipment' | 'skill' | 'pet';
  }>;
  /** 结构层下沉：属性大类 */
  attributeCategories: Array<{
    id: string;
    name: string;
  }>;
  /** 结构层下沉：属性投放矩阵（每行 ΣweightPct = 100） */
  allocationMatrix: BattleAllocationRow[];
  /**
   * 属性投放矩阵阶段化（V8 W2-T2 层 1）：early/late 偏置乘数（值域 [0.5,2]，引擎
   * clamp）作用于基线矩阵后归一化 Σ=100 的三段矩阵——mid 恒等基线，三段各自完整
   * 覆盖全部成长线（bounds 只决定「哪份矩阵在哪个等级区间生效」的解释性元数据，
   * 非行切分）。仅当 intent.structuralDecisions.stageAllocation 声明且 biases 合法
   * 时写键（缺省恒等，S1）。
   */
  stageMatrices?: {
    /** 段边界绝对等级 [earlyEnd, lateStart]（裁决 A2：stages 恰 3 段取 deriveStageBounds 切点，否则 stageBounds ?? STAGE_BOUNDS_DEFAULT 占比换算） */
    bounds: [number, number];
    early: BattleAllocationRow[];
    mid: BattleAllocationRow[];
    late: BattleAllocationRow[];
  };
  /**
   * 养成线调度回显（V8 W2-T6a 层 2）：仅当 intent.structuralDecisions.lineSchedule
   * 声明时写键（缺省恒等，S1）。lines 为原样回显（openAt/unlockLevels 已 clamp 进
   * [1, maxLevel]），derived* 为 stages.ts 确定性推导产物（0 LLM）。
   */
  lineScheduleEcho?: {
    /** 调度回显（openAt/unlockLevels 已 clamp 进 [1, maxLevel]；openAt 非有限数的线被丢弃 → Partial） */
    lines: Partial<Record<string, { openAt: number; unlockLevels?: number[] }>>;
    /** 关键节点 = 开放事件 ∪ 解锁档（升序去重，起点 1 不计） */
    derivedKeyNodes: number[];
    /** 段边界绝对等级（恰 2 个有效 focus 切换点成对；否则缺省占比换算） */
    derivedStageBounds: [number, number];
    /** 段 focus 显式映射（Review P1-B）：仅 stages 恰 3 段且切点未回退才写键——growth-projection focusBoost 消费 */
    stageFocus?: { early: string; mid: string; late: string };
  };
  /** 矛盾问卷组合判定的变更元数据（Re.E1-5：静默丢弃发生时存在，值恒 to='none'） */
  focusOverride?: BattleFocusOverride;
  /**
   * 敌人强度基准乘数（questionnaire-ia W2 深档题，intent.anchors.enemyStrengthBaseline
   * 恒等透传）：难度镜像 tiers 的全局乘数基准——lenient=0.75 / standard=1.0 /
   * oppressive=1.2（rogue-fighter 实证：设定.json 敌人系数），消费方为
   * DifficultyMirrorBlock（tiers.map 系数相乘，与 TIERS_DEFAULT 正交）。
   * 缺省键 = 问卷未作答 / LLM 未产出（乘数 1.0，展示行为不变）。
   */
  enemyStrengthBaseline?: number;
  /** intent 根级 provenance 回显（Re.E1-4） */
  _summary?: string;
  _reasoning?: DesignReasoning;
}

// ==================== 经济模块计算结果 ====================

export interface ComputedEconomyData {
  moduleType: 'economy';
  resourceTypes: Array<{
    id: string;
    name: string;
    isPremium: boolean;
    sinks: string[];
    sources: string[];
    dailyBudgetRange: [number, number];
  }>;
  itemTypes: Array<{
    id: string;
    name: string;
    rarity: string;
    primarySource: string;
  }>;
  dailyBudgetTable: Array<Record<string, unknown>>;
  productionConsumptionRatio: Record<string, number>;
  valueChain: {
    exchangeRates: Array<{
      fromResource: string;
      toResource: string;
      rate: number;
      direction: 'one_way' | 'two_way';
      description: string;
    }>;
    valueHierarchy: Array<{
      tier: number;
      resources: string[];
      description: string;
    }>;
    inflationControl: {
      dailyCapByResource: Record<string, number>;
      sinkEfficiencyTarget: Record<string, number>;
    };
  };
  /** @deprecated 引擎历史输出键（与 dailyBudgetTable 同源），存量展示兼容保留；stage3 清理（2026-08）起引擎已停写该键——新产物仅 dailyBudgetTable */
  resourceBalanceTable?: Array<Record<string, unknown>>;
  /** 消耗分布回显（Re.E1-2：intent 根级直拷，`_strategy` 不再并入该键） */
  consumptionSplit?: EconomyConsumptionSplit;
  /** intent 根级 provenance 回显（Re.E1-4） */
  _summary?: string;
  _reasoning?: DesignReasoning;
}

// ==================== 养成模块计算结果 ====================

export interface ComputedProgressionData {
  moduleType: 'progression';
  progressionModules: Array<{
    id: string;
    name: string;
    focus: string;
    maxLevel: number;
    curveType: CurveType;
    contributionToAttributes: Record<string, number>;
    resourceCostTable: Array<{
      level: number;
      resourceCost: Record<string, number>;
      attributeContribution?: Record<string, number>;
      cumulativeCost: Record<string, number>;
    }>;
  }>;
  totalAttributeContribution: Record<string, number>;
  /**
   * 养成档位差异——档数 + 档间属性/消耗倍差
   * （intent 缺省 { tierCount: 3, attributeMultipliers: [1,2,4], costMultipliers: [1,1.5,2.5] }；
   * 恒有字段由引擎缺省保证；两数组长度恒 === tierCount、首元素恒 1）
   */
  tierDifferentiation: {
    tierCount: number;
    attributeMultipliers: number[];
    costMultipliers: number[];
  };
  /** 关键养成节点透传 + 引擎内资源引用检查（intent 未提供时键不出现） */
  keyMilestones?: Array<KeyMilestone & { missingResources: string[] }>;
  /** intent 根级 provenance 回显（Re.E1-4） */
  _summary?: string;
  _reasoning?: DesignReasoning;
}

// ==================== 关卡模块计算结果 ====================

export interface ComputedLevelData {
  moduleType: 'level';
  levelTypes: Array<{
    id: string;
    name: string;
    count: number;
    difficultyCurve: string;
    rewardResourceTypes: string[];
    levels: Array<{
      levelIndex: number;
      levelName: string;
      difficultyScore: number;
      recommendedPower: number;
      rewardEstimate: Record<string, number>;
    }>;
  }>;
  totalLevels: number;
  progressionPacing: {
    early: string;
    mid: string;
    late: string;
  };
  /** 每日通关数量（体验锚，intent 缺省 3；恒有字段由引擎缺省保证） */
  expectedDailyClears: number;
  /** 敌人难度因素差异三档系数（intent 缺省 { normal: 0.75, elite: 1.2, boss: 2 }；恒有字段由引擎缺省保证） */
  enemyDifficultyFactors: {
    normal: number;
    elite: number;
    boss: number;
  };
  /** intent 根级 provenance 回显（Re.E1-4） */
  _summary?: string;
  _reasoning?: DesignReasoning;
}

// ==================== 商业化模块计算结果 ====================

export interface ComputedMonetizationData {
  moduleType: 'monetization';
  paidResources: Array<{
    resourceTypeId: string;
    exchangeRate: number;
  }>;
  paymentProducts: Array<{
    id: string;
    name: string;
    category: string;
    priceRMB: number;
    contents: Record<string, number>;
  }>;
  productValueAnalysis: Array<Record<string, unknown>>;
  gachaCostAnalysis: Array<Record<string, unknown>>;
  paymentRatios: {
    freeToPaidRatio: number;
    lightSpenderShare: number;
    whaleShare: number;
  };
  paymentDepth: {
    minSpendForCompetitiveness: number;
    maxEffectiveSpend: number;
  };
  powerGap: {
    freeVsWhale: number;
    freeVsLight: number;
  };
  /** intent 根级 provenance 回显（Re.E1-4） */
  _summary?: string;
  _reasoning?: DesignReasoning;
}

// ==================== 抽卡模块计算结果 ====================

/**
 * ComputedGachaData — gacha 引擎计算结果（Re.E1-1 新增单源类型）。
 * **不入 ComputedPlanningData 联合**（difficulty-mirror 先例）：gacha computed 含
 * Map 型 distribution 的不可序列化预存 quirk（已登记 Follow-up，建议后续 JSON-safe 化），
 * 入联合会污染可序列化消费者的类型假设。
 * decisions/strategy 形状与引擎 GachaDesignIntent 同步（锚定
 * lib/engine/formula-engine/types.ts GachaDesignIntent）。
 */
export interface ComputedGachaData {
  moduleType: 'gacha';
  probabilityTable: Array<{ pulls: number; ssrRate: number; cumulativeChance: number }>;
  simulation: {
    averagePulls: number;
    medianPulls: number;
    stdDev: number;
    /** 抽数分布（Map 不可序列化 quirk——见上） */
    distribution: Map<number, number>;
    /** 总抽数分布（抽满 K 只目标）的经验分位 */
    percentiles: { p50: number; p90: number };
  };
  cumulativeRates: number[];
  expectedPulls: number;
  costExpectation: {
    perRarity: { rmb: number; pulls: number };
    monthlyFreePulls: number;
  };
  decisions: {
    guaranteeType: 'none' | 'pity' | 'soft' | 'dual';
    targetRarity: string;
    rationale: string;
  };
  strategy: {
    poolDesign: {
      rarities: Array<{ id: string; name: string; color: string; rate: number }>;
      name?: string;
    };
    guarantee: {
      type: 'none' | 'pity' | 'soft' | 'dual';
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
}

// ==================== 联合类型 ====================

/**
 * Discriminated union of all computed planning data variants.
 * Use data.moduleType to narrow.
 */
export type ComputedPlanningData =
  | ComputedGameFrameworkData
  | ComputedBattleData
  | ComputedEconomyData
  | ComputedProgressionData
  | ComputedLevelData
  | ComputedMonetizationData;

/**
 * Helper: map module type to the corresponding computed data type.
 * Useful when you know the module at compile-time.
 */
export type ComputedDataForModule<M extends PlanningModuleType> =
  M extends 'game-framework' ? ComputedGameFrameworkData
    : M extends 'battle' ? ComputedBattleData
      : M extends 'economy' ? ComputedEconomyData
        : M extends 'progression' ? ComputedProgressionData
          : M extends 'level' ? ComputedLevelData
            : M extends 'monetization' ? ComputedMonetizationData
              : never;
