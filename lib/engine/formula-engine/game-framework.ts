import type { GameFrameworkDesignIntent } from "./types";
import type { ComputedGameFrameworkData, GenreStyleCard } from "@/lib/types/planning";
import type { GameType } from "@/lib/types/project";

/**
 * 游戏框架层确定性计算（Spec planning-module-refactor §4 R1）。
 *
 * 纯函数：按 decisions 三段 11 题决策确定性派生设定卡（gameProfile）、
 * 核心循环（coreLoop）、系统构成建议（systemBlueprint）、体验锚点
 * （experienceAnchors）、模块路线图（moduleRoadmap），相同输入产出相同
 * 结果（无 LLM、无随机、无外部依赖）。
 *
 * 映射策略：各维度独立映射 + 拼接（与已移除的原战斗框架引擎的单维
 * 规则表模式一致），禁止全组合文案表（5 genre × 4 pillar × … 会组合爆炸）。
 * 规则表与计算函数分离，全部文案为中文。
 */

type FrameworkDecisions = GameFrameworkDesignIntent["decisions"];

/** systemBlueprint 单条建议线的有序判定规则（首条命中生效，含依据注释） */
interface SuggestedLineRule {
  when: (d: FrameworkDecisions) => boolean;
  enabled: boolean;
  reason: string;
}

// ==================== 段一：游戏定位映射 ====================

/** gameGenre → 品类名（positioning 拼接维 1 / summary 前缀；导出供 presets 派生文案共用） */
export const GENRE_LABEL: Record<GameType, string> = {
  rpg: "RPG（角色扮演）",
  slg: "SLG（策略）",
  roguelike: "Roguelike（肉鸽）",
  moba: "MOBA（竞技对抗）",
  card: "卡牌策略",
  casual: "休闲游戏",
};

/** corePillar → 定位短语（positioning 拼接维 2） */
const PILLAR_POSITIONING: Record<FrameworkDecisions["corePillar"], string> = {
  数值成长: "数值成长驱动",
  策略对抗: "策略对抗驱动",
  操作技巧: "操作技巧驱动",
  收集养成: "收集养成驱动",
};

/** targetPlayer → 目标玩家描述（单维映射） */
const TARGET_PLAYER_DESC: Record<FrameworkDecisions["targetPlayer"], string> = {
  碎片化学生党: "时间碎片化、可支配预算有限但活跃度高的学生群体，偏好短单局、明确的每日目标与高性价比成长",
  通勤上班族: "利用通勤与晚间固定时段游戏的上班族，追求确定时间投入下的稳定成长回报，反感不可预期的强逼肝",
  核心深度玩家: "投入大量时间研究机制与最优解的深度玩家，追求养成深度、build 多样性与长线追求目标",
  泛休闲用户: "随开随玩的泛休闲人群，无固定游戏时段，决策门槛要求低，易被活动与轻社交召回",
};

/** corePillar → 体验目标（experienceGoals 贡献维 1，各 2 条） */
const PILLAR_EXPERIENCE_GOALS: Record<FrameworkDecisions["corePillar"], string[]> = {
  数值成长: [
    "每次游玩都能感受到明确的数值提升",
    "养成投入与战力产出保持可感知的正比关系",
  ],
  策略对抗: [
    "胜负主要取决于策略决策而非数值碾压",
    "多套可行阵容/策略并存，对抗环境不单一",
  ],
  操作技巧: [
    "操作水平差异能直接体现在战斗结果上",
    "技巧上限足够高，支撑长期练习与精进追求",
  ],
  收集养成: [
    "持续有新的收集目标维持期待感",
    "收集完成度带来可展示、可炫耀的成就感",
  ],
};

