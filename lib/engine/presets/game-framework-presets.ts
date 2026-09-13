import type { GameFrameworkDesignIntent } from "../formula-engine/types";
import type { GameFrameworkDecisions } from "@/lib/types/planning";
import type { GameType } from "@/lib/types/project";
import { buildGameProfile, buildCoreLoop, GENRE_LABEL } from "../formula-engine/game-framework";

/**
 * game-framework 预设（Spec planning-module-refactor §4 R1 / §5 S1；
 * gf-questionnaire-optimization T4a：contentPace 下沉 monetization 问卷；
 * module-questionnaire-flow T5：问卷分工重组——判定键 11→5，6 体验键下放模块问卷）。
 *
 * 问卷答案 → GameFrameworkDesignIntent（0 LLM 直算；W1-A 起基础定位
 * 四键 optional 透传，不参与命中判定）。
 * 判定逻辑自含：枚举键的合法值域内嵌于本文件（与
 * GameFrameworkDecisions 冻结契约一致），不依赖 questions.ts；
 * 更新 presets/questions.ts 时以本表为源同步。
 *
 * T5 问卷分工重组（Spec Requirement D「键单点归属」）：
 * - 判定键 5 核心键（gameGenre/corePillar/targetPlayer/expectedMaxLevelDays/
 *   monetizationModel）——UI 侧 gf 问卷 15→9 题中的 5 preset 键；
 * - 6 下放键（economyGoal/spendingFocus/resourceAcquisition/progressionPace/
 *   progressionFeedback/progressionBreadth）不再向用户采集，decisions 输出
 *   **保持 11 键全量形态**（Correctness F2 裁决：类型/Zod/引擎派生函数零改动，
 *   下游消费零波及）——6 键由品类默认表按 gameGenre 填充；
 * - 存量超集兼容：answers 中残留的 6 下放键被忽略（多答不报错不采信）。
 *
 * 域纯度：不 import UI/组件、不 import zod、不 import lib/ai；
 * strategy 派生文案与引擎共用同一套映射表（formula-engine/game-framework.ts）。
 */

export type GameFrameworkAnswers = Record<string, string | number>;

/** 5 核心判定键（T5 缩圈；expectedMaxLevelDays 为数值题——正数接受 number 或数字串） */
export const GAME_FRAMEWORK_QUESTION_KEYS = [
  "gameGenre",
  "corePillar",
  "targetPlayer",
  "expectedMaxLevelDays",
  "monetizationModel",
] as const;

/** T5 下放的 6 体验键键序（归属 economy/progression 模块问卷，仅供品类默认表与合并覆写内部消费） */
const DELEGATED_DECISION_KEYS = [
  "economyGoal",
  "spendingFocus",
  "resourceAcquisition",
  "progressionPace",
  "progressionFeedback",
  "progressionBreadth",
] as const;

type DelegatedDecisionKey = (typeof DELEGATED_DECISION_KEYS)[number];

/** 6 下放键的合法值域（与 GameFrameworkDecisions 联合字面量一致；
 * applyGameFrameworkDecisions 合并时校验 intent 侧残留值是否可保留） */
const DELEGATED_ANSWER_OPTIONS: {
  readonly [K in DelegatedDecisionKey]: readonly GameFrameworkDecisions[K][];
} = {
  economyGoal: ["generous", "balanced", "sink_heavy"],
  spendingFocus: ["progression", "gacha", "social", "pvp"],
  resourceAcquisition: ["steady", "burst", "quest_driven"],
  progressionPace: ["fast_then_slow", "steady", "milestone"],
  progressionFeedback: ["immediate", "milestone", "gradual"],
  progressionBreadth: ["deep_few", "broad_many", "mixed"],
};

/**
 * 6 下放键的品类默认表：gameGenre → 各键默认值（T5，Spec D 配套机制
 * 「下放 6 键按品类默认表填充 framework 字段（六品类静态映射先例）」）。
 *
 * 依据 formula-engine/game-framework.ts 的 GENRE_STYLE_CARDS 六品类静态映射
 * 的品类语义（系统蓝图建议改由品类默认驱动，接受建议精度略降）：
 * - rpg：养成深度与战力验证主轴、免费可推进付费提速 → 产出消耗平衡
 *   （balanced）、养成加速付费（progression）、日常稳定产出（steady）、
 *   前期高速后期放缓（fast_then_slow）、品质/突破节点质变（milestone）、
 *   3-6 线少线做深（deep_few）；
 * - slg：时间锁控节奏、付费买时间、多线并进数值面宽 → 重度消耗
 *   （sink_heavy）、匀速推进（steady）、细水长流（gradual）、广养成面（broad_many）；
 * - roguelike：局内随机成长+局外解锁、强调局内即时反馈 → 单局爆发获取
 *   （burst）、局外里程碑解锁（milestone）、即时反馈（immediate）、精简养成（deep_few）；
 * - moba：对局公平、英雄/皮肤销售、局内经济前快后慢 → 外观社交向消耗
 *   （social）、即时反馈（immediate）、英雄收集面广（broad_many）；
 * - card：卡池广度即数值深度、抽卡货币主导、突破按档位质变 → 重度抽卡
 *   消耗（sink_heavy）、抽卡付费（gacha）、里程碑质变（milestone）、广收集（broad_many）；
 * - casual：轻数值、广告激励联动、短平快关卡流控制流失 → 宽松经济
 *   （generous）、看广告爆发获取（burst）、即时爽感（immediate）、养成面窄（deep_few）。
 */
