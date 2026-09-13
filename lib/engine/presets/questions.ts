import type { PlanningModuleType } from "@/lib/types/project";

/** 单道模块题的预设定义：题目 key 与合法选项 value 列表 */
export interface PresetQuestionDef {
  key: string;
  options: string[];
}

/**
 * 模块问卷题内嵌副本（引擎域禁止 import UI 层，故复制到此）
 *
 * 来源：lib/planning/questionnaire-data.ts → MODULE_QUESTIONS
 * 同步约定：问卷侧模块题 key/options 变更时必须同步本文件与对应 *-presets.ts
 * 的参数档位表；Zod 契约侧校验由 lib/ai/__tests__/presets-contract.test.ts（T9）承担。
 *
 * 类型限定为 PlanningModuleType 的子集：预设覆盖
 * gacha/level/economy/battle/game-framework，其余模块在 resolveTemplateIntent
 * 中直接返回 null（回退 LLM 路径）。
 */
export const MODULE_PRESET_QUESTIONS: Record<
  Extract<PlanningModuleType, "gacha" | "level" | "economy" | "battle" | "game-framework">,
  PresetQuestionDef[]
> = {
  gacha: [
    { key: "gachaStyle", options: ["character_focus", "weapon_focus", "mixed"] },
    { key: "pityIntensity", options: ["strict", "soft", "loose"] },
    { key: "rateOpenness", options: ["transparent", "partial", "opaque"] },
  ],
  level: [
    { key: "difficultyCurve", options: ["gradual", "spike", "boss_gate"] },
    { key: "progressionGate", options: ["clear_only", "power_gate", "time_gate"] },
    { key: "levelVariety", options: ["template", "themed", "unique"] },
    // ---- 深档 1 键（questionnaire-reverse-arch D6 值域等价重映射；主线与满级时点关系：
    // before_max/sync/after_max → 引擎枚举 small/medium/large + totalLevels 50/150/400
    // 基准值，关卡类型 counts 等比缩放；值域与 questionnaire-data.ts level 深档题逐字一致） ----
    { key: "mainlinePacing", options: ["before_max", "sync", "after_max"] },
  ],
  economy: [
    { key: "economyGoal", options: ["generous", "balanced", "sink_heavy"] },
    { key: "spendingFocus", options: ["progression", "gacha", "social", "pvp"] },
    { key: "resourceAcquisition", options: ["steady", "burst", "quest_driven"] },
    // ---- 深档 1 键（questionnaire-ia W2；次数 → 日产出深度乘数注入 anchors.dailyBudget
    // 区间；值域与 questionnaire-data.ts economy 深档题逐字一致） ----
    { key: "dailyPlaySessions", options: ["3", "6", "10"] },
  ],
  battle: [
    // ---- 结构决策 9 键（原框架层问卷下沉，值域与 battle-presets.ts 内嵌值域一致） ----
    { key: "formationSize", options: ["1", "3", "5", "6"] },
    { key: "battlePace", options: ["realtime", "semi-realtime", "turn-based", "idle-auto"] },
    { key: "heroStarEnabled", options: ["no", "yes"] },
    { key: "equipmentEnabled", options: ["no", "yes"] },
    { key: "equipmentCategories", options: ["2", "4", "6"] },
    { key: "petEnabled", options: ["no", "yes"] },
    { key: "skillDepth", options: ["none", "upgrade", "upgrade-star"] },
    { key: "attributeScheme", options: ["classic-4", "extended-6", "special-flow"] },
    { key: "specialAttrFocus", options: ["equipment", "skill", "pet", "none"] },
    // ---- 战斗体验 2 键（原 battle 问卷；combatType 问卷键已删（T5），strategy.combatType 由 battlePace 派生） ----
    { key: "combatPacing", options: ["fast", "standard", "slow"] },
    { key: "skillAcquisition", options: ["fixed_tree", "free_combine", "random"] },
    // ---- 深档 2 键（questionnaire-ia W2；damageFormulaType 显式决定 strategy.damageFormula
    // 三件套（不再随 battlePace 派生），enemyStrengthBaseline 三档 → 数值乘数存锚点；
    // 值域与 questionnaire-data.ts battle 深档题逐字一致） ----
    { key: "damageFormulaType", options: ["reduction", "multiplicative", "hybrid"] },
    { key: "enemyStrengthBaseline", options: ["lenient", "standard", "oppressive"] },
  ],
  // game-framework 5 核心判定键（module-questionnaire-flow T5 问卷分工重组缩圈：
  // 6 体验键（economyGoal/spendingFocus/resourceAcquisition/progressionPace/
  // progressionFeedback/progressionBreadth）下放 economy/progression 模块问卷——
  // UI gf 问卷 15→9 题，preset 判定与 UI 9 题中的 5 preset 键对齐，否则永不命中；
  // 值域与 game-framework-presets.ts 的 GAME_FRAMEWORK_ANSWER_OPTIONS 一致；
  // 6 键缺失时构建器内部按 gameGenre 品类默认补全后正常产出）
  "game-framework": [
    { key: "gameGenre", options: ["rpg", "slg", "roguelike", "moba", "card", "casual"] },
    { key: "corePillar", options: ["数值成长", "策略对抗", "操作技巧", "收集养成"] },
    { key: "targetPlayer", options: ["碎片化学生党", "通勤上班族", "核心深度玩家", "泛休闲用户"] },
    { key: "expectedMaxLevelDays", options: ["30", "90", "180", "365"] },
    { key: "monetizationModel", options: ["买断制", "内购中度", "内购重度", "广告混合"] },
  ],
};