/** progressionFeedback → 体验目标（experienceGoals 贡献维 2，各 2 条；2+2=4 ∈ [2,4]） */
const FEEDBACK_EXPERIENCE_GOALS: Record<FrameworkDecisions["progressionFeedback"], string[]> = {
  immediate: [
    "每次强化/操作即时可见数值反馈",
    "短周期内即可完成一次正反馈循环",
  ],
  milestone: [
    "突破/觉醒等里程碑节点带来强烈质变体验",
    "长期积累的目标感在关键节点集中兑现",
  ],
  gradual: [
    "细水长流的积累感，适合低压力长线游玩",
    "离线/放置期间也在成长的安心感",
  ],
};

/** 设定卡：positioning 由 genre×pillar 两维短语拼接 */
export function buildGameProfile(d: FrameworkDecisions): ComputedGameFrameworkData["gameProfile"] {
  return {
    positioning: `一款${PILLAR_POSITIONING[d.corePillar]}的${GENRE_LABEL[d.gameGenre]}`,
    targetPlayerDesc: TARGET_PLAYER_DESC[d.targetPlayer],
    experienceGoals: [
      ...PILLAR_EXPERIENCE_GOALS[d.corePillar],
      ...FEEDBACK_EXPERIENCE_GOALS[d.progressionFeedback],
    ],
  };
}

// ==================== 段二：核心循环映射 ====================

/** progressionPace → 循环节奏短语（summary 拼接维 1） */
const PACE_LOOP: Record<FrameworkDecisions["progressionPace"], string> = {
  fast_then_slow: "前期高速成长、后期曲线放缓以拉长寿命",
  steady: "匀速稳定推进、无突兀卡点",
  milestone: "长期积累后在里程碑节点集中质变",
};

/** targetPlayer → 循环会话短语（summary 拼接维 2） */
const PLAYER_LOOP: Record<FrameworkDecisions["targetPlayer"], string> = {
  碎片化学生党: "碎片时间短会话多次进出",
  通勤上班族: "固定时段稳定会话节奏",
  核心深度玩家: "长会话沉浸式深度投入",
  泛休闲用户: "随开随玩的轻量会话",
};

/** resourceAcquisition → 「进入游戏」环节描述（单维映射） */
const PHASE_ONBOARD_DESC: Record<FrameworkDecisions["resourceAcquisition"], string> = {
  steady: "登录领取稳定日常产出，产出节奏可预期，形成每日固定启动习惯",
  burst: "日常轻量产出，资源在活动/挑战日集中爆发，登录节奏跟随活动日历",
  quest_driven: "以任务清单驱动启动，完成当日任务链解锁核心产出",
};

/** corePillar → 「核心玩法」环节描述（单维映射） */
const PHASE_CORE_DESC: Record<FrameworkDecisions["corePillar"], string> = {
  数值成长: "推进关卡与副本验证养成数值，以「变强」驱动持续挑战",
  策略对抗: "围绕阵容搭配与资源调度的策略博弈，胜负取决于决策质量",
  操作技巧: "实时操作与技能释放的技巧验证，以手感与反应获得即时乐趣",
  收集养成: "获取新角色/装备并纳入养成体系，以图鉴与收集度驱动探索",
};

/** progressionPace → 「成长强化」环节描述（单维映射） */
const PHASE_GROWTH_DESC: Record<FrameworkDecisions["progressionPace"], string> = {
  fast_then_slow: "前期快速升级建立成长感，后期投放阶梯式加深拉长追求",
  steady: "匀速消耗资源稳步强化，成长节奏均匀无强卡点",
  milestone: "日常积累资源，在突破/觉醒节点集中释放成长跃迁",
};

/** spendingFocus → 「付费或社交」环节描述（单维映射） */
const PHASE_PAY_DESC: Record<FrameworkDecisions["spendingFocus"], string> = {
  progression: "付费与社交围绕养成加速展开：付费买时间、社交换资源",
  gacha: "以抽卡获取新角色/装备为核心付费动机，社交围绕交换与炫耀展开",
  social: "公会协作与社交互动是主要情感锚点，付费围绕社交身份与贡献",
  pvp: "竞技排位驱动荣誉追求，付费与社交围绕变强与攀比展开",
};

