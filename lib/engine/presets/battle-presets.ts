import type { BattleDesignIntent } from "../formula-engine/types";

// ==================== 问卷题内嵌定义（判定自含，引擎域禁止 import UI）====================
// 来源：lib/planning/questionnaire-data.ts → MODULE_QUESTIONS（battle 2 题）
// + 原战斗框架模块 9 结构题（T2b 起归属 battle 问卷，T6a 重组三段排版）。
// 同步约定：问卷侧 key/options 变更时必须同步本文件与档位表。

/** 单道题的 key 与合法选项（值 ∉ options = 自由文本 → 回退 LLM 路径） */
interface QuestionDef {
  key: string;
  options: string[];
}

/** battle 问卷 13 题 = 9 结构键 + 2 战斗体验键 + 2 深档键（questionnaire-ia W2） */
const BATTLE_QUESTION_DEFS: QuestionDef[] = [
  // ---- 结构决策 9 键（原框架层问卷下沉） ----
  { key: "formationSize", options: ["1", "3", "5", "6"] },
  { key: "battlePace", options: ["realtime", "semi-realtime", "turn-based", "idle-auto"] },
  { key: "heroStarEnabled", options: ["no", "yes"] },
  { key: "equipmentEnabled", options: ["no", "yes"] },
  { key: "equipmentCategories", options: ["2", "4", "6"] },
  { key: "petEnabled", options: ["no", "yes"] },
  { key: "skillDepth", options: ["none", "upgrade", "upgrade-star"] },
  { key: "attributeScheme", options: ["classic-4", "extended-6", "special-flow"] },
  { key: "specialAttrFocus", options: ["equipment", "skill", "pet", "none"] },
  // ---- 战斗体验 2 键（原 battle 问卷 3 题去 combatType） ----
  { key: "combatPacing", options: ["fast", "standard", "slow"] },
  { key: "skillAcquisition", options: ["fixed_tree", "free_combine", "random"] },
  // ---- 深档 2 键（questionnaire-ia W2，值域与问卷 questionnaire-data.ts 逐字一致） ----
  { key: "damageFormulaType", options: ["reduction", "multiplicative", "hybrid"] },
  { key: "enemyStrengthBaseline", options: ["lenient", "standard", "oppressive"] },
];

type StructuralDecisions = NonNullable<BattleDesignIntent["structuralDecisions"]>;

/**
 * 问卷答案 → 结构决策（仅类型转换："yes"/"no"→boolean、数字串→number）。
 * 调用前已校验 9 键齐备且值 ∈ options。
 */
export function structuralDecisionsFromAnswers(
  answers: Record<string, string>
): StructuralDecisions {
  return {
    formationSize: Number(answers.formationSize),
    battlePace: answers.battlePace as StructuralDecisions["battlePace"],
    heroStarEnabled: answers.heroStarEnabled === "yes",
    equipmentEnabled: answers.equipmentEnabled === "yes",
    equipmentCategories: Number(answers.equipmentCategories),
    petEnabled: answers.petEnabled === "yes",
    skillDepth: answers.skillDepth as StructuralDecisions["skillDepth"],
    attributeScheme: answers.attributeScheme as StructuralDecisions["attributeScheme"],
    specialAttrFocus: answers.specialAttrFocus as StructuralDecisions["specialAttrFocus"],
  };
}

// ==================== 默认数值档位表（Spec planning-module-refactor 修订 6）====================
// combatPacing / skillAcquisition 两题 + battlePace 派生的 combatType 正交映射 strategy
// 骨架与 anchors 标准档，数值锚点对标选项 desc 中的成熟产品；档位表全文经 Orchestrator
// 审阅把关（T2b 交付项）。

/**
 * battlePace → combatType 派生表（gf-questionnaire-optimization T5）：
 * combatType（公式框架选型，3 值体验键）由战斗节奏（battlePace，4 值结构键）
 * 确定性派生——realtime/semi-realtime → realtime（减法公式）、
 * turn-based → turnbased（乘除混合）、idle-auto → auto（混合公式）。
 */
const COMBAT_TYPE_FROM_PACE: Record<string, string> = {
  realtime: "realtime",
  "semi-realtime": "realtime",
  "turn-based": "turnbased",
  "idle-auto": "auto",
};

/** combatType 档位：伤害公式框架选型 + 技能框架骨架 */
interface CombatTypeTier {
  label: string;
  damageFormula: BattleDesignIntent["strategy"]["damageFormula"];
  skillTypes: string[];
  maxSkillsPerCharacter: number;
  cooldownRange: [number, number];
  rationaleNote: string;
}

