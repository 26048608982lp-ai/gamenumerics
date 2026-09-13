import type { AnyDesignIntent } from "../types";

export const BATTLE_INTENT: Extract<AnyDesignIntent, { moduleType: "battle" }> = {
  moduleType: "battle",
  decisions: {
    attributeStyle: "standard",
    attributeCount: 6,
    skillTypeCombo: "standard",
    rationale: "Standard RPG battle system",
  },
  strategy: {
    combatType: "realtime",
    attributeDesign: {
      primary: ["ATK", "HP", "DEF", "SPD"],
      secondary: ["CRIT", "CRITDMG"],
      growthModels: { ATK: "exponential", HP: "linear", DEF: "linear", SPD: "linear" },
    },
    damageFormula: {
      type: "multiplicative",
      baseFormula: "ATK * atkCoeff * (1 - DEF / (DEF + defScale))",
      coefficients: { atkCoeff: 0.5, defScale: 100 },
    },
    skillFramework: {
      skillTypes: ["attack", "heal", "buff"],
      maxSkillsPerCharacter: 4,
      cooldownRange: [2, 8],
    },
    combatPacing: "fast",
    expectedCombatDuration: [30, 60],
  },
  anchors: {
    level_1: { ATK: 100, HP: 500, DEF: 30, SPD: 50 },
    level_max: { ATK: 5000, HP: 50000, DEF: 500, SPD: 200 },
    maxLevel: 50,
    attributeBudgets: { ATK: 5000, HP: 50000, DEF: 500, SPD: 200 },
  },
};

export const ECONOMY_INTENT: Extract<AnyDesignIntent, { moduleType: "economy" }> = {
  moduleType: "economy",
  decisions: {
    resourceComplexity: "moderate",
    resourceCount: 4,
    rationale: "Moderate resource complexity for balanced economy",
  },
  strategy: {
    resourceTypes: [
      { id: "gold", name: "金币", isPremium: false, sinks: ["upgrade"], sources: ["daily"] },
      { id: "gem", name: "钻石", isPremium: true, sinks: ["gacha"], sources: ["daily", "purchase"] },
    ],
    itemTypes: [
      { id: "sword", name: "铁剑", rarity: "common", primarySource: "craft" },
    ],
  },
  consumptionSplit: {
    progression: 0.4,
    gacha: 0.3,
    social: 0.2,
    other: 0.1,
  },
  anchors: {
    dailyBudget: { gold: [100, 500], gem: [5, 20] },
    productionConsumptionRatio: { gold: 1.2, gem: 1.0 },
  },
};

export const PROGRESSION_INTENT: Extract<AnyDesignIntent, { moduleType: "progression" }> = {
  moduleType: "progression",
  decisions: {
    progressionDepth: "moderate",
    moduleCount: 2,
    coreProgressionAxis: "level",
    rationale: "Two-axis progression with level and equipment",
  },
  strategy: {
    modules: [
      {
        id: "level",
        name: "等级系统",
        focus: "基础属性成长",
        curveType: "exponential",
        maxLevel: 50,
        contributionToAttributes: { ATK: 0.4, HP: 0.3 },
        level_1_cost: { gold: 100 },
        maxLevel_cost: { gold: 50000 },
      },
      {
        id: "equip",
        name: "装备强化",
        focus: "装备属性提升",
        curveType: "linear",
        maxLevel: 20,
        contributionToAttributes: { ATK: 0.3, DEF: 0.5 },
        level_1_cost: { gold: 200 },
        maxLevel_cost: { gold: 30000 },
      },
    ],
  },
  anchors: { totalMaxLevel: 50 },
};

export const LEVEL_INTENT: Extract<AnyDesignIntent, { moduleType: "level" }> = {
  moduleType: "level",
  decisions: {
    levelScale: "large",
    totalLevels: 150,
    rationale: "Large scale with 150 levels across story and elite",
  },
  strategy: {
    levelTypes: [
      { id: "story", name: "主线关卡", count: 100, difficultyCurve: "linear", rewardResourceTypes: ["gold"] },
      { id: "elite", name: "精英关卡", count: 50, difficultyCurve: "exponential", rewardResourceTypes: ["gold", "gem"] },
    ],
    progressionPacing: { early: "1-2min", mid: "3-5min", late: "5-10min" },
  },
  anchors: {
    firstLevelDifficulty: { story: 0.1, elite: 0.3 },
    lastLevelDifficulty: { story: 0.8, elite: 1.0 },
  },
};

export const MONETIZATION_INTENT: Extract<AnyDesignIntent, { moduleType: "monetization" }> = {
  moduleType: "monetization",
  decisions: {
    monetizationModel: "mixed",
    primaryModel: "gacha",
    rationale: "Mixed monetization with gacha as primary revenue source",
  },
  strategy: {
    paidResources: [
      { resourceTypeId: "gem", exchangeRate: 10 },
    ],
    paymentProducts: [
      { id: "monthly", name: "月卡", category: "monthly", priceRMB: 30, contents: { gem: 3000 } },
      { id: "gacha10", name: "十连抽", category: "gacha", priceRMB: 16, contents: { gem: 160 } },
    ],
  },
  anchors: {
    powerGap: { freeVsWhale: 3.0, freeVsLight: 1.5 },
    paymentDepth: { minSpendForCompetitiveness: 50, maxEffectiveSpend: 500 },
    paymentRatios: { freeToPaidRatio: 0.7, lightSpenderShare: 0.2, whaleShare: 0.1 },
  },
};

/** 模拟 LLM 输出中嵌入 economy intent JSON 的文本 */
export const LLM_OUTPUT_ECONOMY = `基于您的需求，我为您设计了经济系统：

\`\`\`json
${JSON.stringify(ECONOMY_INTENT, null, 2)}
\`\`\`

以上设计包含了完整的资源类型和道具类型规划。`;

/** 模拟 LLM 输出中嵌入 battle intent JSON 的文本 */
export const LLM_OUTPUT_BATTLE = `以下是战斗系统的设计方案：

${JSON.stringify(BATTLE_INTENT, null, 2)}

战斗系统设计完成，请确认。`;

/** 模拟纯文本 LLM 输出（无 JSON） */
export const LLM_OUTPUT_PLAIN_TEXT = `基于您的需求，我建议经济系统采用以下设计：
1. 金币作为基础货币，用于装备强化和升级
2. 宝石作为高级货币，通过充值或稀有活动获取
3. 保持产出消耗比在1.2:1左右`;

/** 模拟不完整的 intent（缺少部分 anchors） */
export const LLM_OUTPUT_INCOMPLETE = JSON.stringify({
  moduleType: "economy",
  decisions: {
    resourceComplexity: "simple",
    resourceCount: 2,
    rationale: "simple",
  },
  strategy: {
    resourceTypes: [
      { id: "gold", name: "金币", isPremium: false, sinks: ["upgrade"], sources: ["daily"] },
    ],
    itemTypes: [],
  },
  consumptionSplit: { progression: 0.5, gacha: 0.3, social: 0.1, other: 0.1 },
  anchors: {
    dailyBudget: {},
    productionConsumptionRatio: {},
  },
});