/**
 * targetPlayer → 4 环节频次（单维映射）。
 * 列序固定 = [进入游戏, 核心玩法, 成长强化, 付费或社交]。
 */
const PHASE_FREQUENCIES: Record<FrameworkDecisions["targetPlayer"], [string, string, string, string]> = {
  碎片化学生党: [
    "每日 2-3 次（课间/午休碎片档）",
    "单次 5-10 分钟 × 每日 3-5 次",
    "每日 1-2 次（睡前集中强化）",
    "每周 1-2 次（周末活动集中）",
  ],
  通勤上班族: [
    "每日 2 次（通勤往返）",
    "单次 15-25 分钟 × 每日 1-2 次",
    "每日 1 次（晚间固定档）",
    "每周 2-3 次（周末集中参与）",
  ],
  核心深度玩家: [
    "每日 1-2 次（固定启动）",
    "单次 40-60 分钟 × 每日 1-2 次",
    "每日 1-2 次（持续优化配置）",
    "每周 3-5 次（公会活动/结算冲榜）",
  ],
  泛休闲用户: [
    "随开随玩、无固定节奏",
    "单次 3-8 分钟 × 每日 1-3 次",
    "每周 2-3 次（轻度收菜式强化）",
    "每月 1-2 次（活动激励触发）",
  ],
};

/** 核心循环：summary 由 pace×targetPlayer 两维短语拼接；4 环节固定、各维独立映射 */
export function buildCoreLoop(d: FrameworkDecisions): ComputedGameFrameworkData["coreLoop"] {
  const frequencies = PHASE_FREQUENCIES[d.targetPlayer];
  return {
    summary: `${PACE_LOOP[d.progressionPace]}，适配${PLAYER_LOOP[d.targetPlayer]}`,
    phases: [
      { name: "进入游戏", desc: PHASE_ONBOARD_DESC[d.resourceAcquisition], frequency: frequencies[0] },
      { name: "核心玩法", desc: PHASE_CORE_DESC[d.corePillar], frequency: frequencies[1] },
      { name: "成长强化", desc: PHASE_GROWTH_DESC[d.progressionPace], frequency: frequencies[2] },
      { name: "付费或社交", desc: PHASE_PAY_DESC[d.spendingFocus], frequency: frequencies[3] },
    ],
  };
}

// ==================== 系统构成建议（genre × pillar × breadth 单维规则组合）====================

/**
 * 装备线开启规则（首条命中生效）：
 * - 依据 1（品类约束优先）：休闲品类养成面窄，装备长线超出目标投入 → 关；
 * - 依据 2（支柱信号）：收集养成支柱下装备是核心收集对象 → 开；
 * - 依据 3（广度信号）：广养成面（broad_many）需要装备线作平行占位 → 开；
 * - 依据 4/5（品类基线）：RPG 装备承载大幅属性投放、Roguelike 依赖装备 build 多样性 → 开；
 * - 依据 6（品类基线）：卡牌装备承载御魂/铭文类配装属性投放 → 开；
 * - 依据 7（兜底）：SLG/MOBA 属性主挂英雄本体与全局体系 → 关。
 */
const EQUIPMENT_RULES: SuggestedLineRule[] = [
  { when: (d) => d.gameGenre === "casual", enabled: false, reason: "休闲品类养成面窄，装备线不做首期建议，优先英雄单线" },
  { when: (d) => d.corePillar === "收集养成", enabled: true, reason: "收集养成支柱：装备是核心收集对象，装备线承载图鉴目标" },
  { when: (d) => d.progressionBreadth === "broad_many", enabled: true, reason: "广养成面（broad_many）：装备线作为平行养成维度的标准占位" },
  { when: (d) => d.gameGenre === "rpg", enabled: true, reason: "RPG：数值成长传统上由装备线承载大幅属性投放" },
  { when: (d) => d.gameGenre === "roguelike", enabled: true, reason: "Roguelike：依赖装备 build 多样性支撑重复挑战乐趣" },
  { when: (d) => d.gameGenre === "card", enabled: true, reason: "卡牌：装备线承载御魂/铭文类配装属性投放" },
  { when: () => true, enabled: false, reason: "SLG/MOBA：属性主挂英雄本体与全局体系，装备不做局外独立成长线" },
];