const COMBAT_TYPE_TIERS: Record<string, CombatTypeTier> = {
  // 原神/鸣潮式：动作类即时/半即时操作。减法公式（防御直接减伤）受击反馈直观，
  // defCoeff=0.6 让防御堆砌在实时对抗中有可感的减伤幅度；技能 CD 拉长（5-18s）支撑操作轮转。
  // W2 起该档的 damageFormula 骨架降级为深档题 reduction 档的同源默认（公式选型由 damageFormulaType 显式决定）。
  realtime: {
    label: "实时战斗",
    damageFormula: {
      type: "reduction",
      baseFormula: "伤害 = 攻击 × atkCoeff − 防御 × defCoeff",
      coefficients: { atkCoeff: 1.0, defCoeff: 0.6 },
    },
    skillTypes: ["普攻", "重击", "元素战技", "元素爆发"],
    maxSkillsPerCharacter: 4,
    cooldownRange: [5, 18],
    rationaleNote: "动作类即时/半即时操作，受击反馈直观",
  },
  // 崩铁/明日方舟式：回合制策略。乘除混合公式（K=100 经典归一常数）防御收益平滑无负溢出，
  // 长线数值稳定；战技近似每回合可用（CD 2-5 回合），终结技按能量充能。
  turnbased: {
    label: "回合制",
    damageFormula: {
      type: "multiplicative",
      baseFormula: "伤害 = 攻击 × atkCoeff × K / (防御 × defCoeff + K)",
      coefficients: { atkCoeff: 1.0, defCoeff: 0.5, K: 100 },
    },
    skillTypes: ["普攻", "战技", "终结技", "天赋"],
    maxSkillsPerCharacter: 4,
    cooldownRange: [2, 5],
    rationaleNote: "回合制策略，长线数值稳定优先",
  },
  // 咸鱼之王/寻道大千式：数值驱动自动结算。混合公式（flatBonus 垫底保前期体验 +
  // 乘法段放大会后期差距），匹配挂机长线成长；技能少而 CD 长（8-30s），低频高伤自动释放。
  auto: {
    label: "自动战斗",
    damageFormula: {
      type: "hybrid",
      baseFormula: "伤害 = (攻击 + flatBonus) × atkCoeff × (1 − 防御减免)",
      coefficients: { atkCoeff: 1.0, defCoeff: 0.45, flatBonus: 50 },
    },
    skillTypes: ["主动技能", "被动技能", "觉醒技"],
    maxSkillsPerCharacter: 3,
    cooldownRange: [8, 30],
    rationaleNote: "数值驱动自动结算，前期体验与后期放大兼顾",
  },
};

/**
 * questionnaire-ia W2 深档题：damageFormulaType → strategy.damageFormula 三件套
 * （type/baseFormula/coefficients 同源配套，直接复用 COMBAT_TYPE_TIERS 各档的公式骨架
 * ——单一副本，route 覆写与本构建器共用）。W2 起公式形态由该题显式决定，
 * 不再随 battlePace 派生；combatType（技能框架骨架）仍由 battlePace 派生。
 */
const DAMAGE_FORMULA_TIERS: Record<
  string,
  { damageFormula: BattleDesignIntent["strategy"]["damageFormula"]; rationaleNote: string }
> = {
  // 减算防御型：防御直接减免，破防博弈（rogue-fighter 实证 破防率/抗破防率结构）
  reduction: {
    damageFormula: COMBAT_TYPE_TIERS.realtime.damageFormula,
    rationaleNote: "减算防御型公式，防御直接减免",
  },
  // 乘算稀释型：百分比减伤边际递减
  multiplicative: {
    damageFormula: COMBAT_TYPE_TIERS.turnbased.damageFormula,
    rationaleNote: "乘算稀释型公式，减伤边际递减",
  },
  // 混合双段：减算 + 乘算叠加
  hybrid: {
    damageFormula: COMBAT_TYPE_TIERS.auto.damageFormula,
    rationaleNote: "混合双段公式，减算乘算叠加",
  },
};

/**
 * questionnaire-ia W2 深档题：enemyStrengthBaseline 三档 → 数值乘数锚点。
 * 乘数取 rogue-fighter 实证敌人系数（设定.json：普通敌人 0.75 / 强力 1.2），
 * standard（1.0）显式作答同样写键（显式作答 ≠ 缺省）；
 * 引擎不消费该锚点仅透传 ComputedBattleData，展示层（DifficultyMirrorBlock）消费。
 */
