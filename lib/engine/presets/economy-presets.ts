import type { EconomyDesignIntent } from "../formula-engine/types";

// ==================== 参数档位定义 ====================
// 三题档位正交组合，全部合法组合均命中。
// 数值锚点对标选项 desc 中的成熟产品，且满足验收区间：
//   consumptionSplit 各项总和 = 1.0（schema 守卫）
//   产出消耗比 ∈ [0.9, 1.2]

/** economyGoal 档位：产出消耗比（统一作用于全部资源）+ 日预算规模 */
interface EconomyGoalTier {
  /** 产出消耗比（1.0 = 完全平衡；>1 产出盈余，<1 资源趋紧） */
  ratio: number;
  /** 基础资源日产出范围的缩放系数 */
  budgetScale: number;
  complexity: "simple" | "moderate" | "complex";
  label: string;
}

const GOAL_TIERS: Record<string, EconomyGoalTier> = {
  // 原神/明日方舟式：资源获取轻松
  generous: { ratio: 1.15, budgetScale: 1.25, complexity: "simple", label: "宽松充裕" },
  // 崩铁/率土之滨式：日常够用但关键节点需要规划
  balanced: { ratio: 1.0, budgetScale: 1.0, complexity: "moderate", label: "适度平衡" },
  // 暗黑/率土赛季式：持续资源压力推动决策
  sink_heavy: { ratio: 0.9, budgetScale: 0.8, complexity: "complex", label: "资源紧缺" },
};

/** spendingFocus 档位：消耗占比分配（总和恒为 1.0）+ 焦点资源 */
interface EconomyFocusTier {
  split: EconomyDesignIntent["consumptionSplit"];
  label: string;
  dominantLabel: string;
  extraResource: {
    id: string;
    name: string;
    dailyRange: [number, number];
    sinks: string[];
  };
  goldSinks: string[];
}

const FOCUS_TIERS: Record<string, EconomyFocusTier> = {
  // 明日方舟/阴阳师式：升级强化进阶消耗大部分资源
  progression: {
    split: { progression: 0.55, gacha: 0.2, social: 0.1, other: 0.15 },
    label: "角色养成为主",
    dominantLabel: "养成消耗占比最高",
    extraResource: {
      id: "exp_potion",
      name: "养成试剂",
      dailyRange: [30, 120],
      sinks: ["角色升级", "技能专精", "模组解锁"],
    },
    goldSinks: ["角色升级", "技能升级", "装备强化"],
  },
  // 原神/FGO 式：获取角色/装备是最大消耗
  gacha: {
    split: { progression: 0.2, gacha: 0.55, social: 0.1, other: 0.15 },
    label: "抽卡收集为主",
    dominantLabel: "抽卡消耗占比最高",
    extraResource: {
      id: "gacha_ticket",
      name: "抽卡券",
      dailyRange: [10, 60],
      sinks: ["限定池抽取", "常驻池抽取", "武器池抽取"],
    },
    goldSinks: ["商店兑换", "角色升级", "日常消耗"],
  },
  // 率土之滨/万国觉醒式：公会贡献与社交互动消耗资源
  social: {
    split: { progression: 0.25, gacha: 0.15, social: 0.45, other: 0.15 },
    label: "社交/公会为主",
    dominantLabel: "社交消耗占比最高",
    extraResource: {
      id: "guild_coin",
      name: "公会勋章",
      dailyRange: [20, 100],
      sinks: ["公会捐献", "公会商店", "联盟科技"],
    },
    goldSinks: ["公会捐献", "社交礼物", "角色升级"],
  },
  // 炉石/影之诗式：竞技场排位需要持续投入（计入 other 桶）
  pvp: {
    split: { progression: 0.3, gacha: 0.15, social: 0.1, other: 0.45 },
    label: "PVP 竞技为主",
    dominantLabel: "竞技消耗（other 桶）占比最高",
    extraResource: {
      id: "arena_coin",
      name: "竞技场币",
      dailyRange: [20, 90],
      sinks: ["赛季报名", "竞技商店", "排名挑战"],
    },
    goldSinks: ["竞技商店", "角色升级", "装备强化"],
  },
};