/**
 * 技能线开启规则（首条命中生效）：
 * - 依据 1（品类信号最强）：MOBA 英雄技能组即核心玩法 → 开；
 * - 依据 2（品类约束）：休闲品类决策门槛低 → 关；
 * - 依据 3（支柱约束）：收集养成以获取新对象为主，技能深度弱化 → 关；
 * - 依据 4-6（支柱基线）：策略对抗/操作技巧/数值成长支柱下技能是核心投放线 → 开。
 */
const SKILL_RULES: SuggestedLineRule[] = [
  { when: (d) => d.gameGenre === "moba", enabled: true, reason: "MOBA：英雄技能组即核心玩法表达，技能线必开" },
  { when: (d) => d.gameGenre === "casual", enabled: false, reason: "休闲品类：决策门槛低，技能深度线不做首期建议" },
  { when: (d) => d.corePillar === "收集养成", enabled: false, reason: "收集养成支柱：以获取新对象为主，技能深度线弱化" },
  { when: (d) => d.corePillar === "策略对抗", enabled: true, reason: "策略对抗支柱：技能搭配与克制关系是策略表达的主载体" },
  { when: (d) => d.corePillar === "操作技巧", enabled: true, reason: "操作技巧支柱：技能释放与连招是操作表达的主载体" },
  { when: (d) => d.corePillar === "数值成长", enabled: true, reason: "数值成长支柱：技能升级提供稳定的英雄本体属性投放" },
  { when: () => true, enabled: true, reason: "技能线为英雄本体的标配成长维度" }, // 枚举覆盖完备，防御性兜底
];

/**
 * 宠物线开启规则（首条命中生效）：
 * - 依据 1（支柱信号）：收集养成支柱下宠物是最佳收集对象 → 开；
 * - 依据 2/3（品类基线）：休闲品类宠物收集高频轻量、RPG 需要第二收集轴 → 开；
 * - 依据 4-6（品类约束）：SLG 主数值在全局科技、Roguelike 保 build 纯度、
 *   MOBA 局内召唤物非局外养成 → 关；
 * - 依据 7（品类约束）：卡牌收集轴由卡牌本体与装备承担 → 关。
 */
const PET_RULES: SuggestedLineRule[] = [
  { when: (d) => d.corePillar === "收集养成", enabled: true, reason: "收集养成支柱：宠物是最佳收集对象之一，宠物线承载长线图鉴目标" },
  { when: (d) => d.gameGenre === "casual", enabled: true, reason: "休闲品类：宠物收集/养成是高频轻量玩法标配" },
  { when: (d) => d.gameGenre === "rpg", enabled: true, reason: "RPG：宠物伴生养成提供英雄线之外的第二收集轴" },
  { when: (d) => d.gameGenre === "slg", enabled: false, reason: "SLG：核心对抗在全局科技与武将，宠物线不参与主数值" },
  { when: (d) => d.gameGenre === "roguelike", enabled: false, reason: "Roguelike：保持局内 build 纯度，局外宠物线弱化" },
  { when: (d) => d.gameGenre === "card", enabled: false, reason: "卡牌：收集轴由卡牌本体与装备承担，宠物不做标配" },
  { when: () => true, enabled: false, reason: "MOBA：局内召唤物非局外养成线，宠物不做独立成长线" },
];

/**
 * 升星线开启规则（首条命中生效）：
 * - 依据 1（支柱信号）：数值成长支柱需要升星的长线倍率空间 → 开；
 * - 依据 2（品类信号）：SLG 武将星级是卡牌深度与付费锚点 → 开；
 * - 依据 3（广度信号）：少线做深（deep_few）用升星拉长英雄线 → 开；
 * - 依据 4（品类约束）：休闲浅养成 → 关；5/6：MOBA 局外弱成长、
 *   Roguelike 局外轻量 → 关；7（品类基线）：卡牌星级/觉醒是重复获取
 *   核心出口 → 开；8（rpg 基线）：抽卡与升星强耦合 → 开。
 */