export const GAME_FRAMEWORK_GENRE_DEFAULTS: Record<GameType, Pick<GameFrameworkDecisions, DelegatedDecisionKey>> = {
  rpg: {
    economyGoal: "balanced",
    spendingFocus: "progression",
    resourceAcquisition: "steady",
    progressionPace: "fast_then_slow",
    progressionFeedback: "milestone",
    progressionBreadth: "deep_few",
  },
  slg: {
    economyGoal: "sink_heavy",
    spendingFocus: "progression",
    resourceAcquisition: "steady",
    progressionPace: "steady",
    progressionFeedback: "gradual",
    progressionBreadth: "broad_many",
  },
  roguelike: {
    economyGoal: "balanced",
    spendingFocus: "progression",
    resourceAcquisition: "burst",
    progressionPace: "milestone",
    progressionFeedback: "immediate",
    progressionBreadth: "deep_few",
  },
  moba: {
    economyGoal: "balanced",
    spendingFocus: "social",
    resourceAcquisition: "steady",
    progressionPace: "fast_then_slow",
    progressionFeedback: "immediate",
    progressionBreadth: "broad_many",
  },
  card: {
    economyGoal: "sink_heavy",
    spendingFocus: "gacha",
    resourceAcquisition: "steady",
    progressionPace: "milestone",
    progressionFeedback: "milestone",
    progressionBreadth: "broad_many",
  },
  casual: {
    economyGoal: "generous",
    spendingFocus: "progression",
    resourceAcquisition: "burst",
    progressionPace: "fast_then_slow",
    progressionFeedback: "immediate",
    progressionBreadth: "deep_few",
  },
};

/** 5 核心判定键中枚举键的合法答案值域（自含判定；expectedMaxLevelDays 为正数，另行校验；
 * market/platform 为 W1-A 基础定位可选透传键的值域——不进判定键集，仅透传时校验；
 * 6 下放键值域见 DELEGATED_ANSWER_OPTIONS，T5 起不再向用户采集） */
export const GAME_FRAMEWORK_ANSWER_OPTIONS = {
  gameGenre: ["rpg", "slg", "roguelike", "moba", "card", "casual"],
  corePillar: ["数值成长", "策略对抗", "操作技巧", "收集养成"],
  targetPlayer: ["碎片化学生党", "通勤上班族", "核心深度玩家", "泛休闲用户"],
  monetizationModel: ["买断制", "内购中度", "内购重度", "广告混合"],
  market: ["china", "sea", "west", "mena", "jpkr", "global"],
  platform: ["mobile", "steam", "wechat", "douyin", "tiktok", "other"],
} as const;

/**
 * 问卷答案 → decisions（5 核心键 + 6 下放键品类默认填充 + 基础定位四键 optional 透传）。
 * 5 核心判定键全部存在且 ∈ 合法值才返回 decisions，否则 null
 * （缺键 / 非法值 = 自由文本，回退 LLM 路径；expectedMaxLevelDays
 * 接受 number 或数字串，须为正数——问卷 value 为 "30"/"90"/"180"/"365"
 * 或自定义天数）。6 下放键不再向用户采集：一律由品类默认表按 gameGenre
 * 填充（answers 中残留的下放键被忽略——存量超集兼容）。供模板直算与
 * FU2 覆写共用。
 *
 * W1-A 基础定位四键（market/platform 枚举、benchmarkProduct/
 * differentiation 自由文本）全 optional：齐备且合法时透传进 decisions，
 * 缺失/空串不出键（存量数据不迁移不报错）；market/platform 值 ∉
 * 值域时单键跳过（不透传坏数据，也不拖垮核心键命中的模板直算）。
 * 四键不进 GAME_FRAMEWORK_QUESTION_KEYS——模板命中不要求新键（Spec 边界条件）。
 */