/** resourceAcquisition 档位：免费资源产出渠道（仅文案，不影响数值锚点） */
const ACQUISITION_TIERS: Record<string, { label: string; sources: string[] }> = {
  // 原神日常委托式
  steady: { label: "稳定产出", sources: ["日常任务", "挂机产出", "签到奖励"] },
  // 阴阳师御魂副本式
  burst: { label: "爆发式获取", sources: ["限时活动", "副本挑战", "周常结算"] },
  // 明日方舟剿灭作战式
  quest_driven: { label: "任务驱动", sources: ["主线任务", "成就系统", "活跃度奖励"] },
};

/** 基础资源（3 种）+ 焦点资源（1 种，由 spendingFocus 决定）= 4 类资源 */
interface BaseResourceDef {
  id: string;
  name: string;
  isPremium: boolean;
  dailyRange: [number, number];
  sinks: string[];
  /** 付费资源的产出渠道固定；免费资源渠道由 resourceAcquisition 档位决定 */
  premiumSources?: string[];
}

const BASE_RESOURCES: BaseResourceDef[] = [
  { id: "gold", name: "金币", isPremium: false, dailyRange: [600, 2400], sinks: [] },
  {
    id: "gem",
    name: "钻石",
    isPremium: true,
    dailyRange: [40, 160],
    sinks: ["抽卡兑换", "商店稀有道具", "体力补充"],
    premiumSources: ["成就奖励", "活动奖励", "付费兑换"],
  },
  { id: "stamina", name: "体力", isPremium: false, dailyRange: [90, 180], sinks: ["关卡挑战", "副本进入", "资源扫荡"] },
];

const ITEM_TYPES: EconomyDesignIntent["strategy"]["itemTypes"] = [
  { id: "equip_material", name: "装备材料", rarity: "common", primarySource: "关卡掉落" },
  { id: "skill_book", name: "技能书", rarity: "rare", primarySource: "任务奖励" },
  { id: "stamina_potion", name: "体力药剂", rarity: "epic", primarySource: "商店兑换" },
  { id: "skin_ticket", name: "外观券", rarity: "legendary", primarySource: "活动奖励" },
];

// ==================== questionnaire-ia W2 深档题：dailyPlaySessions ====================

/**
 * dailyPlaySessions（每日游玩次数预算）→ 日产出深度乘数：
 * 次数越多玩家日产出越深，dailyBudget 区间按乘数缩放（rogue-fighter 实证：
 * 预计每日刷关 6 次 → 以 6 次/日为基准 1.0，轻度 3 次 0.6 / 重度 10 次 1.5）。
 * 与 economyGoal.budgetScale 正交相乘；缺省（题未答/直接 3 参调用）乘数 1.0 =
 * 现版本行为（向后兼容）。
 */
const SESSION_DEPTH_MULTIPLIERS: Record<string, number> = {
  "3": 0.6,
  "6": 1.0,
  "10": 1.5,
};

// ==================== intent 构建（纯函数）===================

/**
 * 构建 economy 预设 intent。
 * 入参为按题目顺序的问卷值（economyGoal / spendingFocus / resourceAcquisition
 * + W2 深档题 dailyPlaySessions 可选），调用前已由 resolveTemplateIntent 校验值 ∈ 预设 options。
 * dailyPlaySessions 缺省时不做深度缩放（行为与 W2 之前版本完全一致）。
 */