const HERO_STAR_RULES: SuggestedLineRule[] = [
  { when: (d) => d.corePillar === "数值成长", enabled: true, reason: "数值成长支柱：升星为英雄本体提供长线倍率放大空间" },
  { when: (d) => d.gameGenre === "slg", enabled: true, reason: "SLG：武将星级是核心卡牌深度与长线付费锚点" },
  { when: (d) => d.progressionBreadth === "deep_few", enabled: true, reason: "少线做深（deep_few）：升星在不新增养成线前提下拉长英雄线深度" },
  { when: (d) => d.gameGenre === "casual", enabled: false, reason: "休闲品类：浅养成定位，升星长线超出目标用户投入" },
  { when: (d) => d.gameGenre === "moba", enabled: false, reason: "MOBA：局外成长弱化，英雄强度靠局内经济平衡调节" },
  { when: (d) => d.gameGenre === "roguelike", enabled: false, reason: "Roguelike：局外成长轻量，升星线弱化" },
  { when: (d) => d.gameGenre === "card", enabled: true, reason: "卡牌：星级/觉醒是重复获取的核心出口与长线深度锚点" },
  { when: () => true, enabled: true, reason: "RPG：抽卡经济与升星强耦合，星级是重复获取的主要出口" },
];

/** 首条命中规则的 enabled/reason 作为该线判定结果 */
function resolveLine(rules: SuggestedLineRule[], d: FrameworkDecisions): { enabled: boolean; reason: string } {
  for (const rule of rules) {
    if (rule.when(d)) return { enabled: rule.enabled, reason: rule.reason };
  }
  return { enabled: false, reason: "规则表未命中（防御性兜底，正常不可达）" };
}

type SuggestedLine = ComputedGameFrameworkData["systemBlueprint"]["suggestedLines"][number];

function buildSuggestedLines(d: FrameworkDecisions): SuggestedLine[] {
  return [
    // hero 恒 enabled：英雄本体是全部成长线的属性投放基准
    { key: "hero", name: "英雄本体", enabled: true, reason: "英雄本体是全部成长线的属性投放基准，恒定开启" },
    { key: "equipment", name: "装备", ...resolveLine(EQUIPMENT_RULES, d) },
    { key: "skill", name: "技能", ...resolveLine(SKILL_RULES, d) },
    { key: "pet", name: "宠物", ...resolveLine(PET_RULES, d) },
    { key: "heroStar", name: "英雄升星", ...resolveLine(HERO_STAR_RULES, d) },
  ];
}

// ==================== 体验锚点映射 ====================

/** targetPlayer → 日投入分钟区间（单维映射） */
const DAILY_PLAY_MINUTES: Record<FrameworkDecisions["targetPlayer"], [number, number]> = {
  碎片化学生党: [45, 90],
  通勤上班族: [30, 60],
  核心深度玩家: [90, 180],
  泛休闲用户: [15, 40],
};

/** monetizationModel → 月付费深度区间（单维映射，单位元） */
const MONTHLY_SPEND_DEPTH: Record<FrameworkDecisions["monetizationModel"], [number, number]> = {
  买断制: [0, 0],
  内购中度: [30, 150],
  内购重度: [300, 2000],
  广告混合: [0, 30],
};

function buildExperienceAnchors(d: FrameworkDecisions): ComputedGameFrameworkData["experienceAnchors"] {
  return {
    expectedMaxLevelDays: d.expectedMaxLevelDays, // 回显
    dailyPlayMinutes: [...DAILY_PLAY_MINUTES[d.targetPlayer]] as [number, number],
    monthlySpendDepth: [...MONTHLY_SPEND_DEPTH[d.monetizationModel]] as [number, number],
  };
}

// ==================== 模块路线图（gameGenre 单维映射）====================