const ENEMY_STRENGTH_MULTIPLIERS: Record<string, number> = {
  lenient: 0.75,
  standard: 1.0,
  oppressive: 1.2,
};

/** combatPacing 档位：战斗时长 + HP/攻击比 + 攻击/生命锚点（TTK 语义一致） */
interface CombatPacingTier {
  label: string;
  duration: [number, number];
  /** 同级 HP / 同级 ATK 的比值 ≈ 同级普攻击杀刀数（TTK） */
  hpAtkRatio: number;
  atkLevel1: number;
  atkLevelMax: number;
  hpLevel1: number;
  hpLevelMax: number;
  spdLevel1: number;
  spdLevelMax: number;
  rationaleNote: string;
}

const COMBAT_PACING_TIERS: Record<string, CombatPacingTier> = {
  // 吸血鬼幸存者/暖雪式：速刷割草。10-15s 战斗 → TTK 短（hp/atk=6，约 6 刀击杀）；
  // 攻击锚点抬高（120→6000，50 倍跨度）放大割草爽感，HP 池相应压浅（720→36000）。
  fast: {
    label: "快节奏",
    duration: [10, 15],
    hpAtkRatio: 6,
    atkLevel1: 120,
    atkLevelMax: 6000,
    hpLevel1: 720,
    hpLevelMax: 36000,
    spdLevel1: 12,
    spdLevelMax: 60,
    rationaleNote: "10-15 秒速刷，TTK≈6 刀的浅血池高攻击",
  },
  // 明日方舟/原神式：标准策略空间。30-45s 战斗 → 经典坦克系数 hp/atk=10
  //（同级普攻约 10 刀击杀，含 3-4 轮技能循环）；100→5000 攻击 50 倍跨度为业界主流成长带宽。
  standard: {
    label: "标准节奏",
    duration: [30, 45],
    hpAtkRatio: 10,
    atkLevel1: 100,
    atkLevelMax: 5000,
    hpLevel1: 1000,
    hpLevelMax: 50000,
    spdLevel1: 10,
    spdLevelMax: 50,
    rationaleNote: "30-45 秒标准战斗，TTK≈10 刀经典坦克系数",
  },
  // 崩铁忘却之庭/杀戮尖塔式：深度策略多阶段。60s+ 战斗 → 有效 HP 池加深
  //（hp/atk=14，约 14 刀）为治疗/资源/阶段转换留博弈空间；攻击绝对值压低（80→4000）拉长单场。
  slow: {
    label: "慢节奏",
    duration: [60, 90],
    hpAtkRatio: 14,
    atkLevel1: 80,
    atkLevelMax: 4000,
    hpLevel1: 1120,
    hpLevelMax: 56000,
    spdLevel1: 8,
    spdLevelMax: 40,
    rationaleNote: "60 秒+深度策略，TTK≈14 刀的深血池",
  },
};

/** skillAcquisition 档位：技能获取方式 → skillDetails + decisions.skillTypeCombo */
interface SkillAcquisitionTier {
  label: string;
  skillTypeCombo: BattleDesignIntent["decisions"]["skillTypeCombo"];
  skillDetails: NonNullable<BattleDesignIntent["strategy"]["skillFramework"]["skillDetails"]>;
  rationaleNote: string;
}

const SKILL_ACQUISITION_TIERS: Record<string, SkillAcquisitionTier> = {
  // 暗黑破坏神/哈迪斯式：固定技能树。主干主动技数量克制（2 个）倍率中高（2.2）
  // 匹配树节点解锁成本；被动常驻（CD 0 表示无冷却）撑起树深度。
  fixed_tree: {
    label: "固定技能树",
    skillTypeCombo: "standard",
    skillDetails: [
      { type: "主动技能", count: 2, cooldownRange: [8, 15], avgMultiplier: 2.2, description: "技能树主干主动节点，随树深度逐步解锁" },
      { type: "被动技能", count: 2, cooldownRange: [0, 0], avgMultiplier: 1.0, description: "常驻被动加成节点" },
    ],
    rationaleNote: "预设路线逐步解锁，主干技能少而深",
  },
  // 原神配队/杀戮尖塔式：自由搭配。3 主动位自由组合保证 Build 多样性，
  // 单技能倍率适中（1.8）让强度来自组合而非单卡。
  free_combine: {
    label: "自由搭配",
    skillTypeCombo: "complex",
    skillDetails: [
      { type: "主动技能", count: 3, cooldownRange: [5, 12], avgMultiplier: 1.8, description: "技能池自选组合的核心输出位" },
      { type: "被动技能", count: 1, cooldownRange: [0, 0], avgMultiplier: 1.0, description: "Build 支撑被动" },
    ],
    rationaleNote: "技能池自选构建 Build，组合深度优先",
  },
  // 哈迪斯/暖雪式：随机获取。单局 roguelike 速刷 → CD 短（3-8s）、倍率适中（1.6）、
  // 框架保持轻量（simple），随机性承担重玩价值而非数值深度。
  random: {
    label: "随机获取",
    skillTypeCombo: "simple",
    skillDetails: [
      { type: "随机技能", count: 3, cooldownRange: [3, 8], avgMultiplier: 1.6, description: "单局内随机获取，快节奏轮换" },
    ],
    rationaleNote: "单局随机技能快轮换，轻量框架",
  },
};