export function decisionsFromAnswers(
  answers: GameFrameworkAnswers
): GameFrameworkDecisions | null {
  for (const key of GAME_FRAMEWORK_QUESTION_KEYS) {
    const options = GAME_FRAMEWORK_ANSWER_OPTIONS[key as keyof typeof GAME_FRAMEWORK_ANSWER_OPTIONS];
    if (options) {
      const value = answers[key];
      if (typeof value !== "string" || !(options as readonly string[]).includes(value)) {
        return null;
      }
    }
  }
  const rawDays = answers.expectedMaxLevelDays;
  const days = typeof rawDays === "number" ? rawDays : Number(rawDays);
  if (!Number.isFinite(days) || days <= 0) return null;
  const genreDefaults = GAME_FRAMEWORK_GENRE_DEFAULTS[answers.gameGenre as GameType];
  const decisions: GameFrameworkDecisions = {
    gameGenre: answers.gameGenre as GameType,
    corePillar: answers.corePillar as GameFrameworkDecisions["corePillar"],
    targetPlayer: answers.targetPlayer as GameFrameworkDecisions["targetPlayer"],
    ...genreDefaults,
    expectedMaxLevelDays: days,
    monetizationModel: answers.monetizationModel as GameFrameworkDecisions["monetizationModel"],
  };
  // 基础定位四键 optional 透传（防御性仅复制 string 值，空串 = 未答不出键）
  const market = answers.market;
  if (
    typeof market === "string" &&
    market !== "" &&
    (GAME_FRAMEWORK_ANSWER_OPTIONS.market as readonly string[]).includes(market)
  ) {
    decisions.market = market as GameFrameworkDecisions["market"];
  }
  const platform = answers.platform;
  if (
    typeof platform === "string" &&
    platform !== "" &&
    (GAME_FRAMEWORK_ANSWER_OPTIONS.platform as readonly string[]).includes(platform)
  ) {
    decisions.platform = platform as GameFrameworkDecisions["platform"];
  }
  const benchmarkProduct = answers.benchmarkProduct;
  if (typeof benchmarkProduct === "string" && benchmarkProduct !== "") {
    decisions.benchmarkProduct = benchmarkProduct;
  }
  const differentiation = answers.differentiation;
  if (typeof differentiation === "string" && differentiation !== "") {
    decisions.differentiation = differentiation;
  }
  return decisions;
}

/**
 * 构建 game-framework 预设 intent（模板直算路径，0 LLM）。
 * strategy 派生文案与引擎输出共用同一套映射表（同一 decisions
 * 在 intent.strategy 与 computed.gameProfile/coreLoop 间语义一致）。
 * 返回 null 仅两种情况：任一 5 核心判定键缺失、或值 ∉ 合法值域
 * （= 自由文本）；6 下放键由品类默认表填充（不参与判定）。
 */
export function buildGameFrameworkIntent(
  answers: GameFrameworkAnswers
): GameFrameworkDesignIntent | null {
  const decisions = decisionsFromAnswers(answers);
  if (!decisions) return null;
  const profile = buildGameProfile(decisions);
  const loop = buildCoreLoop(decisions);
  return {
    moduleType: "game-framework",
    decisions,
    strategy: {
      positioningNotes: `${profile.positioning}。目标玩家：${profile.targetPlayerDesc}。`,
      loopNotes: loop.summary,
    },
    summary: `${GENRE_LABEL[decisions.gameGenre]}·${decisions.corePillar}框架：${loop.summary}`,
  };
}

/**
 * FU2（planning-module-refactor R1）+ T5 合并覆写语义：
 * AI 增强 decisions 确定性合并——5 核心键以问卷答案为准覆写
 * （LLM 篡改问卷决策时以此修复，问卷保真）；6 下放键优先保留
 * intent 已有合法值（LLM intent 经 Zod 校验携带 6 键时不动它——
 * 下放后问卷侧无采集位，品类默认只是兜底），intent 缺键/值非法时
 * 由品类默认补全。5 核心键缺键或非法值时保守跳过，返回原 intent
 * （与已移除的原战斗框架预设中的 applyQuestionnaireDecisions 同风格）。
 * 纯函数：不变异入参。
 */
export function applyGameFrameworkDecisions(
  intent: GameFrameworkDesignIntent,
  questionnaireAnswers?: GameFrameworkAnswers
): GameFrameworkDesignIntent {
  if (!questionnaireAnswers) return intent;
  const decisions = decisionsFromAnswers(questionnaireAnswers);
  if (!decisions) return intent;
  const merged: GameFrameworkDecisions = { ...decisions };
  // 联合键直写会落各键字面量联合的交集（两两不交 = never），经 Record 视图赋值；
  // intent.decisions 类型必填，可选链仅防御运行时畸形（旧数据缺 6 键）
  const mergedByDelegatedKey = merged as unknown as Record<DelegatedDecisionKey, string>;
  for (const key of DELEGATED_DECISION_KEYS) {
    const existing = intent.decisions?.[key];
    if (
      typeof existing === "string" &&
      (DELEGATED_ANSWER_OPTIONS[key] as readonly string[]).includes(existing)
    ) {
      mergedByDelegatedKey[key] = existing;
    }
  }
  return { ...intent, decisions: merged };
}