type RoadmapModule = "battle" | "economy" | "progression" | "level" | "monetization" | "gacha";
type RoadmapEntry = ComputedGameFrameworkData["moduleRoadmap"][number];

/** 路线图固定输出顺序（与依赖链 battle → economy → progression → level → monetization/gacha 对齐） */
const ROADMAP_MODULE_ORDER: RoadmapModule[] = [
  "battle",
  "economy",
  "progression",
  "level",
  "monetization",
  "gacha",
];

/**
 * gameGenre → 6 模块 priority + note（单维规则表，6 品类 × 6 模块）。
 * 依据：各品类的核心矛盾决定模块优先级（如 slg 商业化/经济先行、
 * rpg 战斗/养成/抽卡三高、card 战斗/养成/商业化/抽卡四高、casual 经济
 * 与变现先行、moba 战斗与商业化先行、roguelike 战斗与关卡先行）。
 */
const ROADMAP_BY_GENRE: Record<GameType, Record<RoadmapModule, { priority: RoadmapEntry["priority"]; note: string }>> = {
  rpg: {
    battle: { priority: "high", note: "伤害公式与属性分层是 RPG 战斗验证的地基，最先定型" },
    economy: { priority: "medium", note: "资源产消节奏服务于养成消耗，随战斗锚点同步细化" },
    progression: { priority: "high", note: "等级/装备/技能多线曲线承载核心数值成长目标" },
    level: { priority: "medium", note: "关卡难度曲线用于验证战斗与养成数值的阶段性" },
    monetization: { priority: "medium", note: "付费深度由抽卡与养成加速共同承载" },
    gacha: { priority: "high", note: "角色获取是 RPG 付费与养成的双核心入口" },
  },
  slg: {
    battle: { priority: "medium", note: "战斗验证以兵种/阵容克制为主，公式深度可后置" },
    economy: { priority: "high", note: "资源产消与囤积博弈是 SLG 核心循环的心脏" },
    progression: { priority: "medium", note: "科技/建筑线曲线决定服务器节奏，随大版本定型" },
    level: { priority: "low", note: "关卡（PVE 推图）仅是引导载体，非核心矛盾" },
    monetization: { priority: "high", note: "SLG 付费深度大，礼包/战令体系需商业化先行设计" },
    gacha: { priority: "low", note: "武将获取走招募体系，非抽卡概率深度模块" },
  },
  roguelike: {
    battle: { priority: "high", note: "局内战斗手感与 build 数值是可玩性核心，最先打磨" },
    economy: { priority: "medium", note: "局内货币循环与局外兑换需平衡，随 build 定型" },
    progression: { priority: "medium", note: "局外 meta 养成线控制重复挑战的成长感" },
    level: { priority: "high", note: "关卡/词缀多样性决定重开乐趣，与战斗并行设计" },
    monetization: { priority: "low", note: "Roguelike 付费以买断/皮肤为主，数值商业化弱" },
    gacha: { priority: "low", note: "随机性在局内 build 而非抽卡池，gacha 模块低优先" },
  },
  moba: {
    battle: { priority: "high", note: "技能数值与平衡性是 MOBA 生命线，最先投入" },
    economy: { priority: "low", note: "无局外经济系统，economy 仅需覆盖局内资源" },
    progression: { priority: "low", note: "局外成长刻意弱化，progression 仅做轻量账号线" },
    level: { priority: "low", note: "地图/模式设计重于关卡数值曲线" },
    monetization: { priority: "high", note: "皮肤/英雄商业化是主要收入，商业化模块先行" },
    gacha: { priority: "low", note: "抽取主要作用于皮肤收集，概率深度低" },
  },
  card: {
    battle: { priority: "high", note: "阵容克制与属性对抗是卡牌策略的地基，最先定型" },
    economy: { priority: "medium", note: "资源产消服务养成与抽卡节奏，随战斗锚点细化" },
    progression: { priority: "high", note: "角色/卡牌养成多线曲线承载核心成长" },
    level: { priority: "medium", note: "推图关卡验证战斗数值阶段性，非核心矛盾" },
    monetization: { priority: "high", note: "卡牌付费深度大，抽卡与养成加速需商业化先行" },
    gacha: { priority: "high", note: "卡牌获取是付费与养成双核心入口" },
  },
  casual: {
    battle: { priority: "low", note: "轻量玩法战斗（若有）公式简单，后置处理" },
    economy: { priority: "high", note: "资源产出与广告激励节奏是休闲留存与变现核心" },
    progression: { priority: "medium", note: "轻养成线维持长期目标，随内容节奏展开" },
    level: { priority: "medium", note: "关卡难度曲线控制流失，随投放节奏迭代" },
    monetization: { priority: "high", note: "广告混合变现依赖激励位与内购组合设计，商业化先行" },
    gacha: { priority: "low", note: "休闲品类抽卡深度弱，不作为核心模块" },
  },
};