// ==================== 属性设计（attributeScheme 映射，与结构层自洽）====================

/**
 * attributeScheme → attributeDesign（primary/secondary 词全部可被 cross-validator
 * 规则 A 同义词归一到自身矩阵类目，模板直算零误报）。
 * growthModels 依据：攻击 exponential（战力膨胀主轴，50 倍跨度）；防御 sigmoid
 * （边际递减防堆砌）；生命/速度 linear（稳定可预期）；特殊属性 linear 线性投放。
 */
const ATTRIBUTE_DESIGNS: Record<
  StructuralDecisions["attributeScheme"],
  BattleDesignIntent["strategy"]["attributeDesign"]
> = {
  "classic-4": {
    primary: ["ATK", "HP"],
    secondary: ["DEF", "SPD"],
    growthModels: { ATK: "exponential", HP: "linear", DEF: "sigmoid", SPD: "linear" },
  },
  "extended-6": {
    primary: ["ATK", "HP", "crit"],
    secondary: ["DEF", "SPD", "effect-hit"],
    growthModels: {
      ATK: "exponential", HP: "linear", DEF: "sigmoid", SPD: "linear",
      crit: "linear", "effect-hit": "linear",
    },
  },
  "special-flow": {
    primary: ["ATK", "HP", "element-attack"],
    secondary: ["DEF", "SPD", "penetration", "special-resist"],
    growthModels: {
      ATK: "exponential", HP: "linear", DEF: "sigmoid", SPD: "linear",
      "element-attack": "linear", penetration: "linear", "special-resist": "linear",
    },
  },
};

/** attributeScheme → decisions 档（复杂度与类目数一致，供 UI 摘要展示） */
const ATTRIBUTE_DECISION_TIERS: Record<
  StructuralDecisions["attributeScheme"],
  { style: BattleDesignIntent["decisions"]["attributeStyle"]; label: string }
> = {
  "classic-4": { style: "simple", label: "四维属性体系" },
  "extended-6": { style: "standard", label: "六维扩展属性" },
  "special-flow": { style: "complex", label: "七维特化属性" },
};

// ==================== 锚点组装 ====================

/** 满级上限：中重度卡牌主流满级（对齐 growth-projection DEFAULT_HERO_MAX_LEVEL=60） */
const MAX_LEVEL = 60;
/** 防御锚点：1 级 50 / 满级 1500（30 倍——防御成长慢于攻击，堆砌收益递减设计） */
const DEF_LEVEL_1 = 50;
const DEF_LEVEL_MAX = 1500;

/** 特殊属性满级锚点（extended-6 / special-flow；1 级均为 0——特殊属性由对应系统从 0 投放） */
const SPECIAL_ATTR_ANCHORS: Record<string, number> = {
  crit: 25,          // 暴击 5%→25%：克制设计，升级+遗物逐级解锁收益
  "effect-hit": 40,  // 效果命中 0→40：御魂类系统投放的主阵地
  "element-attack": 3000, // 元素攻击独立伤害池（约为满级攻击的 60-75%）
  penetration: 800,  // 穿透对高防目标定向收益
  "special-resist": 600,  // 特殊抗性生存向投放
};
const SPECIAL_ATTR_LEVEL_1: Record<string, number> = {
  crit: 5, // 暴击起点 5%：保证开局有正向反馈
};