export function buildEconomyIntent(
  economyGoal: string,
  spendingFocus: string,
  resourceAcquisition: string,
  dailyPlaySessions?: string,
): EconomyDesignIntent {
  const goal = GOAL_TIERS[economyGoal];
  const focus = FOCUS_TIERS[spendingFocus];
  const acquisition = ACQUISITION_TIERS[resourceAcquisition];
  const sessionMultiplier =
    (dailyPlaySessions !== undefined && SESSION_DEPTH_MULTIPLIERS[dailyPlaySessions]) || 1.0;

  const scale = (value: number) => Math.round(value * goal.budgetScale * sessionMultiplier);

  const resourceTypes: EconomyDesignIntent["strategy"]["resourceTypes"] = [
    ...BASE_RESOURCES.map((base) => ({
      id: base.id,
      name: base.name,
      isPremium: base.isPremium,
      // 金币的消耗方向跟随 spendingFocus（主导消耗桶），其余基础资源固定
      sinks: base.id === "gold" ? focus.goldSinks : base.sinks,
      sources: base.isPremium && base.premiumSources ? base.premiumSources : acquisition.sources,
    })),
    {
      id: focus.extraResource.id,
      name: focus.extraResource.name,
      isPremium: false,
      sinks: focus.extraResource.sinks,
      sources: acquisition.sources,
    },
  ];

  // 日预算锚点覆盖全部资源（goal.budgetScale 缩放）；产出消耗比统一取 goal 档位值
  const dailyBudget: EconomyDesignIntent["anchors"]["dailyBudget"] = {};
  const productionConsumptionRatio: EconomyDesignIntent["anchors"]["productionConsumptionRatio"] = {};
  for (const resource of resourceTypes) {
    const base = BASE_RESOURCES.find((b) => b.id === resource.id);
    const range = base ? base.dailyRange : focus.extraResource.dailyRange;
    dailyBudget[resource.id] = [scale(range[0]), scale(range[1])];
    productionConsumptionRatio[resource.id] = goal.ratio;
  }

  return {
    moduleType: "economy",
    decisions: {
      resourceComplexity: goal.complexity,
      resourceCount: resourceTypes.length,
      rationale: `${goal.label}的经济体验（产出消耗比 ${goal.ratio}），${focus.dominantLabel}；资源获取以${acquisition.label}为主。`,
    },
    strategy: {
      resourceTypes,
      itemTypes: ITEM_TYPES,
    },
    consumptionSplit: focus.split,
    anchors: { dailyBudget, productionConsumptionRatio },
    summary: `${resourceTypes.length} 类资源的${goal.label}经济体系，${focus.label}，资源获取${acquisition.label}。`,
  };
}

/**
 * questionnaire-ia W2：economy 深档键 LLM 路径确定性覆写（AI 增强场景）。
 * 仅 economy 模块且 dailyPlaySessions ∈ {"3","6","10"} 时，将 anchors.dailyBudget
 * 全资源区间按深度乘数缩放（与 buildEconomyIntent 的 SESSION_DEPTH_MULTIPLIERS 同源：
 * 轻度 0.6 / 标准 1.0 / 重度 1.5）。缺键、值 ∉ 值域（伪造 HTTP body）、非 economy 模块
 * 或 anchors 缺 dailyBudget 时保守跳过，返回原 intent。纯函数：不变异入参。
 * 供 planning 路由 applyQuestionnaireOverrides 分派消费。
 */
export function applyEconomyDeepTierOverrides<T extends { moduleType: string }>(
  intent: T,
  questionnaireAnswers?: Record<string, string>
): T {
  if (intent.moduleType !== "economy" || !questionnaireAnswers) {
    return intent;
  }
  const sessions = questionnaireAnswers["dailyPlaySessions"];
  if (typeof sessions !== "string" || !(sessions in SESSION_DEPTH_MULTIPLIERS)) {
    return intent;
  }
  const economyIntent = intent as T & { anchors: EconomyDesignIntent["anchors"] };
  const dailyBudget = economyIntent.anchors?.dailyBudget;
  if (!dailyBudget) {
    return intent;
  }
  const multiplier = SESSION_DEPTH_MULTIPLIERS[sessions];
  return {
    ...intent,
    anchors: {
      ...economyIntent.anchors,
      dailyBudget: Object.fromEntries(
        Object.entries(dailyBudget).map(([id, range]) => [
          id,
          [Math.round(range[0] * multiplier), Math.round(range[1] * multiplier)] as [number, number],
        ])
      ),
    },
  } as T;
}