function buildModuleRoadmap(genre: GameType): RoadmapEntry[] {
  const byGenre = ROADMAP_BY_GENRE[genre];
  return ROADMAP_MODULE_ORDER.map((moduleType) => ({ moduleType, ...byGenre[moduleType] }));
}

// ==================== 品类风格卡（gameGenre 单维静态映射）====================

/**
 * gameGenre → 品类数值风格卡（Spec genre-style-card R1）。
 * 每字段 1-2 短句的品类数值语境，写给下游模块 prompt 消费；
 * 与 ROADMAP_BY_GENRE 语义互洽（progressionStyle/economyStyle 不与模块优先级矛盾）：
 * rpg 战斗验证+养成/抽卡深 ↔ battle+progression+gacha high；slg 经济/商业化先行 ↔ economy+monetization high；
 * roguelike 战斗/关卡先行 ↔ battle+level high；moba 数值面在对局平衡 ↔ 仅 battle+monetization high；
 * card 收集/商业化深 ↔ 四模块 high；casual 经济与变现先行 ↔ economy+monetization high。
 */
export const GENRE_STYLE_CARDS: Record<GameType, GenreStyleCard> = {
  rpg: {
    genre: "rpg",
    positioning: "角色成长驱动的长线数值品类，养成深度与战力验证是数值设计主轴。",
    attributeStyle: "6-10 项属性按生存/输出/功能三系分层，主属性与成长率双维投放。",
    progressionStyle: "3-6 条养成线并行，角色等级或装备为核心轴（战力贡献占比≥35%），深档位以品质/突破拉差。",
    levelSemantics: "章节化主线+精英/深渊副本分层验证，难度曲线典型为 S 形（sigmoid）。",
    economyStyle: "4-7 种资源构成金币+体力+付费货币三层循环，产消节奏服务养成消耗。",
    powerCurveStyle: "战力曲线呈指数或 S 形增长，满级战力预算需严控上限防止数值通胀。",
    monetizationNote: "抽卡与礼包主导付费，免费玩家可推进、付费提速不改变数值规则。",
  },
  slg: {
    genre: "slg",
    positioning: "多线程建设与军队规模驱动的重策略品类，数值面宽、节奏由时间锁控制。",
    attributeStyle: "城建/兵种/英雄三层属性体系，数值面宽、单点浅而组合深。",
    progressionStyle: "建筑+科技+英雄多线并进，时间锁（建造/研究时长）是主要节奏器。",
    levelSemantics: "战役章节+据点争夺承担 PVE 铺资源职能，关卡数值不是核心矛盾。",
    economyStyle: "产出/采集/掠夺/消耗四循环嵌套，护资源与损耗平衡是经济核心命题。",
    powerCurveStyle: "战力以线性堆量为主，兵种克制关系提供非线性修正。",
    monetizationNote: "加速+月卡+战令组合付费，本质是付费买时间，付费深度大。",
  },
  roguelike: {
    genre: "roguelike",
    positioning: "局内随机成长+局外永久解锁的双层数值结构，单局可玩性优先于长线养成。",
    attributeStyle: "属性精简至 4-6 项，强调局内即时数值反馈而非面板深度。",
    progressionStyle: "养成重心在局外天赋/解锁树，单局内成长不沉淀、局间重置。",
    levelSemantics: "层数/难度层的爬塔结构，每局从零开始爬升，词缀变化承载多样性。",
    economyStyle: "局内货币单局清零+局外 meta 货币双层，两层数值严禁互相穿透通胀。",
    powerCurveStyle: "局内战力短曲线陡峭（一局内从 1 放大到 100 量级），局间无沉淀。",
    monetizationNote: "买断或皮肤付费为主，数值商业化克制。",
  },
  moba: {
    genre: "moba",
    positioning: "对局公平竞技品类，数值面较轻——核心在英雄对局内平衡而非局外养成。",
    attributeStyle: "攻击/法强/防御/冷却四轴+装备合成树，数值设计服务于英雄平衡。",
    progressionStyle: "养成仅局内装备购买（单局清零），局外铭文/英雄收集轻度、不影响对局公平。",
    levelSemantics: "对局即「关卡」，难度由匹配机制（MMR）承担而非关卡曲线。",
    economyStyle: "局内金币/经验双轨经济，无局外资源循环。",
    powerCurveStyle: "战力曲线只存在于对局内（随装备/等级成长），局间无沉淀。",
    monetizationNote: "英雄/皮肤销售为主要收入，禁止数值付费破坏对局公平。",
  },
  card: {
    genre: "card",
    positioning: "收集深度与构筑策略驱动的品类，卡池广度即数值深度。",
    attributeStyle: "卡牌数值直接表达（费用/攻击/生命），无传统属性面板。",
    progressionStyle: "收集+突破+技能升级三层养成，收集完成度即养成深度。",
    levelSemantics: "副本塔/天梯段位为主要关卡形态，难度靠卡组强度检查点卡位。",
    economyStyle: "抽卡货币主导资源体系，尘/碎片循环回收重复卡牌。",
    powerCurveStyle: "战力以卡组强度离散档位呈现，由收集度驱动而非连续曲线。",
    monetizationNote: "抽卡+礼包组合付费，收集完成度即付费深度。",
  },
  casual: {
    genre: "casual",
    positioning: "轻数值品类，数值面较轻，单局爽感与社交传播优先于养成深度。",
    attributeStyle: "2-4 项极简属性或无显性属性面板，数值规则尽量对玩家隐藏。",
    progressionStyle: "养成以皮肤/装扮收集为主，无战力成长线。",
    levelSemantics: "短平快关卡流，难度曲线平缓以控制流失。",
    economyStyle: "体力+金币双资源极简经济，与广告激励变现联动。",
    powerCurveStyle: "战力弱或无，通关进度即成长表达。",
    monetizationNote: "广告混合+轻量内购，收入依赖激励位设计而非数值付费深度。",
  },
};

// ==================== 统一入口 ====================

/**
 * 从游戏框架 intent 计算完整设定卡（确定性，0 LLM）。
 * T3 由 computeFromIntent 按 moduleType === "game-framework" 路由到本函数。
 */
export function computeGameFrameworkFromIntent(
  intent: GameFrameworkDesignIntent
): ComputedGameFrameworkData {
  return {
    moduleType: "game-framework",
    decisions: { ...intent.decisions }, // 回显（浅拷贝，不变异入参；11 必答键 + 基础定位四键 optional 天然透传，W1-A）
    gameProfile: buildGameProfile(intent.decisions),
    coreLoop: buildCoreLoop(intent.decisions),
    systemBlueprint: { suggestedLines: buildSuggestedLines(intent.decisions) },
    experienceAnchors: buildExperienceAnchors(intent.decisions),
    moduleRoadmap: buildModuleRoadmap(intent.decisions.gameGenre),
    genreStyleCard: GENRE_STYLE_CARDS[intent.decisions.gameGenre], // 静态映射恒有（无缺省分支）
  };
}