/** combatPacing 档 + attributeScheme → level_1 / level_max / attributeBudgets 锚点 */
function buildAnchors(
  pacing: CombatPacingTier,
  scheme: StructuralDecisions["attributeScheme"]
): Pick<BattleDesignIntent["anchors"], "level_1" | "level_max" | "attributeBudgets"> {
  const design = ATTRIBUTE_DESIGNS[scheme];
  const attrs = [...design.primary, ...design.secondary];
  const level_1: Record<string, number> = {};
  const level_max: Record<string, number> = {};
  for (const attr of attrs) {
    if (attr === "ATK") {
      level_1[attr] = pacing.atkLevel1;
      level_max[attr] = pacing.atkLevelMax;
    } else if (attr === "HP") {
      level_1[attr] = pacing.hpLevel1;
      level_max[attr] = pacing.hpLevelMax;
    } else if (attr === "DEF") {
      level_1[attr] = DEF_LEVEL_1;
      level_max[attr] = DEF_LEVEL_MAX;
    } else if (attr === "SPD") {
      level_1[attr] = pacing.spdLevel1;
      level_max[attr] = pacing.spdLevelMax;
    } else {
      level_1[attr] = SPECIAL_ATTR_LEVEL_1[attr] ?? 0;
      level_max[attr] = SPECIAL_ATTR_ANCHORS[attr] ?? 0;
    }
  }
  return { level_1, level_max, attributeBudgets: { ...level_max } };
}

// ==================== intent 构建（纯函数）====================

/**
 * 构建 battle 预设 intent（模板直算，13 题 → intent）。
 * 13 键全部齐备且 ∈ options 才直算；任一缺失或自由文本 → null（回退 LLM 路径）。
 * 与 buildEconomyIntent 同构：档位正交组合，全部合法组合均命中。
 * combatType 由 battlePace 派生（T5）；damageFormula 三件套由深档题 damageFormulaType
 * 显式决定（W2，不再随 pace）；enemyStrengthBaseline 三档 → 数值乘数存锚点。
 */
export function buildBattleIntent(
  answers: Record<string, string>
): BattleDesignIntent | null {
  // 13 键校验（判定自含，与 MODULE_QUESTIONS 内嵌副本同步）
  for (const { key, options } of BATTLE_QUESTION_DEFS) {
    const value = answers[key];
    if (typeof value !== "string" || !options.includes(value)) {
      return null;
    }
  }

  const combatType = COMBAT_TYPE_FROM_PACE[answers.battlePace];
  const typeTier = COMBAT_TYPE_TIERS[combatType];
  const pacingTier = COMBAT_PACING_TIERS[answers.combatPacing];
  const skillTier = SKILL_ACQUISITION_TIERS[answers.skillAcquisition];
  const damageTier = DAMAGE_FORMULA_TIERS[answers.damageFormulaType];
  const structuralDecisions = structuralDecisionsFromAnswers(answers);
  const attributeDesign = ATTRIBUTE_DESIGNS[structuralDecisions.attributeScheme];
  const decisionTier = ATTRIBUTE_DECISION_TIERS[structuralDecisions.attributeScheme];
  const { level_1, level_max, attributeBudgets } = buildAnchors(
    pacingTier,
    structuralDecisions.attributeScheme
  );

  return {
    moduleType: "battle",
    decisions: {
      attributeStyle: decisionTier.style,
      attributeCount: [...attributeDesign.primary, ...attributeDesign.secondary].length,
      skillTypeCombo: skillTier.skillTypeCombo,
      rationale: `${typeTier.rationaleNote}；${damageTier.rationaleNote}；${pacingTier.rationaleNote}；技能获取：${skillTier.rationaleNote}；${decisionTier.label}。`,
    },
    structuralDecisions,
    strategy: {
      combatType: combatType as BattleDesignIntent["strategy"]["combatType"],
      combatPacing: answers.combatPacing as BattleDesignIntent["strategy"]["combatPacing"],
      attributeDesign,
      damageFormula: { ...damageTier.damageFormula },
      skillFramework: {
        skillTypes: typeTier.skillTypes,
        maxSkillsPerCharacter: typeTier.maxSkillsPerCharacter,
        cooldownRange: typeTier.cooldownRange,
        skillDetails: skillTier.skillDetails.map((s) => ({ ...s })),
      },
      expectedCombatDuration: [...pacingTier.duration] as [number, number],
    },
    anchors: {
      level_1,
      level_max,
      maxLevel: MAX_LEVEL,
      attributeBudgets,
      combatDurationTarget: [...pacingTier.duration] as [number, number],
      hpAtkRatio: pacingTier.hpAtkRatio,
      enemyStrengthBaseline: ENEMY_STRENGTH_MULTIPLIERS[answers.enemyStrengthBaseline],
    },
    summary: `${typeTier.label}·${pacingTier.label}战斗规划：${skillTier.label}，${decisionTier.label}，标准一场 ${pacingTier.duration[0]}-${pacingTier.duration[1]} 秒。`,
  };
}

/**
 * FU2（Spec planning-module-refactor 修订 3）：battle 侧 AI 增强 structuralDecisions
 * 确定性覆写。仅 battle 模块且问卷 9 结构键齐备、值均 ∈ 预设 options 时，用问卷答案
 * 覆写 intent.structuralDecisions（LLM 翻转结构开关以问卷为准，与 game-framework 侧
 * FU2 强度对称）。questionnaireAnswers 来自 HTTP body 用户可控输入（模板路径有
 * buildBattleIntent 前置校验，AI 增强路径无），故值域校验在此收紧；缺键、非法值
 * 或非该模块时保守跳过，返回原 intent（现状行为）。供 planning 路由 T3 接线消费。
 */
/** 非结构决策键（结构覆写职责边界：combat 2 键 + W2 深档 2 键） */
const NON_STRUCTURAL_KEYS = new Set([
  "combatPacing",
  "skillAcquisition",
  "damageFormulaType",
  "enemyStrengthBaseline",
]);

export function applyBattleStructuralDecisions<T extends { moduleType: string }>(
  intent: T,
  questionnaireAnswers?: Record<string, string>
): T {
  const structuralDefs = BATTLE_QUESTION_DEFS.filter(
    (def) => !NON_STRUCTURAL_KEYS.has(def.key)
  );
  if (
    intent.moduleType !== "battle" ||
    !questionnaireAnswers ||
    !structuralDefs.every(({ key, options }) => {
      const value = questionnaireAnswers[key];
      return typeof value === "string" && options.includes(value);
    })
  ) {
    return intent;
  }
  return {
    ...intent,
    structuralDecisions: structuralDecisionsFromAnswers(questionnaireAnswers),
  } as T;
}

/**
 * questionnaire-ia W2：battle 深档 2 键 LLM 路径确定性覆写（AI 增强场景）。
 * 仅 battle 模块且对应键值 ∈ 深档值域时逐键覆写：
 * - damageFormulaType → strategy.damageFormula.type（仅 type 覆写——calcDamage 兜底链
 *   按 type 分支取系数，LLM 自身的 coefficients/baseFormula 文本保留不动，避免与
 *   LLM 语义失配；模板直算路径的三件套同源配套由 buildBattleIntent 承载）；
 * - enemyStrengthBaseline → anchors.enemyStrengthBaseline 数值乘数（0.75/1.0/1.2）。
 * 两键相互独立、与 applyBattleStructuralDecisions 的结构键互不触碰；缺键、值 ∉ 值域
 * （伪造 HTTP body）或非 battle 模块时单键保守跳过，两键均无合法值时返回原 intent。
 * 纯函数：不变异入参。供 planning 路由 applyQuestionnaireOverrides 分派消费。
 */
export function applyBattleDeepTierOverrides<T extends { moduleType: string }>(
  intent: T,
  questionnaireAnswers?: Record<string, string>
): T {
  if (intent.moduleType !== "battle" || !questionnaireAnswers) {
    return intent;
  }

  const formulaType = questionnaireAnswers["damageFormulaType"];
  const baseline = questionnaireAnswers["enemyStrengthBaseline"];
  const formulaLegal =
    typeof formulaType === "string" && formulaType in DAMAGE_FORMULA_TIERS;
  const baselineLegal =
    typeof baseline === "string" && baseline in ENEMY_STRENGTH_MULTIPLIERS;
  if (!formulaLegal && !baselineLegal) {
    return intent;
  }

  const battleIntent = intent as T & {
    strategy: BattleDesignIntent["strategy"];
    anchors: BattleDesignIntent["anchors"];
  };
  return {
    ...intent,
    strategy: formulaLegal
      ? {
          ...battleIntent.strategy,
          damageFormula: {
            ...battleIntent.strategy.damageFormula,
            type: formulaType as BattleDesignIntent["strategy"]["damageFormula"]["type"],
          },
        }
      : battleIntent.strategy,
    anchors: baselineLegal
      ? {
          ...battleIntent.anchors,
          enemyStrengthBaseline: ENEMY_STRENGTH_MULTIPLIERS[baseline],
        }
      : battleIntent.anchors,
  } as T;
}
